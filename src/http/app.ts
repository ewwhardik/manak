import { assessFinalists } from "../judging/index.ts";
import type { PairwiseEvidence } from "../judging/index.ts";
/**
 * The request pipeline: ten steps, in an order chosen once and written down.
 *
 * Every step here is a refusal waiting to happen, and the order decides which refusal a
 * caller gets when more than one applies. That is not a detail. It is the difference
 * between leaking an event's existence and not. The order, and why each step sits where
 * it does:
 *
 *  1. **Read the wire.** Body size, media type, UTF-8. Refused before anything is looked
 *     up, because a 300 KB body should not cost a session read.
 *  2. **Route.** No match is a 404; a match on the path but not the method is a 405 with
 *     a truthful `Allow`.
 *  3. **Authenticate.** One indexed read on the session hash. This is the only database
 *     work that happens before the limiter, and it is what lets the limiter be keyed on
 *     an account rather than only on an address.
 *  4. **Refuse a stranger early.** `decide` is asked with an empty role set and only its
 *     `unauthenticated` answer is honoured. Asking the real function rather than writing
 *     `if (capability.audience !== "public")` here is what keeps one implementation of
 *     the access rule; the other two answers it might give are ignored at this point,
 *     because the caller's roles are not known yet and a premature 404 would be a lie.
 *  5. **Parse.** Every problem at once, as a 422. Before the limiter, so a malformed
 *     ballot is not charged to the judge's bucket — parsing writes nothing and touches
 *     no table.
 *  6. **Resolve the scope.** The event the capability names, by id or by slug. A miss is
 *     a 404 — the same 404 step 8 produces for an event that exists and is not the
 *     caller's, which is the whole point of doing it in this order.
 *  7. **Meter.** The bucket the command declares, keyed on the canonical event id for
 *     scoped commands and on the account or client otherwise. Resolving first prevents
 *     an event's id and slug from becoming separate quota buckets.
 *  8. **Decide.** Now with real roles: 403 for a caller who is in the event with the
 *     wrong role, 404 for one who is not in it at all.
 *  9. **Gate.** The window or the switch the capability names, as a 409 that says how
 *     late the caller was.
 * 10. **Invoke, then render.** JSON under `/api`, a page without it, and a 303 after a
 *     form post so a reload cannot repeat the write.
 *
 * Two things this module deliberately does not do. It does not open a `recorded` scope
 * around a handler: repositories open their own, and a wrapper here would file a ledger
 * entry saying "a request happened" around the entries that say what actually did. And
 * it does not know what any command means — this file can be read start to finish
 * without learning what a ballot is.
 */

import type { Command, Delivery, Invocation, Parsed, RawInput, Registry } from "../api/index.ts";
import {
  ALLOW_KEY,
  decide,
  forbidden,
  InputError,
  notFound,
  parseInput,
  RegistryError,
  SESSION_COOKIE,
  unauthenticated,
} from "../api/index.ts";
import type {
  Clock,
  Ctx,
  CsvStage,
  Db,
  EventGates,
  EventRow,
  LedgerEntry,
  LimitName,
  Role,
  SessionRow,
} from "../db/index.ts";
import {
  assertGate,
  assertVotingClosed,
  clearCertificateLogo,
  publicCertificate,
  saveCertificateLogo,
  createSession,
  criteriaOf,
  CSV_STAGES,
  DatabaseError,
  enforce,
  exportCsv,
  findAccountByEmail,
  findEvent,
  findEventBySlug,
  gatesFor,
  certificateKeyDirectory,
  getOrCreateKeypair,
  grantRole,
  headHash,
  isId,
  makeContext,
  MS,
  normalizeEmail,
  publishedVersion,
  resolveSession,
  revokeSession,
  rolesIn,
  RuleError,
  sessionsOf,
  systemClock,
  touchSession,
  upsertAccount,
} from "../db/index.ts";
import type { View, ViewContext, Views, LiveProject, TieBreakerFinalist } from "../view/index.ts";
import {
  formPage,
  genericPage,
  guidePage,
  liveLeaderboardPage,
  prefillFromRaw,
  STYLESHEET,
  STYLESHEET_PATH,
  tieBreakerPage,
  verifyPage,
} from "../view/index.ts";
import { certificateSvg } from "../view/certificates.ts";
import { EMBED_JS, embedPage } from "../view/embed.ts";
import type { Extra, StreamEvent } from "./respond.ts";
import {
  clearedCookie,
  csvResponse,
  empty,
  eventStream,
  html,
  jsResponse,
  json,
  refusal,
  seeOther,
  sessionCookie,
  stylesheet,
  textResponse,
  SECURITY_HEADERS,
} from "./respond.ts";
import type { Target } from "./wire.ts";
import { credentialFrom, negotiate, parseCookies, readSubmission } from "./wire.ts";
import { bundledAsset, staticDocAsset } from "./assets.ts";
import { HttpMetrics } from "./metrics.ts";

/**
 * One line per request, for whoever is watching the container.
 *
 * The refusal's code is included and the caller's input is not. A log that echoes what
 * was submitted is a log that eventually contains a magic-link token, and this product
 * has no way to redact one after the fact.
 *
 * That sentence is why `path` is not simply the path. One route in this product carries a
 * credential in the URL itself — `GET /api/signin/:token` — and a log line is the one place
 * a single-use token outlives being used: it is written to stdout, shipped to whatever
 * collects it, and kept. So a path segment that matched a field declared `secret` is
 * written back as its parameter name. See `loggedPath`.
 */
export type LogRecord = {
  readonly at: number;
  readonly ms: number;
  readonly method: string;
  /** The path as the caller wrote it, with any secret segment replaced by its name. */
  readonly path: string;
  readonly wants: "json" | "html";
  readonly status: number;
  /** The command that answered, or null when nothing matched. */
  readonly command: string | null;
  readonly account: string | null;
  /** The refusal's code, or null when the request succeeded. */
  readonly code: string | null;
};

export type AppOptions = {
  readonly db: Db;
  readonly registry: Registry;
  /** Canonical public origin used in links sent outside the request. */
  readonly publicOrigin: string;
  /** Per-command page renderers, by command name. Missing means the generic page. */
  readonly views?: Views;
  readonly clock?: Clock;
  readonly log?: (record: LogRecord) => void;
  /** Anything that is not a declared refusal: a bug, with its stack, for the operator. */
  readonly report?: (error: unknown) => void;
  /**
   * Whether to believe `X-Forwarded-For` and `X-Forwarded-Proto`.
   *
   * False by default, and the default is the security decision: a rate limit keyed on a
   * header anybody can set is not a rate limit, it is a formality. An operator running
   * behind a proxy they control turns this on; a container exposed directly leaves it
   * alone and gets the socket's own address.
   */
  readonly trustProxy?: boolean;
  /** Force `Secure` on the session cookie. Otherwise derived from the request. */
  readonly secure?: boolean;
  readonly stylesheet?: string;
  readonly assetMaxAge?: number;
  /**
   * Where a sign-in link goes.
   *
   * Defaults to one line on stdout, and that default is a documented trade rather than an
   * oversight: anybody who can read the container's log can sign in as anybody who has
   * requested a link, which is stated in the threat model and fixed by supplying this. It
   * is the default because the alternative — refusing to start without a mail relay — makes
   * the first five minutes of evaluating this product a configuration exercise, and the
   * failure it prevents is one an operator running `docker logs` can see immediately.
   */
  readonly deliver?: (message: Delivery) => void;
  /**
   * The email addresses allowed to bring an event into existence.
   *
   * Empty by default, and an empty list means nobody can create an event over HTTP. That
   * is the safe default rather than the convenient one for a reason worth stating: anybody
   * can obtain an account on a deployment whose sign-in is a link to an arbitrary address,
   * so a portal that let any account create an event would let the first stranger who
   * found it fill somebody's server with hackathons. The operator names themselves here —
   * `MANAK_FOUNDERS` in the container — and the seed command creates the demo event
   * through the repository, so a fresh deployment is populated without this being set.
   *
   * Not stored, deliberately. A privilege that lives in a table is a row worth attacking
   * and a row worth auditing; a privilege that lives in the environment is revoked by
   * restarting with a different value.
   */
  readonly founders?: readonly string[];
  readonly publicKey?: string;
  readonly keyDir?: string;
  /** Explicit opt-in for disposable seeded demos. Never enable on a real event database. */
  readonly demoMode?: boolean;
};

