import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judged, ORIGIN } from "./support/judged.ts";
import { correctCertificate, verifyCertificate } from "../src/db/cert.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=", "base64");

test("organizer designs, uploads, issues, shares and revokes a signed certificate", async () => {
  const rig = judged();
  const dir = mkdtempSync(join(tmpdir(), "manak-studio-"));
  const priorDir = process.env.MANAK_KEY_DIR;
  process.env.MANAK_KEY_DIR = dir;
  const slug = rig.world.event.slug;
  const base = `/events/${slug}/certificates`;
  const organizer = rig.principals.find((p) => p.label === "organizer")!;
  const auth = { authorization: `Bearer ${organizer.token}` };
  const serve = (path: string, init: RequestInit = {}) => rig.serve(new Request(`${ORIGIN}${path}`, init), "203.0.113.9");
  try {
    const noAccess = await serve(`${base}/studio`);
    assert.equal(noAccess.status, 401);
    const studio = await serve(`${base}/studio`, { headers: auth });
    assert.equal(studio.status, 200, await studio.clone().text());
    assert.match(await studio.text(), /Certificate studio/);

    const publish = await serve(`/api/events/${slug}/results/publish`, {
      method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}",
    });
    assert.equal(publish.status, 200, await publish.clone().text());
    const text = new URLSearchParams({ heading: "Festival of Ideas", body: "For practical creativity.",
      footer: "With gratitude", signatory: "The Jury" });
    const save = await serve(`${base}/template`, { method: "POST",
      headers: { ...auth, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: text });
    assert.equal(save.status, 303, await save.clone().text());
    assert.equal(save.headers.get("location"), `${base}/studio`);

    const form = new FormData();
    form.set("logo", new File([PNG], "logo.png", { type: "image/png" }));
    const upload = await serve(`${base}/logo`, { method: "POST", headers: { ...auth, origin: ORIGIN }, body: form });
    assert.equal(upload.status, 303, await upload.clone().text());
    const wrong = new FormData();
    wrong.set("logo", new File(["<svg></svg>"], "logo.svg", { type: "image/svg+xml" }));
    const rejected = await serve(`${base}/logo`, { method: "POST", headers: { ...auth, origin: ORIGIN }, body: wrong });
    assert.equal(rejected.status, 415);

    const issue = await serve(`/api${base}`, {
      method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}",
    });
    assert.equal(issue.status, 200, await issue.clone().text());
    const report = await issue.json() as { certificates: { serial: string; presentation: { heading: string; logoSha256: string }; recipientEmail: string; signature: string }[]; publicKeyPem: string };
    const first = report.certificates[0]!;
    assert.equal(first.presentation.heading, "Festival of Ideas");
    assert.match(first.presentation.logoSha256, /^[0-9a-f]{64}$/);
    assert.ok(verifyCertificate(first as never, report.publicKeyPem));
    assert.equal(verifyCertificate({ ...first, presentation: { ...first.presentation, heading: "Forged" } } as never, report.publicKeyPem), false);

    const share = `${base}/${encodeURIComponent(first.serial)}`;
    const publicPage = await serve(share);
    assert.equal(publicPage.status, 200, await publicPage.clone().text());
    const markup = await publicPage.text();
    assert.match(markup, /Festival of Ideas/);
    assert.match(markup, /Signature verified/);
    assert.ok(!markup.includes(first.recipientEmail));
    const svg = await serve(`${share}.svg`);
    assert.equal(svg.status, 200, await svg.clone().text());
    assert.match(svg.headers.get("content-type") ?? "", /image\/svg\+xml/);
    assert.match(await svg.text(), /Festival of Ideas/);

    const editAfter = await serve(`${base}/template`, { method: "POST",
      headers: { ...auth, "content-type": "application/x-www-form-urlencoded" }, body: text });
    assert.equal(editAfter.status, 409);
    correctCertificate(rig.world.asOrganizer, rig.world.event.id, first.serial, "revoke", "Incorrect record", undefined, dir);
    const revoked = await serve(share);
    assert.equal(revoked.status, 200);
    assert.match(await revoked.text(), /Revoked/);
    assert.equal((await serve(`${share}.svg`)).status, 404);
  } finally {
    if (priorDir === undefined) delete process.env.MANAK_KEY_DIR; else process.env.MANAK_KEY_DIR = priorDir;
    rig.close(); rmSync(dir, { recursive: true, force: true });
  }
});
