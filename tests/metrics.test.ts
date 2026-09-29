import test from "node:test";
import assert from "node:assert/strict";
import { ALL_COMMANDS } from "../src/api/commands/index.ts";
import { makeRegistry } from "../src/api/registry.ts";
import { makeApp } from "../src/http/app.ts";
import { world } from "./support/world.ts";

test("Prometheus endpoint exposes cumulative latency buckets and database gauges", async () => {
  const w = world();
  try {
    const serve = makeApp({ db: w.db, registry: makeRegistry(ALL_COMMANDS),
      publicOrigin: "https://portal.test", clock: w.clock });
    const get = (path: string) => serve(new Request(`https://portal.test${path}`));
    assert.equal((await get("/api/healthz")).status, 200);
    assert.equal((await get("/does-not-exist")).status, 404);
    const response = await get("/metrics");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/plain; version=0\.0\.4/);
    const body = await response.text();
    assert.match(body, /http_requests_total\{method="GET",status="200"\} 1/);
    assert.match(body, /http_requests_total\{method="GET",status="404"\} 1/);
    assert.match(body, /http_request_duration_ms_bucket\{method="GET",status="200",le="\+Inf"\} 1/);
    assert.match(body, /manak_active_sessions \d+/);
    assert.match(body, /manak_completed_reviews_total\{event="[^\"]+"\} \d+/);
    assert.match(body, /nodejs_heap_used_bytes \d+/);
    assert.equal((await serve(new Request("https://portal.test/metrics", { method: "POST" }))).status, 405);
  } finally { w.close(); }
});