/** The whole server as one function. No socket, so a test can call it directly. */
export type Serve = (request: Request, address?: string) => Promise<Response>;

/** What a GET spends from when it declares no bucket of its own. */
const READ_LIMIT: LimitName = "read";

/** Mutable notes the outer handler needs after an inner step has thrown. */
type Trace = {
  command: string | null;
  accountId: string | null;
  whoami: string | null;
  /** Cookies that must be set even on a refusal: a cleared session clears regardless. */
  cookies: readonly string[];
  code: string | null;
  /** What the log line may keep. Narrowed once a route is known — see `loggedPath`. */
  path: string;
};

const WIDGET_JS = `(function(){function e(v){return String(v==null?'':v).replace(/[&<>\"']/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[ch];});}function r(c){var s=c.getAttribute('data-event')||c.getAttribute('data-manak-event');if(!s)return;var b=c.getAttribute('data-api')||window.location.origin;try{var base=new URL(b,window.location.origin);if(!/^https?:$/.test(base.protocol))throw new Error('Invalid API origin');b=base.origin;}catch(err){c.textContent='Invalid gallery API origin';return;}var u=b+'/api/events/'+encodeURIComponent(s)+'/projects';fetch(u).then(function(res){if(!res.ok)throw new Error('Gallery request failed');return res.json();}).then(function(d){var p=d.projects||[];if(p.length===0){c.innerHTML='<div style="padding:1rem;color:#888;">No submitted projects found.</div>';return;}var h='<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1rem;font-family:system-ui,sans-serif;">';for(var i=0;i<p.length;i++){var x=p[i];h+='<div style="border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:1rem;background:rgba(255,255,255,0.03);"><h3 style="margin:0 0 0.5rem 0;font-size:1.1rem;"><a href="'+e(b)+'/events/'+encodeURIComponent(s)+'/projects/'+encodeURIComponent(x.id)+'" style="color:#60a5fa;text-decoration:none;">'+e(x.title)+'</a></h3><p style="margin:0 0 0.5rem 0;font-size:0.9rem;opacity:0.8;">'+e(x.summary)+'</p>'+(x.track?'<span style="display:inline-block;padding:2px 6px;font-size:0.75rem;border-radius:4px;background:#374151;color:#f3f4f6;">'+e(x.track)+'</span>':'')+'</div>';}h+='</div>';c.innerHTML=h;}).catch(function(err){c.innerHTML='<div style="color:#ef4444;font-size:0.85rem;">Failed to load projects: '+e(err.message)+'</div>';});}function init(){var ns=document.querySelectorAll('[data-manak-event],[data-manak-gallery]');for(var i=0;i<ns.length;i++)r(ns[i]);}if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',init);}else{init();}})();`;

