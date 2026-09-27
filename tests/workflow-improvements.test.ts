import test from "node:test";
import assert from "node:assert/strict";
import { judged } from "./support/judged.ts";

test("assignment preview is organizer-only, renders coverage and never writes", async () => {
  const rig = judged();
  try {
    const endpoint = `/api/events/${rig.world.event.slug}/assignments/preview`;
    const organizer = rig.principals.find(p => p.label === "organizer")!;
    const count = () => rig.world.db.one<{ n: number }>("select count(*) as n from ledger").n;
    const before = count();
    const result = await rig.json(endpoint, organizer);
    assert.equal(result.applied, false);
    assert.ok(Number(result.assignments) > 0);
    const html = await rig.html(endpoint.replace("/api", ""), organizer);
    assert.match(html, /Apply assignments/);
    assert.match(html, /No assignments have changed/);
    assert.equal(count(), before);
    for (const principal of rig.principals.filter(p => p !== organizer)) {
      assert.ok([401,403].includes((await rig.get(endpoint, principal)).status));
    }
  } finally { rig.close(); }
});

test("empty draft can be saved but incomplete final review is refused", async () => {
  const rig = judged();
  try {
    const judge = rig.principals.find(p => p.label === "judge")!;
    const endpoint = `/api/events/${rig.world.event.slug}/projects/${rig.world.projects[0]!.id}/ballot`;
    const post = (draft: boolean) => rig.serve(new Request(`https://portal.test${endpoint}`, {
      method: "POST", headers: { authorization: `Bearer ${judge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ draft, comment: "Still reviewing" }),
    }), "203.0.113.9");
    const draft = await post(true);
    assert.equal(draft.status, 200, await draft.clone().text());
    const final = await post(false);
    assert.ok([409,422].includes(final.status), await final.text());
    const html = await rig.html(`/events/${rig.world.event.slug}/judging`, judge);
    assert.match(html, /formnovalidate/);
    assert.match(html, /Save draft/);
    assert.match(html, /Submit review/);
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
    assert.equal(new Set(ids).size, ids.length, "all controls have unique IDs");
  } finally { rig.close(); }
});
