import test from "node:test";
import assert from "node:assert/strict";

import { parseCsvLine, parseDevpostCsv } from "../tools/import-devpost.ts";

test("parseCsvLine handles quotes, commas, and escapes", () => {
  const line = `Project A,"A fast, lightweight tool","Long description with, comma",https://github.com/a`;
  const parsed = parseCsvLine(line);
  assert.equal(parsed.length, 4);
  assert.equal(parsed[0], "Project A");
  assert.equal(parsed[1], "A fast, lightweight tool");
  assert.equal(parsed[2], "Long description with, comma");
  assert.equal(parsed[3], "https://github.com/a");
});

test("parseDevpostCsv maps standard Devpost export headers into Manak projects", () => {
  const csv = `Project Title,Tagline,About The Project,Built With,Repository,Video Demo,Track,Team Members
"HyperGrid","Decentralized resilient microgrid balancer","An autonomous microgrid system","TypeScript, Node.js, SQLite","https://github.com/hypergrid","https://youtu.be/hg","Sustainability","Elena, Marcus"
"NeuroPulse","Cognitive exhaustion tracker","Tracks ICU staff fatigue","Python, PyTorch","https://github.com/np","","HealthTech","Sarah"
`;

  const report = parseDevpostCsv(csv);
  assert.equal(report.validProjects, 2);
  assert.equal(report.skippedRows, 0);
  assert.deepEqual(report.tracks, ["healthtech", "sustainability"]);
  assert.ok(report.tags.includes("typescript"));
  assert.ok(report.tags.includes("python"));

  const p1 = report.projects[0]!;
  assert.equal(p1.name, "HyperGrid");
  assert.equal(p1.track, "sustainability");
  assert.equal(p1.repoUrl, "https://github.com/hypergrid");
  assert.equal(p1.demoUrl, "https://youtu.be/hg");
  assert.deepEqual(p1.teamMembers, ["Elena", "Marcus"]);
});
