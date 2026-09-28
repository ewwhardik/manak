import assert from "node:assert/strict";
import test from "node:test";
import { arenaArt, eventJourney } from "../src/view/arena.ts";
import { STYLESHEET } from "../src/view/style.ts";
import { page } from "../src/view/html.ts";

test("landing globe is local, pausable, and has a reduced-motion state", () => {
  const art = arenaArt();
  assert.match(art, /class="globe-sphere"/);
  assert.match(art, /class="globe-land"/);
  assert.match(art, /id="pause-orbit"/);
  assert.doesNotMatch(art, /https?:\/\//);
  assert.match(STYLESHEET, /animation-timeline: view\(block\)/);
  assert.match(STYLESHEET, /\.globe-scene, \.globe-sphere \{ animation: none !important/);
});

test("event stages show a direct path only for a role allowed to use it", () => {
  const clock = { submissionsOpenAt: 10, submissionsCloseAt: 20, judgingOpenAt: 30, judgingCloseAt: 40 };
  const visitor = eventJourney(clock, 35, { slug: "demo", roles: [], resultsPublic: false });
  assert.match(visitor, /Set up/);
  assert.match(visitor, /Submissions/);
  assert.match(visitor, /Judging/);
  assert.match(visitor, /Results/);
  assert.match(visitor, /Certificates/);
  assert.doesNotMatch(visitor, /href="\/events\/demo\/judging"/);
  assert.doesNotMatch(visitor, /href="\/events\/demo\/results"/);
  const judge = eventJourney(clock, 35, { slug: "demo", roles: ["judge"], resultsPublic: false });
  assert.match(judge, /href="\/events\/demo\/judging"/);
  const organizer = eventJourney(clock, 35, { slug: "demo", roles: ["organizer"], resultsPublic: false });
  assert.match(organizer, /href="\/events\/demo\/dashboard"/);
  assert.match(organizer, /href="\/events\/demo\/certificates"/);
});

test("shared navigation identifies the current workspace section", () => {
  const mine = page({ title: "Your events", trail: [{ label: "Events", href: "/" }, { label: "Yours" }], whoami: "Demo", body: "" });
  assert.match(mine, /href="\/mine" aria-current="page"/);
  const event = page({ title: "Demo event", trail: [{ label: "Demo event", href: "/events/demo" }, { label: "Judging" }], body: "" });
  assert.match(event, /href="\/events" aria-current="location"/);
});
