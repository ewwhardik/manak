/**
 * Who may invoke an operation, declared once so it can be published and proved.
 *
 * Access control that lives inside handlers is access control nobody can audit: the
 * only way to answer "who can read another team's submission" is to read every
 * handler and trust that none of them forgot. Declaring it beside the operation makes
 * the answer a table — one this module generates, the documentation prints, and
 * `npm run prove:isolation` executes against a running server.
 *
 * Two decisions carry most of the weight here.
 *
 * **Roles are not a hierarchy.** An organizer is not implicitly a judge. The reason is
 * arithmetic rather than principle: an organizer who can enter a ballot as themselves
 * becomes an extra judge that the normalization has no way to distinguish from an
 * invited one, and a leniency correction computed over a phantom judge is wrong for
 * everybody. Where an organizer genuinely needs to act on a judge's behalf there is a
 * separate path that records `ballot.entered_on_behalf`, so the ledger shows a human
 * did it and for whom.
 *
 * **Not yours means not found.** A caller with no membership in an event is told the
 * event does not exist, not that they are forbidden from it. A 403 is an admission
 * that the resource is real, and across events that admission is the leak: an
 * organizer of one hackathon should not be able to enumerate another's projects by
 * watching which ids answer 403 and which answer 404. Once a caller holds any role in
 * the event the admission is already made, and 403 becomes the honest answer — it
 * tells them to ask for the right role rather than doubt the URL.
 *
 * **Founding an event is an operator's decision, not a user's.** Anybody can obtain an
 * account here — that is what a magic link to an arbitrary address means — so `account`
 * cannot be the audience for creating an event, or the first person to find a self-hosted
 * portal could fill it with their own hackathons. `founder` is the audience for the
 * handful of operations that bring an event into existence, and it is held by accounts
 * whose address the operator named at boot. It is deliberately not a role and not stored:
 * a founder list in the database would be a privilege escalation target, and a founder
 * list in the environment is revoked by a restart.
 *
 * A refused founder is told 403 rather than 404, which looks like an exception to the rule
 * above and is not. "Not found" hides the existence of *somebody else's* event. There is
 * no other tenant here to hide — the route is in the published document, the matrix says
 * plainly that founders may call it, and pretending it does not exist would only make an
 * operator debug a 404 that means "your address is not in the list".
 */

import type { Role } from "../db/index.ts";

/**
 * Every audience an operation can be declared for, widest first.
 *
 * `founder` sits between `account` and the roles because that is where it sits in size,
 * not because it is a rank: it is a fact about the deployment's configuration, while the
 * three after it are facts about one event. Nothing is implied by the order.
 */
export const AUDIENCES = ["public", "account", "founder", "participant", "judge", "organizer"] as const;
export type Audience = (typeof AUDIENCES)[number];

/**
 * Row-level ownership, which a role cannot express.
 *
 * Being a participant in an event does not make somebody's project yours to edit. The
 * handler proves the narrower claim, and declaring it here is what puts the obligation
 * in the matrix instead of in a reviewer's memory.
 */
export const OWNERSHIPS = ["team", "judge", "account"] as const;
export type Ownership = (typeof OWNERSHIPS)[number];

/** A window that has to be open. Checked before the handler runs, never inside it. */
export type Gate = "submissions" | "judging" | "results";

export type Capability = {
  readonly audience: Audience;
  /**
   * The input field carrying the event this call is scoped to. Mandatory whenever the
   * audience is a role, because there is no such thing as being an organizer in
   * general — only an organizer of something.
   */
  readonly scope?: string;
  readonly owner?: Ownership;
  readonly gate?: Gate;
};

/** The caller, reduced to the three facts an access decision turns on. */
export type Principal = {
  readonly accountId: string | null;
  /** Roles held in the scoped event. Empty for a stranger and for an unscoped call. */
  readonly roles: readonly Role[];
  /**
   * Whether the operator named this caller's address as a founder.
   *
   * A property of the running configuration rather than of the account, which is why it
   * arrives here as a boolean instead of being looked up: this function stays pure, and
   * the only place that reads the list is the transport layer that already has the
   * account's address in hand.
   */
  readonly founder: boolean;
};

export const ANONYMOUS: Principal = { accountId: null, roles: [], founder: false };

/**
 * The cookie a browser presents a session in: one name shared by the server and the
 * published document, defined here because it is how a principal arrives.
 *
 * Not `__Host-` prefixed, and that is a deliberate trade. The prefix would pin the
 * cookie to one host and forbid it from ever being set without `Secure`, which is
 * strictly better — on HTTPS. It also makes the cookie impossible over plain HTTP
 * anywhere but localhost, and a self-hosted portal reached at `http://nas:8080` on
 * somebody's own network is a deployment this project promises to support. `Secure` is
 * set when the request arrives over TLS instead, which is the same protection where it
 * is available and a working sign-in where it is not.
 */
export const SESSION_COOKIE = "manak_session";

export type Refusal = "unauthenticated" | "forbidden" | "notFound";

export type Decision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly refusal: Refusal; readonly because: string };

const ALLOWED: Decision = { allowed: true };

/** True when the audience names a role rather than a class of caller. */
export function isRoleAudience(audience: Audience): boolean {
  return audience !== "public" && audience !== "account" && audience !== "founder";
}

/** The role an audience demands, or null when it demands only a session. */
export function requiredRole(capability: Capability): Role | null {
  return isRoleAudience(capability.audience) ? (capability.audience as Role) : null;
}