export function makeApp(options: AppOptions): Serve {
  const { db, registry } = options;
  const metrics = new HttpMetrics();
  const publicOrigin = new URL(options.publicOrigin);
  if (
    (publicOrigin.protocol !== "http:" && publicOrigin.protocol !== "https:") ||
    publicOrigin.pathname !== "/" ||
    publicOrigin.search !== "" ||
    publicOrigin.hash !== ""
  ) {
    throw new RegistryError(["publicOrigin must be an http(s) origin without a path"]);
  }
  const views = options.views ?? {};
  const clock = options.clock ?? systemClock;
  const css = options.stylesheet ?? STYLESHEET;
  const assetMaxAge = options.assetMaxAge ?? 3600;
  const trustProxy = options.trustProxy ?? false;
  // Normalized once, at boot, into a set: the comparison happens on every authenticated
  // request and an operator who typed `Ada@Example.COM` in a compose file should not
  // discover at 3am that founding silently did nothing.
  const founders = new Set((options.founders ?? []).map((email) => normalizeEmail(email)));

  // Two boot-time refusals, both about declarations that would otherwise fail quietly
  // and late. A view keyed on a command that does not exist renders through the generic
  // fallback forever, and whoever wrote the bespoke page never finds out. A gate without
  // a scope names a window on an event the dispatcher was never told how to find.
  const faults = [
    ...Object.keys(views)
      .filter((name) => registry.byName(name) === undefined)
      .map((name) => `${name} has a view but is not a command`),
    ...registry.commands
      .filter((c) => c.capability.gate !== undefined && c.capability.scope === undefined)
      .map((c) => `${c.name} declares the ${String(c.capability.gate)} gate but no scope`),
  ];
  if (faults.length > 0) throw new RegistryError(faults);

  const dispatch = async (
    request: Request,
    url: URL,
    target: Target,
    trace: Trace,
    address: string,
    now: number,
  ): Promise<Response> => {
    const requestCookies = parseCookies(request.headers.get("cookie"));
    const hasSeenDisclaimer = requestCookies["manak_demo_disclaimer"] === "seen";
    if (target.pathname === "/metrics") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        throw methodNotAllowed(request.method, ["GET"]);
      }
      trace.command = "system.metrics";
      return new Response(metrics.render(db, now), { status: 200, headers: {
        ...SECURITY_HEADERS,
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "cache-control": "no-store",
      } });
    }
    const media = bundledAsset(request, target.pathname);
    if (media !== null) return media;
    const doc = staticDocAsset(request, target.pathname);
    if (doc !== null) return doc;
    // The stylesheet is not a command, and giving it a declaration would put a row for a
    // file in the capability matrix and the OpenAPI document. It is the one thing this
    // server sends that is not an operation on the domain.
    if (target.pathname === STYLESHEET_PATH) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        throw methodNotAllowed(request.method, ["GET"]);
      }
      return stylesheet(css, assetMaxAge);
    }

    if (target.pathname === "/widget.js") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        throw methodNotAllowed(request.method, ["GET"]);
      }
      return jsResponse(WIDGET_JS);
    }

    if (target.pathname === "/embed.js") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        throw methodNotAllowed(request.method, ["GET"]);
      }
      return jsResponse(EMBED_JS);
    }

    const embedMatch = /^\/embed\/([^/]+)\/?$/.exec(target.pathname);
    if (embedMatch) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        throw methodNotAllowed(request.method, ["GET"]);
      }
      let reference: string;
      try {
        reference = decodeURIComponent(embedMatch[1] as string);
      } catch {
        throw notFound("event");
      }
      const event = resolveEvent(db, reference);
      if (!event) throw notFound("event");
      // parentOrigin is only a message destination hint. Refuse opaque, non-web, and
      // path-bearing values; the embed itself remains public and frameable from any site.
      let parentOrigin = "";
      const suppliedOrigin = url.searchParams.get("parentOrigin");
      if (suppliedOrigin !== null) {
        try {
          const parsed = new URL(suppliedOrigin);
          if ((parsed.protocol === "http:" || parsed.protocol === "https:") &&
              parsed.origin === suppliedOrigin && parsed.username === "" && parsed.password === "") {
            parentOrigin = parsed.origin;
          }
        } catch {
          // Invalid origins disable resize messaging; they never widen the message target.
        }
      }
      const headers = new Headers(SECURITY_HEADERS);
      headers.delete("x-frame-options");
      headers.set("content-type", "text/html; charset=utf-8");
      headers.set("cache-control", "no-store");
      const body = embedPage(event.slug, parentOrigin);
      // embedPage generates the per-response nonce. Read the nonce from its script tag
      // only after controlled generation, then bind CSP to that exact inline script.
      const nonce = /<script nonce="([a-f0-9]+)">/.exec(body)?.[1];
      if (nonce === undefined) throw new Error("Embed page did not include its script nonce.");
      headers.set("content-security-policy", [
        "default-src 'none'",
        "connect-src 'self'",
        "style-src 'unsafe-inline'",
        `script-src 'nonce-${nonce}'`,
        "frame-ancestors *",
        "base-uri 'none'",
      ].join("; "));
      return new Response(body, { status: 200, headers });
    }

    if (target.pathname === "/.well-known/manak-key.pub" || target.pathname === "/manak-key.pub") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        throw methodNotAllowed(request.method, ["GET"]);
      }
      const pub = options.publicKey ?? getOrCreateKeypair(options.keyDir ?? certificateKeyDirectory()).publicKeyPem;
      return textResponse(pub);
    }

    if (target.pathname === "/verify") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        throw methodNotAllowed(request.method, ["GET"]);
      }
      return html(verifyPage(), 200, {
        headers: {
          "content-security-policy":
            "default-src 'none'; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        },
      });
    }

    // The logo is the only multipart write in the product. Parse it behind a strict
    // byte cap, then use the same session, event role and rate-limit checks as writes.
    const logoMatch = /^\/events\/([^/]+)\/certificates\/logo(\/remove)?$/.exec(target.pathname);
    if (logoMatch) {
      if (request.method !== "POST") throw methodNotAllowed(request.method, ["POST"]);
      trace.command = logoMatch[2] ? "results.remove_certificate_logo" : "results.upload_certificate_logo";
      const presented = credentialFrom(request, SESSION_COOKIE);
      const found = presented === null ? undefined : resolveSession(db, presented, now);
      if (!found) throw unauthenticated("Sign in as an event organizer.");
      const event = resolveEvent(db, decodeURIComponent(logoMatch[1] as string));
      if (!event || !rolesIn(db, event.id, found.account.id).includes("organizer")) throw notFound("event");
      trace.accountId = found.account.id;
      const requestOrigin = request.headers.get("origin");
      if (requestOrigin !== null && requestOrigin !== publicOrigin.origin) throw forbidden("Logo upload requires the deployment origin.");
      if (request.headers.get("sec-fetch-site") === "cross-site") throw forbidden("Cross-site logo upload is refused.");
      const ctx = makeContext(db, { clock: { now: () => now } }).as(found.account.id);
      enforce(ctx, "organize", event.id);
      if (logoMatch[2]) {
        ctx.recorded({ action: "certificate.logo.updated", eventId: event.id, payload: { removed: true } },
          () => clearCertificateLogo(db, event.id, now));
      } else {
        const type = request.headers.get("content-type") ?? "";
        if (!/^multipart\/form-data;\s*boundary=/i.test(type)) throw new RuleError("request.mediaType", "Upload a PNG or JPEG using the logo file field.");
        const bytes = await boundedCertificateUpload(request, 112 * 1024);
        const form = await new Response(bytes, { headers: { "content-type": type } }).formData();
        const values = form.getAll("logo");
        if (values.length !== 1 || !(values[0] instanceof File)) throw new RuleError("request.malformed", "Choose one logo file.");
        const file = values[0];
        const logo = new Uint8Array(await file.arrayBuffer());
        ctx.recorded({ action: "certificate.logo.updated", eventId: event.id,
          payload: { type: file.type, bytes: logo.byteLength } },
          () => saveCertificateLogo(db, event.id, logo, file.type, now));
      }
      return seeOther(`/events/${encodeURIComponent(event.slug)}/certificates/studio`);
    }

    const svgMatch = /^\/events\/([^/]+)\/certificates\/([^/]+)\.svg$/.exec(target.pathname);
    if (svgMatch) {
      if (request.method !== "GET" && request.method !== "HEAD") throw methodNotAllowed(request.method, ["GET"]);
      trace.command = "results.certificate_svg";
      const event = resolveEvent(db, decodeURIComponent(svgMatch[1] as string));
      if (!event) throw notFound("event");
      const serial = decodeURIComponent(svgMatch[2] as string);
      const cert = publicCertificate(db, event.id, serial);
      if (!cert || cert.status !== "active") throw notFound("certificate");
      const path = `/events/${encodeURIComponent(event.slug)}/certificates/${encodeURIComponent(serial)}`;
      const filename = serial.replace(/[^A-Za-z0-9._-]/g, "_");
      return new Response(request.method === "HEAD" ? null : certificateSvg(cert, new URL(path, cert.issuerOrigin).href), {
        headers: { ...SECURITY_HEADERS, "content-security-policy": "default-src 'none'; img-src data:; style-src 'none'; script-src 'none'; frame-ancestors 'none'",
          "content-type": "image/svg+xml; charset=utf-8", "content-disposition": `attachment; filename="${filename}.svg"`,
          "cache-control": "no-store" },
      });
    }

    if (target.pathname === "/guide" || target.pathname === "/api/guide") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        throw methodNotAllowed(request.method, ["GET"]);
      }
      trace.command = "system.guide";
      trace.path = target.pathname;
      const presented = credentialFrom(request, SESSION_COOKIE);
      const found = presented === null ? undefined : resolveSession(db, presented, now);
      const whoami = found?.account.display_name ?? null;

      if (target.wants === "json" || target.pathname === "/api/guide") {
        return json({
          title: "Manak Evaluation Guide & Platform Sitemap",
          overview: "Comprehensive evaluation guide and platform sitemap for hackathon judges, organizers, and participants.",
          features: {
            judging: {
              duel: "Pairwise head-to-head project comparisons with active learning (/events/:slug/duel)",
              queue: "Assigned rubric evaluation queue with private draft saves (/events/:slug/judging)",
              gallery: "Public project gallery and submission details (/events/:slug/projects)",
              voting: "Community choice quadratic voting (/events/:slug/voting)",
            },
            organizer: {
              dashboard: "Real-time review coverage, judge calibration, and bottleneck diagnostics (/events/:slug/dashboard)",
              results: "Normalized standings with evidence and uncertainty caveats (/events/:slug/results)",
              confidence: "Judge residual analysis and outlier diagnostics (/events/:slug/results/confidence)",
              rubric: "Rubric criteria weighting and scoring anchors (/events/:slug/rubric)",
              judges: "Judge roster management and single-use magic invitations (/events/:slug/judges)",
              auditLedger: "Tamper-evident CSV audit ledger (/api/events/:slug/results/audit.csv)",
              liveLeaderboard: "Real-time auto-updating leaderboard with stage podium presentation (/events/:slug/live)",
            },
            verification: {
              verifier: "Offline Ed25519 certificate verifier (/verify)",
              publicKey: "Server Ed25519 public key (/.well-known/manak-key.pub)",
              ledgerStatus: "Hash-chained ledger status and head hash (/api/healthz)",
            },
          },
        }, 200);
      }

      const activeEvents = db.all<{ slug: string; name: string }>(
        "select slug, name from event where archived_at is null order by created_at asc",
      );
      return html(guidePage({
        whoami,
        demoMode: options.demoMode === true,
        showDemoDisclaimer: options.demoMode === true && !hasSeenDisclaimer,
        events: activeEvents,
      }), 200);
    }

    const liveMatch = /^\/(api\/)?events\/([^/]+)\/live\/?$/.exec(target.pathname);
    if (liveMatch) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        throw methodNotAllowed(request.method, ["GET"]);
      }
      const isApi = liveMatch[1] !== undefined || target.wants === "json";
      const eventSlug = liveMatch[2] as string;
      const event = resolveEvent(db, eventSlug);
      if (!event) throw notFound("event", eventSlug);

      trace.command = "results.live";
      trace.path = target.pathname;

      const presented = credentialFrom(request, SESSION_COOKIE);
      const found = presented === null ? undefined : resolveSession(db, presented, now);
      const accountId = found?.account.id ?? null;
      const whoami = found?.account.display_name ?? null;
      const founder = found !== undefined && founders.has(found.account.email);
      const roles: readonly Role[] = accountId !== null ? rolesIn(db, event.id, accountId) : [];
      const isOrganizer = roles.includes("organizer") || founder;

      const ctx = makeContext(db, { clock: { now: () => now } });
      enforce(ctx, "read", `ceremony:${accountId ?? address}:${event.id}`);
      const currentHead = headHash(db);
      const gates = gatesFor(event, now);

      const pause = url.searchParams.get("pause") === "1";
      const refreshInterval = Math.min(60, Math.max(5, parseInt(url.searchParams.get("refresh") ?? "5", 10) || 5));
      const mode = url.searchParams.get("mode") === "projector" ? "projector" : "standard";
      const selectedTrack = url.searchParams.get("track") || null;

      const published = event.results_public !== 0;

      if (!published && !isOrganizer) {
        if (isApi) {
          return json({
            live: false,
            state: "standby",
            message: "Judging in progress. Live standings will broadcast once published.",
            event: { slug: event.slug, name: event.name },
            headHash: currentHead,
          }, 200);
        }
        return html(liveLeaderboardPage({
          event: { slug: event.slug, name: event.name },
          whoami,
          isOrganizer,
          demoMode: options.demoMode === true,
          published,
          headHash: currentHead,
          now,
          pause,
          refreshInterval,
          mode,
          selectedTrack,
          projects: [],
          state: "standby",
        }), 200);
      }

      const liveData = registry.byName("results.show")!.handler({
        ctx,
        event,
        input: { event: event.slug },
        roles,
        accountId,
        founder,
        gates,
        now,
        registry,
        address, userAgent: request.headers.get("user-agent") ?? "", origin: publicOrigin.origin,
        signIn: () => { throw new Error("Read-only report cannot sign in"); },
        signOut: () => { throw new Error("Read-only report cannot sign out"); },
        deliver: () => { throw new Error("Read-only report cannot send mail"); },
      } satisfies Invocation) as Record<string, unknown>;

      const allProjects = (Array.isArray(liveData.projects) ? liveData.projects : []) as LiveProject[];
      const projects = selectedTrack ? allProjects.filter((project) => project.trackKey === selectedTrack) : allProjects;
      const panel = liveData.panel as any;
      const warnings = Array.isArray(liveData.warnings) ? (liveData.warnings as string[]) : [];

      if (isApi) {
        return json({
          live: true,
          state: "broadcast",
          event: { slug: event.slug, name: event.name },
          headHash: currentHead,
          updatedAt: now,
          revision: liveData.revision,
          evidenceCutoffAt: liveData.evidenceCutoffAt,
          ballots: liveData.ballots,
          comparisonsDecided: liveData.comparisonsDecided,
          method: liveData.method,
          converged: liveData.converged,
          podium: projects.slice(0, 3).map((p, idx) => ({
            place: idx + 1,
            title: p.title,
            trackKey: p.trackKey,
            adjusted: p.adjusted,
            tier: p.tier ?? null,
            rankMove: p.rankMove ?? 0,
          })),
          projects,
          panel,
          warnings,
        }, 200);
      }

      return html(liveLeaderboardPage({
        event: { slug: event.slug, name: event.name },
        whoami,
        isOrganizer,
        demoMode: options.demoMode === true,
        published,
        headHash: currentHead,
        now,
        pause,
        refreshInterval,
        mode,
        selectedTrack,
        revision: typeof liveData.revision === "number" ? liveData.revision : null,
        method: String(liveData.method ?? "none"),
        converged: liveData.converged === true,
        ballots: Number(liveData.ballots ?? 0),
        comparisonsDecided: Number(liveData.comparisonsDecided ?? 0),
        projects,
        panel,
        warnings,
        state: "live",
      }), 200);
    }


    const tieMatch = /^\/(api\/)?events\/([^/]+)\/tie-breaker\/?$/.exec(target.pathname);
    if (tieMatch) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        throw methodNotAllowed(request.method, ["GET"]);
      }
      const isApi = tieMatch[1] !== undefined || target.wants === "json";
      const eventSlug = tieMatch[2] as string;
      const event = resolveEvent(db, eventSlug);
      if (!event) throw notFound("event", eventSlug);

      trace.command = "results.tie-breaker";
      trace.path = target.pathname;

      const presented = credentialFrom(request, SESSION_COOKIE);
      const found = presented === null ? undefined : resolveSession(db, presented, now);
      const accountId = found?.account.id ?? null;
      const whoami = found?.account.display_name ?? null;
      const founder = found !== undefined && founders.has(found.account.email);
      const roles: readonly Role[] = accountId !== null ? rolesIn(db, event.id, accountId) : [];
      const isOrganizer = roles.includes("organizer") || founder;

      const ctx = makeContext(db, { clock: { now: () => now } });
      const gates = gatesFor(event, now);

      if (!found) throw unauthenticated("Sign in as an event organizer to inspect finalist evidence.");
      if (!roles.includes("organizer")) throw forbidden("Finalist decision support is organizer-only.");
      enforce(ctx, "read", `tie-breaker:${accountId}:${event.id}`);
      const liveData = registry.byName("results.show")!.handler({
        ctx, event, input: { event: event.slug }, roles, accountId, founder, gates, now, registry,
        address, userAgent: request.headers.get("user-agent") ?? "", origin: publicOrigin.origin,
        signIn: () => { throw new Error("Read-only report cannot sign in"); },
        signOut: () => { throw new Error("Read-only report cannot sign out"); },
        deliver: () => { throw new Error("Read-only report cannot send mail"); },
      } satisfies Invocation) as Record<string, unknown>;
      const pList = (Array.isArray(liveData.projects) ? liveData.projects : []) as LiveProject[];
      const finalists: TieBreakerFinalist[] = pList.slice(0, 2).map((p) => ({
        id: p.project, title: p.title, trackKey: p.trackKey, adjusted: p.adjusted,
        ...(p.low === undefined ? {} : { low: p.low }),
        ...(p.high === undefined ? {} : { high: p.high }), ballots: p.ballots ?? 0,
      }));
      const assessment = assessFinalists(finalists, liveData.pairwise as PairwiseEvidence | null);
      if (isApi) return json({ event: { slug: event.slug, name: event.name },
        finalists, ...assessment, revision: liveData.revision ?? null, criteria: [],
      }, 200);
      return html(tieBreakerPage({ slug: event.slug, eventName: event.name, whoami, demoMode: options.demoMode === true,
        isOrganizer, finalists, assessment,
      }), 200);
    }


    if (target.pathname === "/demo/dismiss") {
      if (options.demoMode !== true) throw notFound("route");
      if (request.method !== "GET" && request.method !== "POST" && request.method !== "HEAD") {
        throw methodNotAllowed(request.method, ["GET", "POST"]);
      }
      let toParam: string | null = url.searchParams.get("to");
      if (request.method === "POST") {
        try {
          const body = await request.formData();
          const bTo = body.get("to");
          if (typeof bTo === "string" && bTo.startsWith("/")) toParam = bTo;
        } catch {}
      }
      const targetUrl = (toParam && toParam.startsWith("/")) ? toParam : "/";
      const headers = new Headers();
      headers.set("location", targetUrl);
      headers.set("set-cookie", "manak_demo_disclaimer=seen; Path=/; Max-Age=2592000; SameSite=Lax");
      return new Response(null, { status: 303, headers });
    }

    if (target.pathname === "/fast-login" || target.pathname === "/events/switch") {
      if (options.demoMode !== true) throw notFound("route");
      if (target.pathname === "/fast-login" && request.method !== "POST") throw methodNotAllowed(request.method, ["POST"]);
      if (target.pathname === "/events/switch" && request.method !== "GET" && request.method !== "POST" && request.method !== "HEAD") {
        throw methodNotAllowed(request.method, ["GET", "POST"]);
      }
      const origin = request.headers.get("origin");
      if (request.method === "POST" && origin !== null && origin !== publicOrigin.origin) throw forbidden("Demo login requires the deployment origin.");
      let as = url.searchParams.get("as") ?? "";
      let eventParam: string | null = url.searchParams.get("event");
      let toParam: string | null = url.searchParams.get("to");
      if (request.method === "POST") {
        const body = await request.formData();
        as = String(body.get("as") ?? as);
        const bEvent = body.get("event");
        if (typeof bEvent === "string") eventParam = bEvent;
        const bTo = body.get("to");
        if (typeof bTo === "string") toParam = bTo;
      }
      const sampleEvent = resolveEvent(db, "sample-hack-2026") ?? resolveEvent(db, "evt_01");
      const dogfoodEvent = resolveEvent(db, "dogfood");
      const chosenEvent = typeof eventParam === "string" ? resolveEvent(db, eventParam) : undefined;
      const wantsDogfood = as === "judge_a" || as === "judge_nils" || as.includes("dogfood");
      const targetEvent = chosenEvent ?? (wantsDogfood ? dogfoodEvent ?? sampleEvent : sampleEvent ?? dogfoodEvent) ?? db.get<{ slug: string }>("select slug from event order by created_at desc limit 1");
      const isDogfood = targetEvent?.slug === "dogfood";

      const defaultPersona: { email: string; name: string; role?: Role; targetId?: string } = {
        email: "rosa@example.com",
        name: "Rosa Iyer",
        role: "organizer",
      };
      const personas: Record<string, { email: string; name: string; role?: Role; targetId?: string }> = {
        organizer: defaultPersona,
        judge: { email: "tomas.varga@example.org", name: "Tomas Varga", role: "judge", targetId: "jdg_01" },
        judge_sample: { email: "tomas.varga@example.org", name: "Tomas Varga", role: "judge", targetId: "jdg_01" },
        judge_a: { email: "nils@example.com", name: "Nils Berg", role: "judge" },
        judge_nils: { email: "nils@example.com", name: "Nils Berg", role: "judge" },
        judge_b: { email: "amara@example.com", name: "Amara Osei", role: "judge" },
        participant: isDogfood
          ? { email: "beatriz@example.com", name: "Beatriz Lima", role: "participant" }
          : { email: "priya1@example.org", name: "Priya Nair", role: "participant" },
        participant_sample: { email: "priya1@example.org", name: "Priya Nair", role: "participant" },
        participant_dogfood: { email: "beatriz@example.com", name: "Beatriz Lima", role: "participant" },
        builder: isDogfood
          ? { email: "beatriz@example.com", name: "Beatriz Lima", role: "participant" }
          : { email: "priya1@example.org", name: "Priya Nair", role: "participant" },
        builder_sample: { email: "priya1@example.org", name: "Priya Nair", role: "participant" },
        builder_dogfood: { email: "beatriz@example.com", name: "Beatriz Lima", role: "participant" },
      };
      const persona = personas[as];
      if (!persona) throw notFound("demo persona");
      if (!targetEvent || !["sample-hack-2026", "dogfood"].includes(targetEvent.slug)) throw notFound("demo event");
      if (as !== "organizer" && (as.includes("dogfood") || ["judge_a", "judge_nils", "judge_b"].includes(as)) !== isDogfood && chosenEvent !== undefined) {
        throw notFound("demo persona in event");
      }
      const ctx = makeContext(db, { clock: { now: () => now } });
      const secure = options.secure ?? isSecure(request, url, trustProxy);
      const minted = db.tx(() => {
        let account = findAccountByEmail(db, persona.email);
        if (account === undefined) {
          account = upsertAccount(ctx, persona.email, persona.name, persona.targetId);
        }
        const allEvents = db.all<{ id: string; slug: string }>("select id, slug from event where archived_at is null and slug in ('sample-hack-2026', 'dogfood')");
        for (const ev of allEvents) {
          if (persona.role !== undefined && (as === "organizer" || ev.slug === targetEvent.slug)) {
            grantRole(ctx, ev.id, account.id, persona.role);
          }
        }
        return createSession(ctx, account.id, { userAgent: "Hackathon Fast Login" });
      });
      const cookie = sessionCookie(SESSION_COOKIE, minted.token, {
        maxAge: Math.max(0, Math.ceil((minted.expiresAt - now) / 1000)),
        secure,
      });

      let destination = targetEvent !== undefined ? `/events/${targetEvent.slug}` : "/";
      if (targetEvent !== undefined) {
        if (as.startsWith("judge")) {
          destination = `/events/${targetEvent.slug}/judging`;
        } else if (as.startsWith("participant") || as.startsWith("builder")) {
          destination = `/events/${targetEvent.slug}/teams`;
        }
      }
      if (typeof toParam === "string" && toParam.startsWith("/") && !toParam.startsWith("//") && !toParam.includes("\\")) {
        destination = toParam;
      }
      return seeOther(destination, { cookies: [cookie] });
    }

    const method = request.method === "HEAD" ? "GET" : request.method;
    const match = registry.match(method, target.canonical);
    if (match === undefined) {
      const methods = registry.methodsFor(target.canonical);
      if (methods.length > 0) throw methodNotAllowed(request.method, methods);
      throw notFound("route", target.pathname);
    }
    const command = match.command;
    trace.command = command.name;
    trace.path = loggedPath(target.pathname, command);

    // The request's one instant, drawn once by `serve` and handed to a frozen clock
    // rather than captured as a number a repository cannot reach. A repository three
    // transactions deep calls `ctx.now()`, and if that read the wall clock a ballot could
    // be recorded a millisecond after the deadline it was just checked against. The
    // context is per request for a second reason: `appended()` then holds this request's
    // ledger entries and nothing else, which is what makes the declaration check below
    // cheap and bounds a long-running process's memory.
    const ctx = makeContext(db, { clock: { now: () => now } });
    const client = clientAddress(request, address, trustProxy);
    const secure = options.secure ?? isSecure(request, url, trustProxy);

    const submission = await readSubmission(request, url, match.params);

    const presented = credentialFrom(request, SESSION_COOKIE);
    const found = presented === null ? undefined : resolveSession(db, presented, now);
    const accountId = found?.account.id ?? null;
    trace.accountId = accountId;
    trace.whoami = found?.account.display_name ?? null;
    if (found !== undefined) freshen(ctx, found.session, now);

    // A cookie that resolves to nothing is cleared on the way out, whatever the answer
    // turns out to be. Without this, a browser holding a revoked or expired session sends
    // it on every request for a fortnight, gets rendered as a visitor every time, and has
    // no way to stop: signing out is the operation that clears the cookie and signing out
    // is refused, because the credential it would clear does not resolve. The cookie is
    // read separately from `credentialFrom` on purpose — a bad `Authorization` header must
    // not clear a good cookie, and neither must its absence.
    const cookied = parseCookies(request.headers.get("cookie"))[SESSION_COOKIE];
    const stale =
      cookied !== undefined && cookied !== "" && resolveSession(db, cookied, now) === undefined
        ? clearedCookie(SESSION_COOKIE, secure)
        : null;
    if (stale !== null) trace.cookies = [stale];

    // Founding is a fact about this deployment's configuration rather than about the
    // account, so it is computed here, from the address the session resolved to, and never
    // read from a table. A founder list in the database would be a row worth attacking; a
    // founder list in the environment is revoked by a restart.
    const founder = found !== undefined && founders.has(found.account.email);

    const early = decide(command.capability, { accountId, roles: [], founder });
    if (!early.allowed && early.refusal === "unauthenticated") throw unauthenticated(early.because);

    let input: Parsed;
    try {
      input = parseInput(command.input, submission.raw, { coerce: submission.coerce });
    } catch (error) {
      // A browser posting a form gets the form back with every problem marked, in the
      // layout the first attempt was in. A GET whose query string is wrong does not:
      // its form, if it has one, posts somewhere else, and redisplaying it here would
      // send a corrected submission to the wrong route.
      if (
        target.wants === "html" &&
        method === "POST" &&
        command.form !== undefined &&
        error instanceof InputError
      ) {
        return html(invalidForm(command, target, error, trace.whoami, submission.raw), 422);
      }
      throw error;
    }

    const scope = command.capability.scope;
    let event: EventRow | null = null;
    if (scope !== undefined) {
      const reference = input[scope];
      // A route names its event by id or by slug, and both spellings answer the same
      // 404 when they name nothing. `notFound("event")` rather than a 422 about the
      // shape of the parameter: telling a stranger their id was well-formed but unknown,
      // and their slug malformed, is two facts more than they need.
      event =
        typeof reference === "string" && reference !== "" ? resolveEvent(db, reference) ?? null : null;
      if (event === null) throw notFound("event");
    }

    const bucket: LimitName = command.limit ?? READ_LIMIT;
    const declaredKey = command.limitKey?.({ input, accountId, address: client }) ?? accountId ?? client;
    const limitKey = event?.id ?? (scope === undefined ? declaredKey : client);
    enforce(ctx, bucket, limitKey);

    const roles: readonly Role[] =
      event !== null && accountId !== null ? rolesIn(db, event.id, accountId) : [];

    const verdict = decide(command.capability, { accountId, roles, founder });
    if (!verdict.allowed) {
      if (verdict.refusal === "unauthenticated") throw unauthenticated(verdict.because);
      if (verdict.refusal === "forbidden") throw forbidden(verdict.because);
      throw notFound("event");
    }

    if (command.name === "events.warp_clock" && options.demoMode !== true) throw forbidden("Clock controls require an explicitly enabled disposable demo.");
    const gates: EventGates | null = event === null ? null : gatesFor(event, now);
    const gate = command.capability.gate;
    if (gate !== undefined) assertGate(event as EventRow, now, gate);

    // A handler says "this caller now holds a session" and never touches a header. The
    // two verbs land here, and this is where a granted session becomes a cookie for a
    // browser while a script reads the same token out of the response body.
    const session: { grant: { token: string; expiresAt: number } | null; revoked: boolean } = {
      grant: null,
      revoked: false,
    };
    const call: Invocation = {
      input,
      ctx: ctx.as(accountId),
      accountId,
      roles,
      event,
      gates,
      registry,
      founder,
      now,
      address: client,
      userAgent: request.headers.get("user-agent") ?? "",
      voterToken: event === null ? null : parseCookies(request.headers.get("cookie"))[`manak_voter_${event.id}`] ?? null,
      signIn: (token, expiresAt) => {
        session.grant = { token, expiresAt };
        session.revoked = false;
      },
      // Revoked here rather than after the handler returns, so the ledger entry lands
      // inside the window `assertRecordsDeclared` checks. A revocation filed after that
      // check would be a write no declaration had to admit to.
      //
      // "Everywhere" is resolved here as well, for the same reason the port exists at all:
      // this is the only scope holding the caller's own token hash, and a command layer
      // that had to be told it would be a command layer that could be told a lie.
      // `sessionsOf` includes the current session, so one loop covers the lot and no
      // session collects two revocation entries for one request.
      signOut: (scope) => {
        if (found !== undefined) {
          const targets =
            scope?.everywhere === true
              ? sessionsOf(db, found.account.id, now).map((row) => row.token_hash)
              : [found.session.token_hash];
          for (const hash of targets) revokeSession(ctx.as(accountId), hash);
        }
        session.grant = null;
        session.revoked = true;
      },
      deliver: options.deliver ?? logDelivery,
      origin: publicOrigin.origin,
    };

    const before = ctx.appended().length;
    let result: unknown;
    try {
      result = db.tx(() => {
        const value = command.handler(call);
        if (value !== null && typeof value === "object" && "then" in value) {
          throw new DatabaseError(
            "handler.async",
            `${command.name} returned a Promise; command handlers must complete synchronously ` +
              "so audited writes can commit atomically.",
          );
        }
        assertRecordsDeclared(command, ctx.appended().slice(before));
        return value;
      });
    } catch (error) {
      // The same redisplay a malformed body gets, for the problems no field declaration
      // can express. "Judging closes before it opens" is a fact about two fields at once,
      // so `parseInput` cannot find it and the handler has to; without this branch the
      // person who mistyped one date would be handed a JSON problem document instead of
      // their form back with the mistake marked. A `RuleError` deliberately does not land
      // here — a request the domain refuses is not a form to correct.
      if (
        target.wants === "html" &&
        method === "POST" &&
        command.form !== undefined &&
        error instanceof InputError
      ) {
        return html(invalidForm(command, target, error, trace.whoami, submission.raw), 422);
      }
      throw error;
    }
    const cookies: string[] = [];
    if (command.name === "votes.start" && event !== null) {
      const voter = result as { token: string; expiresAt: number };
      cookies.push(sessionCookie(`manak_voter_${event.id}`, voter.token, {
        maxAge: Math.max(0, Math.ceil((voter.expiresAt - now) / 1000)), secure,
      }));
    }
    if (session.grant !== null) {
      cookies.push(
        sessionCookie(SESSION_COOKIE, session.grant.token, {
          maxAge: Math.max(0, Math.ceil((session.grant.expiresAt - now) / 1000)),
          secure,
        }),
      );
    }
    if (session.revoked) cookies.push(clearedCookie(SESSION_COOKIE, secure));
    // Only if this request did not decide the cookie's fate itself. A grant supersedes the
    // clear — a stale cookie followed by a successful sign-in is exactly that — and two
    // `Set-Cookie` headers for one name is a race rather than an instruction.
    if (cookies.length === 0 && stale !== null) cookies.push(stale);
    trace.cookies = cookies;
    const extra: Extra = cookies.length === 0 ? {} : { cookies };
    if (command.returns.kind === "csv") {
      const download = result as { csv: string; filename: string };
      return csvResponse(download.csv, download.filename);
    }

    // Everything a view is allowed to see, assembled once. The result is added at the
    // point of rendering, because the streaming branch renders a different one.
    const seen = {
      command,
      input,
      whoami: trace.whoami,
      demoMode: options.demoMode === true,
      showDemoDisclaimer: options.demoMode === true && !hasSeenDisclaimer,
      accountId,
      event,
      gates,
      now,
      registry,
      founder,
    };

    if (command.returns.kind === "stream") {
      const frames = result as AsyncIterable<StreamEvent>;
      if (target.wants === "json") return eventStream(frames, extra);
      // A browser cannot read a stream without scripting, and the policy forbids adding
      // any. The first frame is the page, and the page asks for itself again.
      return html(render(views, { ...seen, result: await firstFrame(frames) }), 200, extra);
    }

    if (target.wants === "json") {
      return command.returns.kind === "empty" ? empty(204, extra) : json(result ?? null, 200, extra);
    }

    if (command.name === "results.certificate_studio" || command.name === "results.public_certificate") {
      return html(render(views, { ...seen, result }), 200, { ...extra, headers: {
        "content-security-policy": "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      } });
    }

    // A browser that just wrote something is sent somewhere with GET, so the back button
    // and a reload cannot repeat the write. Where to is the command's own business when
    // it says so, and the event it belongs to otherwise.
    if (method === "POST") {
      return seeOther(
        command.form?.redirect?.({ input, result }) ?? (event === null ? "/" : `/events/${event.id}`),
        extra,
      );
    }

    return html(render(views, { ...seen, result }), 200, extra);
  };

  /**
   * The outer half: negotiate, dispatch, and turn anything thrown into a response.
   *
   * Two things happen here that cannot happen inside `dispatch`. The refusal is rendered
   * in the caller's own dialect, which is why `negotiate` runs before the `try` — a
   * problem document for a browser is a page, and deciding that after the failure would
   * mean guessing. And a session that was cleared before the failure is still cleared:
   * `trace.cookies` survives the throw, so `POST /signout` followed by a refusal does not
   * leave the caller holding a revoked token their browser still sends.
   */
  const serve: Serve = async (request, address = "") => {
    const started = clock.now();
    const startedMonotonic = performance.now();
    const url = new URL(request.url);
    const target = negotiate(url.pathname);
    const trace: Trace = {
      command: null,
      accountId: null,
      whoami: null,
      cookies: [],
      code: null,
      path: target.pathname,
    };

    let response: Response;
    try {
      response = await dispatch(request, url, target, trace, address, started);
    } catch (error) {
      trace.code = codeOf(error);
      // A declared refusal is an answer this product gives on purpose; only a bug gets a
      // stack trace sent to the operator, or the one that matters is buried under 404s.
      if (isUnexpected(error)) options.report?.(error);
      response = refusal(error, {
        wants: target.wants,
        now: started,
        whoami: trace.whoami,
        ...(trace.cookies.length === 0 ? {} : { extra: { cookies: trace.cookies } }),
      });
    }

    // HEAD answered where the body is discarded rather than in the socket adapter, so a
    // test that calls `serve` directly sees the same thing a curl does. The body is
    // cancelled instead of dropped: a streaming response holds a database statement open,
    // and nobody is going to read it. `Content-Length` is deliberately absent — deriving
    // it would mean buffering the page this request just declined to send.
    const answer =
      request.method === "HEAD"
        ? (await response.body?.cancel(),
          new Response(null, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          }))
        : response;

    metrics.observe(request.method, answer.status, performance.now() - startedMonotonic);

    options.log?.({
      at: started,
      ms: clock.now() - started,
      method: request.method,
      path: trace.path,
      wants: target.wants,
      status: answer.status,
      command: trace.command,
      account: trace.accountId,
      code: trace.code,
    });
    return answer;
  };

  return serve;
}

