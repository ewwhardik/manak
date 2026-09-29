import test from "node:test";
import assert from "node:assert/strict";

import { ALL_COMMANDS } from "../src/api/commands/index.ts";
import { makeRegistry } from "../src/api/index.ts";
import { makeApp } from "../src/http/app.ts";
import { world } from "./support/world.ts";

test("the embed script mounts a sandboxed iframe and validates resize messages", async () => {
  const w = world();
  try {
    const serve = makeApp({ db: w.db, registry: makeRegistry(ALL_COMMANDS), publicOrigin: "https://portal.test" });
    const response = await serve(new Request("https://portal.test/embed.js"));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /javascript/);
    const script = await response.text();
    assert.match(script, /sandbox/);
    assert.match(script, /allow-scripts allow-same-origin allow-popups/);
    assert.match(script, /event\.origin!==url\.origin/);
    assert.match(script, /event\.source!==iframe\.contentWindow/);
    assert.match(script, /manak:embed:height/);
    assert.match(script, /Math\.max\(120,Math\.min\(10000/);
  } finally {
    w.close();
  }
});

test("embed frame is public, nonce-CSP protected, and frameable without X-Frame-Options", async () => {
  const w = world();
  try {
    const serve = makeApp({ db: w.db, registry: makeRegistry(ALL_COMMANDS), publicOrigin: "https://portal.test" });
    const response = await serve(new Request(
      `https://portal.test/embed/${encodeURIComponent(w.event.slug)}?parentOrigin=https%3A%2F%2Fhost.example`,
    ));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(response.headers.get("x-frame-options"), null);
    const policy = response.headers.get("content-security-policy") ?? "";
    assert.match(policy, /frame-ancestors \*/);
    assert.match(policy, /connect-src 'self'/);
    const body = await response.text();
    const nonce = /<script nonce="([a-f0-9]+)">/.exec(body)?.[1];
    assert.ok(nonce);
    assert.ok(policy.includes(`script-src 'nonce-${nonce}'`));
    assert.ok(body.includes('var eventSlug="dogfood-2026", parentOrigin="https://host.example"'));
    assert.match(body, /ResizeObserver/);
    assert.match(body, /event\.source!==window\.parent\|\|event\.origin!==parentOrigin/);
    assert.match(body, /escapeHtml\(project\.title\)/);
    assert.match(body, /credentials:'omit'/);
  } finally {
    w.close();
  }
});

test("embed frame rejects unknown events and malformed encoded slugs", async () => {
  const w = world();
  try {
    const serve = makeApp({ db: w.db, registry: makeRegistry(ALL_COMMANDS), publicOrigin: "https://portal.test" });
    assert.equal((await serve(new Request("https://portal.test/embed/no-such-event"))).status, 404);
    assert.equal((await serve(new Request("https://portal.test/embed/%E0%A4%A"))).status, 404);
    assert.equal((await serve(new Request("https://portal.test/embed.js", { method: "POST" }))).status, 405);
  } finally {
    w.close();
  }
});

test("embed route /embed/events/:slug serves responsive zero-JS showcase without scripts", async () => {
  const w = world();
  try {
    const serve = makeApp({ db: w.db, registry: makeRegistry(ALL_COMMANDS), publicOrigin: "https://portal.test" });
    const response = await serve(new Request(
      `https://portal.test/embed/events/${encodeURIComponent(w.event.slug)}`,
    ));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(response.headers.get("x-frame-options"), null);
    const policy = response.headers.get("content-security-policy") ?? "";
    assert.match(policy, /default-src 'none'/);
    assert.match(policy, /frame-ancestors \*/);
    const body = await response.text();
    // Zero-JS guarantee: No <script> tag present in the document
    assert.equal(body.includes("<script"), false);
    assert.match(body, /Project Showcase/);
    assert.match(body, /class="gallery"/);
    assert.match(body, /class="project"/);
  } finally {
    w.close();
  }
});