/**
 * The whole access decision, as a pure function of the declaration and the caller.
 *
 * Pure on purpose: no database, no request, no clock. The isolation proof asserts that
 * a live server agrees with this function, which is only a meaningful assertion
 * because this function can be enumerated exhaustively in a unit test.
 *
 * Existence is the caller's problem, not this function's. A dispatcher that cannot
 * find the scoped event answers 404 before asking anything here, because a capability
 * check on a nonexistent event has no answer worth giving.
 */
export function decide(capability: Capability, principal: Principal): Decision {
  if (capability.audience === "public") return ALLOWED;
  if (principal.accountId === null) {
    return {
      allowed: false,
      refusal: "unauthenticated",
      because: "this operation needs somebody signed in.",
    };
  }
  if (capability.audience === "account") return ALLOWED;
  if (capability.audience === "founder") {
    if (principal.founder) return ALLOWED;
    // 403 rather than 404: see the header. There is no other tenant whose existence this
    // could leak, and an operator whose address is missing from the list needs to be told
    // that, not sent to look for a typo in the URL.
    return {
      allowed: false,
      refusal: "forbidden",
      because: "this operation is limited to the addresses the operator named as founders.",
    };
  }
  const role = capability.audience as Role;
  if (principal.roles.length === 0) {
    // No membership at all, so the event is not this caller's to know about. See the
    // header: the refusal is deliberately indistinguishable from a wrong id.
    return {
      allowed: false,
      refusal: "notFound",
      because: "the caller holds no role in this event, so the event is not visible.",
    };
  }
  if (!principal.roles.includes(role)) {
    return {
      allowed: false,
      refusal: "forbidden",
      because: `the caller is in this event but not as ${role}.`,
    };
  }
  return ALLOWED;
}

/**
 * The witnesses the matrix is computed over, and the isolation proof impersonates.
 *
 * `stranger` is a signed-in account with no role in the event, which is also exactly
 * how an organizer of a *different* event presents itself — same account, no
 * membership here. That collapse is the isolation claim rather than a simplification:
 * if the two were distinguishable, one of them could tell events apart.
 *
 * `founder` is a signed-in account the operator named and which holds no role in the
 * event, so its column shows what the configuration alone buys — nothing but the right to
 * bring an event into existence. The three role witnesses are deliberately *not* founders,
 * which is what makes their 403 on a founding operation visible in the published table.
 */
export const WITNESSES = [
  "anonymous",
  "stranger",
  "founder",
  "participant",
  "judge",
  "organizer",
] as const;
export type Witness = (typeof WITNESSES)[number];

const WITNESS_ROLES: Readonly<Record<Witness, readonly Role[]>> = {
  anonymous: [],
  stranger: [],
  founder: [],
  participant: ["participant"],
  judge: ["judge"],
  organizer: ["organizer"],
};

/** A principal standing in for a witness. The id is opaque and never read. */
export function principalFor(witness: Witness, accountId = "witness"): Principal {
  return {
    accountId: witness === "anonymous" ? null : accountId,
    roles: WITNESS_ROLES[witness],
    founder: witness === "founder",
  };
}

export type Cell = "allow" | Refusal;

/** The minimum a matrix row needs to know about an operation. */
export type Operation = {
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly capability: Capability;
};

export type MatrixRow = {
  readonly name: string;
  readonly route: string;
  readonly audience: Audience;
  readonly owner?: Ownership;
  readonly gate?: Gate;
  readonly cells: Readonly<Record<Witness, Cell>>;
};

export function cellsFor(capability: Capability): Record<Witness, Cell> {
  const cells = {} as Record<Witness, Cell>;
  for (const witness of WITNESSES) {
    const decision = decide(capability, principalFor(witness));
    cells[witness] = decision.allowed ? "allow" : decision.refusal;
  }
  return cells;
}

export function capabilityMatrix(operations: readonly Operation[]): MatrixRow[] {
  return operations.map((operation) => ({
    name: operation.name,
    route: `${operation.method} ${operation.path}`,
    audience: operation.capability.audience,
    ...(operation.capability.owner ? { owner: operation.capability.owner } : {}),
    ...(operation.capability.gate ? { gate: operation.capability.gate } : {}),
    cells: cellsFor(operation.capability),
  }));
}

/**
 * The matrix as a Markdown table, for the documentation and the proof's own report.
 *
 * `allow` is left blank-ish on purpose — a table where the interesting cells are the
 * refusals reads better if the refusals are what stand out.
 */
export function matrixMarkdown(rows: readonly MatrixRow[]): string {
  const header = ["Operation", "Route", "Needs", ...WITNESSES];
  const symbol: Readonly<Record<Cell, string>> = {
    allow: "yes",
    unauthenticated: "401",
    forbidden: "403",
    notFound: "404",
  };
  const body = rows.map((row) => {
    const needs = [
      row.audience,
      ...(row.owner ? [`own ${row.owner}`] : []),
      ...(row.gate ? [`${row.gate} open`] : []),
    ].join(", ");
    return [row.name, `\`${row.route}\``, needs, ...WITNESSES.map((w) => symbol[row.cells[w]])];
  });
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...body.map((row) => (row[index] as string).length)),
  );
  const line = (cells: readonly string[]): string =>
    `| ${cells.map((cell, index) => cell.padEnd(widths[index] as number)).join(" | ")} |`;
  return [
    line(header),
    `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`,
    ...body.map(line),
  ].join("\n");
}