/** A 405 in the shape `allowedMethods` reads back, so the `Allow` header is not lost. */
function methodNotAllowed(method: string, allow: readonly string[]): RuleError {
  return new RuleError(
    "request.method",
    `${method} is not accepted at this address. Use ${allow.join(" or ")}.`,
    { [ALLOW_KEY]: [...allow] },
  );
}

/**
 * The path a log line may keep: literal, except where a segment is a declared secret.
 *
 * The whole problem is one route. `GET /api/signin/:token` puts a working credential in a
 * URL, and everything that touches a URL keeps it — stdout, the aggregator, the terminal
 * scrollback of whoever ran `docker logs`. A token is single-use against the database and
 * indefinitely useful in a log written before it was used, so the segment is replaced with
 * `:token` here, derived from `secret: true` on the field rather than from a list of paths
 * to be careful about.
 *
 * Only the secret segment goes. Reducing every path to its template would have been one
 * line shorter and would have thrown away the thing that makes a log worth reading — that
 * it was `/api/events/dogfood-2026/judges` and not some other event's roster.
 *
 * Aligned from the right, because a browser request logs `/signin/<token>` while the
 * command declares `/api/signin/:token`: the canonical path is the caller's path with a
 * prefix on it, so the trailing segments correspond and the offset absorbs the difference.
 */
