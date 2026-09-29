import test from "node:test";
import assert from "node:assert/strict";
import {
  tokenizeText,
  vectorizeCorpus,
  cosineSimilarity,
  compareTexts,
  findRivals,
} from "../src/judging/index.ts";

test("tokenizeText strips punctuation and stop words", () => {
  const tokens = tokenizeText("The quick brown fox jumps over the lazy dog in a hackathon project!");
  assert.ok(!tokens.includes("the"));
  assert.ok(!tokens.includes("in"));
  assert.ok(!tokens.includes("a"));
  assert.ok(!tokens.includes("project"));
  assert.ok(tokens.includes("quick"));
  assert.ok(tokens.includes("brown"));
  assert.ok(tokens.includes("fox"));
});

test("vectorizeCorpus produces non-empty vectors for non-empty text", () => {
  const docs = [
    { id: "1", text: "Autonomous drone navigation using edge computer vision and sensors" },
    { id: "2", text: "Computer vision and neural networks for autonomous vehicle obstacle detection" },
    { id: "3", text: "Decentralized liquidity pool smart contract on EVM blockchain" },
  ];
  const vectors = vectorizeCorpus(docs);
  assert.equal(vectors.size, 3);
  assert.ok(vectors.get("1")!.norm > 0);
  assert.ok(vectors.get("2")!.norm > 0);
  assert.ok(vectors.get("3")!.norm > 0);
});

test("cosineSimilarity correctly distinguishes thematic overlap from unrelated topics", () => {
  const doc1 = "Decentralized automated market maker on Ethereum blockchain with zero slippage";
  const doc2 = "Decentralized lending protocol on Ethereum smart contracts with yield farming";
  const doc3 = "Organic hydroponic greenhouse monitoring with soil moisture sensor network";

  const cryptoComp = compareTexts(doc1, doc2);
  const crossComp = compareTexts(doc1, doc3);

  assert.ok(cryptoComp.similarity > 0.15, `expected crypto overlap > 0.15, got ${cryptoComp.similarity}`);
  assert.ok(crossComp.similarity < 0.05, `expected cross domain similarity < 0.05, got ${crossComp.similarity}`);
  assert.ok(cryptoComp.sharedKeywords.includes("ethereum") || cryptoComp.sharedKeywords.includes("decentralized"));
});

test("findRivals ranks closest matching project first", () => {
  const target = { id: "alpha", text: "Real-time speech translation and voice synthesis AI" };
  const candidates = [
    target,
    { id: "beta", text: "Deep learning speech recognition and audio synthesis pipeline" },
    { id: "gamma", text: "Decentralized governance voting contract on Solana" },
    { id: "delta", text: "Solar panel energy forecasting using IoT weather station telemetry" },
  ];
  const rivals = findRivals("alpha", candidates);
  assert.ok(rivals.length > 0);
  assert.equal(rivals[0]!.rivalId, "beta");
  assert.ok(rivals[0]!.similarity > 0.2);
});
