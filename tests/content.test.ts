import test from "node:test";
import assert from "node:assert/strict";
import { judged, ORIGIN } from "./support/judged.ts";
import { exportCsv } from "../src/db/csv.ts";
import { mediaImage } from "../src/view/media.ts";

test("rich submissions persist, search, export and render safely through the public API", async () => {
  const rig = judged();
  try {
    rig.world.clock.set(rig.world.event.submissions_open_at + 1);
    const participant = rig.principals.find((p) => p.label === "participant")!;
    const base = `/api/events/${rig.world.event.slug}/projects`;
    const post = (path: string, body: unknown) => rig.serve(new Request(`${ORIGIN}${path}`, {
      method: "POST", headers: { authorization: `Bearer ${participant.token}`, "content-type": "application/json" }, body: JSON.stringify(body),
    }), "203.0.113.60");
    const payload = { title: "New evidence", summary: "A usable submission", tagline: "Built with care",
      description: "<script>danger</script>\nLong project story", techTags: "Rust, rare-find-tag",
      thumbnailUrl: "https://example.com/cover.png", imageUrls: "https://example.com/screen.png",
      videoUrl: "https://example.com/demo", answers: "We used a local database." };
    const created = await post(base, payload);
    assert.equal(created.status, 200, await created.clone().text());
    const project = (await created.json() as { project: { id: string; description: string; tagline: string } }).project;
    assert.equal(project.tagline, payload.tagline);
    assert.equal(project.description, payload.description);
    assert.notEqual((await rig.get(`${base}/${project.id}`)).status, 200);
    assert.equal((await post(`${base}/${project.id}/submit`, {})).status, 200);
    const search = await rig.json(`${base}?q=rare-find-tag`);
    assert.equal((search.projects as { id: string }[])[0]!.id, project.id);
    const html = await rig.html(`/events/${rig.world.event.slug}/projects/${project.id}`);
    assert.match(html, /&lt;script&gt;danger&lt;\/script&gt;/);
    assert.match(html, /referrerpolicy="no-referrer"/);
    assert.match(exportCsv(rig.world.db, rig.world.event.id, "projects"), /rare-find-tag/);
    const invalid = await post(`${base}/${project.id}`, { ...payload, imageUrls: "javascript:alert(1)" });
    assert.equal(invalid.status, 422);
    rig.world.clock.set(rig.world.event.submissions_close_at);
    assert.equal((await post(`${base}/${project.id}`, payload)).status, 409);
  } finally { rig.close(); }
});

test("imported media cannot activate script URLs or credential-bearing URLs", () => {
  assert.equal(mediaImage("javascript:alert(1)", "test"), "");
  assert.equal(mediaImage("https://user:secret@example.com/img", "test"), "");
  assert.equal(mediaImage("data:image/svg+xml,anything", "test"), "");
  assert.match(mediaImage("https://example.com/image.png", '<img onerror="x">'), /alt="&lt;img onerror=&quot;x&quot;&gt;"/);
});