function loggedPath(pathname: string, command: Command): string {
  const declared = command.path.split("/");
  const actual = pathname.split("/");
  const offset = actual.length - declared.length;
  return actual
    .map((segment, index) => {
      const name = declared[index - offset] ?? "";
      const named = name.startsWith(":") ? name.slice(1) : "";
      return named !== "" && command.input[named]?.secret === true ? name : segment;
    })
    .join("/");
}

/**
 * The default delivery: one line, on stdout, saying plainly what it is.
 *
 * Written as a single line because that is what survives a log aggregator, and it names
 * itself as a fallback because the failure this default has is silent — an operator who
 * assumed mail was configured has no other way to find out that it is not.
 */
function logDelivery(message: Delivery): void {
  const where = message.link === undefined ? "" : ` link=${message.link}`;
  process.stdout.write(
    `[deliver] no delivery configured, printing instead: reason=${message.reason} ` +
      `to=${message.to} subject=${JSON.stringify(message.subject)}${where}\n`,
  );
}

/**
 * Who a rate limit is charged to when nobody is signed in.
 *
 * `X-Forwarded-For` is a list and the leftmost entry is the client's own claim, so it is
 * read only when `trustProxy` says an operator's proxy rewrites the header. With the flag
 * off the socket's address wins even when the header is present, which is the entire point
 * of the flag: otherwise a single attacker sends a different address with every request
 * and the limiter counts to one forever.
 *
 * The empty fallback is honest rather than defensive: a request with no address is a test
 * calling `serve` directly, and one shared bucket is the right answer for that.
 */
