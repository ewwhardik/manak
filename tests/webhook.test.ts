import test from "node:test";
import assert from "node:assert/strict";

import {
  WebhookDispatcher,
  signWebhookPayload,
} from "../src/db/index.ts";

test("HMAC webhook signature matches expected sha256 hex", () => {
  const payload = JSON.stringify({ action: "project.created", test: true });
  const secret = "super-secret-key-123";
  const sig = signWebhookPayload(payload, secret);
  assert.ok(/^[0-9a-f]{64}$/.test(sig), "Signature must be 64-char hex");
  assert.equal(sig, signWebhookPayload(payload, secret), "Signature must be deterministic");
});

test("WebhookDispatcher dispatches events with HMAC signature and retries on failure", async () => {
  const sentRequests: { url: string; headers: Record<string, string>; body: string }[] = [];
  let failCount = 2; // Fail twice then succeed on 3rd attempt

  const dispatcher = new WebhookDispatcher({
    sender: async (url, headers, body) => {
      sentRequests.push({ url, headers, body });
      if (failCount > 0) {
        failCount -= 1;
        return { status: 500, ok: false, error: "Transient gateway error" };
      }
      return { status: 200, ok: true };
    },
  });

  const sub = dispatcher.register({
    url: "https://example.com/webhook",
    secret: "test-secret",
    active: true,
  });

  const deliveries = await dispatcher.dispatch({
    eventId: "evt-1",
    action: "ballot.submitted",
    subject: "proj-1",
    payload: { score: 95 },
  });

  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.status, "delivered");
  assert.equal(deliveries[0]?.attempts, 3);
  assert.equal(sentRequests.length, 3);
  assert.ok(sentRequests[0]?.headers["X-Manak-Signature"]?.startsWith("sha256="));
  assert.equal(sentRequests[0]?.headers["X-Manak-Event"], "ballot.submitted");

  const logs = dispatcher.deliveryLog(sub.id);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.status, "delivered");
});
