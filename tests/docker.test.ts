/**
 * Automated Docker and Compose configuration tests.
 *
 * Verifies that the container environment is sound, reproducible, and secure:
 * - Dockerfile: pinned base image, unprivileged runtime, healthcheck, and zero-dependency packaging.
 * - compose.yaml: demo service, one-command test runner (test and test-all), volume mapping, and capability dropping.
 * - compose.offline.yaml: air-gap isolation network configuration.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("dockerfile exists and specifies pinned base image, healthcheck, and security boundaries", () => {
  const dockerfilePath = join(root, "Dockerfile");
  assert.ok(existsSync(dockerfilePath), "Dockerfile must exist at repository root");
  const text = readFileSync(dockerfilePath, "utf8");

  // Pinned sha256 digest on base image
  assert.match(text, /FROM node:22-alpine@sha256:[0-9a-f]{64}/, "Dockerfile must pin base image with sha256 digest");

  // Working directory
  assert.match(text, /WORKDIR \/app/, "Dockerfile must set WORKDIR to /app");

  // Non-root execution and security
  assert.match(text, /COPY --chown=node:node/, "Dockerfile must copy application files with node ownership");
  const users = text.split(/\r?\n/).filter((line) => /^USER\s+/.test(line));
  assert.equal(users.at(-1), "USER node", "The effective image user must stay unprivileged even when Compose overrides CMD");
  assert.match(text, /^CMD \["node",/m, "Node must receive stop signals directly without a privileged startup shell");

  // Healthcheck endpoint
  assert.match(text, /HEALTHCHECK.*\/api\/healthz/, "Dockerfile must declare a HEALTHCHECK probing /api/healthz");

  // Exposed port
  assert.match(text, /EXPOSE 8080/, "Dockerfile must expose port 8080");
});

test("compose.yaml defines demo, one-command test runner, and security options", () => {
  const composePath = join(root, "compose.yaml");
  assert.ok(existsSync(composePath), "compose.yaml must exist at repository root");
  const text = readFileSync(composePath, "utf8");

  // Primary service
  assert.match(text, /manak:/, "compose.yaml must define 'manak' service");
  assert.match(text, /8080:8080/, "compose.yaml must map port 8080");
  assert.match(text, /manak-data:\/data/, "compose.yaml must mount persistent volume to /data");

  // One-command test services
  assert.match(text, /test:/, "compose.yaml must define 'test' service for one-command test runs");
  assert.match(text, /npm.*test/, "compose.yaml test service must execute npm test");
  assert.match(text, /test-all:/, "compose.yaml must define 'test-all' service for full suite and proofs");

  // Linux capabilities & privilege escalation
  assert.match(text, /cap_drop:\s*\["ALL"\]/, "compose.yaml must drop all capabilities");
  assert.match(text, /security_opt:\s*\["no-new-privileges:true"\]/, "compose.yaml must forbid privilege escalation");
});

test("compose.offline.yaml defines strict air-gap network boundary", () => {
  const offlinePath = join(root, "compose.offline.yaml");
  assert.ok(existsSync(offlinePath), "compose.offline.yaml must exist at repository root");
  const text = readFileSync(offlinePath, "utf8");

  assert.match(text, /networks:\s*default:\s*internal:\s*true/s, "compose.offline.yaml must configure internal: true to disable egress");
});