function clientAddress(request: Request, address: string, trustProxy: boolean): string {
  if (trustProxy) {
    const claimed = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (claimed !== undefined && claimed !== "") return claimed;
  }
  return address === "" ? "local" : address;
}

/**
 * Whether the session cookie is marked `Secure`.
 *
 * Derived rather than always true, because a `Secure` cookie on a plain-HTTP deployment is
 * a cookie the browser silently discards — and the symptom is signing in appearing to do
 * nothing, which is a miserable thing to debug at a venue. An operator behind TLS
 * termination sets `trustProxy` and the proto header decides; anyone else gets the answer
 * from the scheme they were actually reached on. `secure: true` in `AppOptions` overrides
 * both, for the deployment that knows better than either signal.
 */
function isSecure(request: Request, url: URL, trustProxy: boolean): boolean {
  if (trustProxy) {
    const proto = request.headers.get("x-forwarded-proto");
    if (proto !== null) return proto.split(",")[0]?.trim().toLowerCase() === "https";
  }
  return url.protocol === "https:";
}

/**
 * The event a route names, by id or by slug.
 *
 * Ids are recognisable, so the spelling is not ambiguous — but a slug shaped exactly like
 * an id would otherwise 404 while sitting in the table, so a miss falls through to the
 * slug lookup. That second read happens only on a miss, which is a request that was going
 * to be refused anyway.
 */
