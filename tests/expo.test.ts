import test from "node:test";
import assert from "node:assert/strict";

import { allocateBooths, optimizeJudgeRoutes } from "../src/judging/index.ts";

test("allocateBooths numbers projects and groups by track", () => {
  const projects = [
    { id: "p1", trackKey: "web3" },
    { id: "p2", trackKey: "ai" },
    { id: "p3", trackKey: "ai" },
    { id: "p4", trackKey: "web3" },
  ];

  const booths = allocateBooths(projects, { prefix: "Booth ", startNumber: 101, groupByTrack: true });

  assert.equal(booths.length, 4);
  // AI track should be grouped first
  assert.equal(booths[0]?.project, "p2");
  assert.equal(booths[0]?.tableName, "Booth 101");
  assert.equal(booths[1]?.project, "p3");
  assert.equal(booths[1]?.tableName, "Booth 102");

  // Web3 track grouped next
  assert.equal(booths[2]?.project, "p1");
  assert.equal(booths[2]?.tableName, "Booth 103");
  assert.equal(booths[3]?.project, "p4");
  assert.equal(booths[3]?.tableName, "Booth 104");
});

test("optimizeJudgeRoutes sorts booth visits and minimizes floor transit", () => {
  const booths = [
    { project: "p1", trackKey: "ai", tableNumber: 10, tableName: "Table 10" },
    { project: "p2", trackKey: "ai", tableNumber: 2, tableName: "Table 2" },
    { project: "p3", trackKey: "ai", tableNumber: 25, tableName: "Table 25" },
    { project: "p4", trackKey: "ai", tableNumber: 5, tableName: "Table 5" },
  ];

  // Judge j1 is assigned p1 (table 10), p2 (table 2), and p3 (table 25) in arbitrary order
  const assignments = [
    { judge: "j1", project: "p3" },
    { judge: "j1", project: "p1" },
    { judge: "j1", project: "p2" },
  ];

  const tours = optimizeJudgeRoutes(assignments, booths);
  assert.equal(tours.length, 1);
  const j1Tour = tours[0]!;
  assert.equal(j1Tour.judge, "j1");

  // Ordered route should visit Table 2 -> Table 10 -> Table 25
  assert.equal(j1Tour.stops[0]?.tableNumber, 2);
  assert.equal(j1Tour.stops[1]?.tableNumber, 10);
  assert.equal(j1Tour.stops[2]?.tableNumber, 25);

  // Total transit distance: |10 - 2| + |25 - 10| = 8 + 15 = 23
  assert.equal(j1Tour.totalTransitDistance, 23);
});