function resolveEvent(db: Db, reference: string): EventRow | undefined {
  return findEvent(db, reference) ?? findEventBySlug(db, reference);
}

/**
 * Note that a session was used, at most once a minute.
 *
 * `last_seen_at` exists so an organizer can see who is actually working, and a write per
 * request would mean a write every ten seconds per open dashboard — the meta-refresh in
 * `src/view/html.ts` makes that a real number rather than a hypothetical one. A minute's
 * resolution answers the question being asked and turns the page view back into a read.
 */
function freshen(ctx: Ctx, session: SessionRow, now: number): void {
  if (now - session.last_seen_at < MS.minute) return;
  touchSession(ctx, session.token_hash);
}

/**
 * The first frame of a stream, for the browser's spelling of a live operation.
 *
 * The iterator is closed afterwards rather than left suspended. A generator paused at a
 * `yield` still holds whatever it opened to produce that value, and here that is a
 * database statement — abandoning one per dashboard load is a leak that only shows up
 * after an hour of the event.
 */
async function firstFrame(frames: AsyncIterable<StreamEvent>): Promise<unknown> {
  const iterator = frames[Symbol.asyncIterator]();
  try {
    const first = await iterator.next();
    return first.done === true ? null : first.value.data;
  } finally {
    await iterator.return?.();
  }
}

/**
 * Every ledger entry a handler appended has to be one its command declared.
 *
 * `records` is published — it is in the reference page, the capability matrix and the
 * threat model — so a handler appending an action it did not declare has made the
 * documentation wrong, and there is no other moment anybody would notice. A 500 rather
 * than a 409: the caller did nothing, and there is nothing they could resend differently.
 *
 * It runs inside the dispatch transaction. Repository `recorded` scopes become savepoints,
 * so a declaration failure rolls back the command's complete write set instead of returning
 * a 500 after state has already changed.
 */
function assertRecordsDeclared(command: Command, appended: readonly LedgerEntry[]): void {
  if (appended.length === 0) return;
  const declared = new Set(command.records ?? []);
  const undeclared = [...new Set(appended.map((entry) => entry.action))].filter(
    (action) => !declared.has(action),
  );
  if (undeclared.length === 0) return;
  throw new DatabaseError(
    "ledger.undeclared",
    `${command.name} appended ${undeclared.join(", ")}, which its records declaration does ` +
      `not list. Add the action to the declaration or stop appending it.`,
  );
}

/** The 422 page for a form: the values that arrived, with the problems marked on them. */
function invalidForm(
  command: Command,
  target: Target,
  error: InputError,
  whoami: string | null,
  raw: RawInput,
): string {
  return formPage({
    command,
    // Back to the address it came from. The browser spelling of a POST route is the path
    // the browser just used, so a corrected submission cannot land somewhere else.
    formAction: target.pathname,
    title: command.form?.title ?? command.summary,
    whoami,
    prefill: prefillFromRaw(command.input, raw),
    problems: error.problems,
  });
}

/** The code for the log line. Null means nothing was refused. */
function codeOf(error: unknown): string | null {
  if (error instanceof InputError || error instanceof RuleError) return error.code;
  if (error instanceof DatabaseError) return error.code;
  return null;
}

/**
 * Whether this is a bug rather than an answer.
 *
 * `DatabaseError` is the odd one out among the declared types: it means this code sent the
 * schema something the schema refused, which is a stack trace worth keeping even though
 * the caller is told nothing but "500".
 */
function isUnexpected(error: unknown): boolean {
  if (error instanceof DatabaseError) return true;
  return !(error instanceof InputError || error instanceof RuleError);
}

/** A command's own page, or the generic rendering. Looked up by name, never by a field. */
async function boundedCertificateUpload(request: Request, limit: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) throw new RuleError("request.tooLarge", "Logo upload is too large.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new RuleError("request.tooLarge", "Logo upload is too large."); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function render(views: Views, context: ViewContext): string {
  const view: View = views[context.command.name] ?? genericPage;
  return view(context);
}
