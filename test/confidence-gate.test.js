const test = require("node:test");
const assert = require("node:assert/strict");
const server = require("../server");
const { claudeResponse, queuedHttpRequest, stubFetchURL } = require("./helpers/mocks");

function setup(claudeText) {
  server.__setFetchURL(stubFetchURL({ "https://example.com": "page body" }));
  const http = queuedHttpRequest([claudeResponse(claudeText)]);
  server.__setHttpRequest(http);
  return http;
}

function reset() {
  server.__resetHttpRequest();
  server.__resetFetchURL();
}

test("checkForEvidence returns parsed Claude output verbatim", async (t) => {
  setup(
    JSON.stringify({
      has_answer: true,
      verdict: "true",
      confidence: 92,
      reasoning: "r",
      evidence: "e",
    }),
  );
  t.after(reset);

  const out = await server.checkForEvidence({
    id: "w1",
    whisper_id: "w1",
    whisper_title: "Test?",
    urls: ["https://example.com"],
    oracle_hint: "hint",
  });
  assert.equal(out.has_answer, true);
  assert.equal(out.verdict, "true");
  assert.equal(out.confidence, 92);
});

test("CONFIDENCE_THRESHOLD is 85 — locks when >= 85, skips when < 85", () => {
  // This is the core business rule. If this test fails, the threshold
  // moved and verdicts may be delivered with less confidence than intended.
  assert.equal(server.CONFIDENCE_THRESHOLD, 85);
  assert.ok(85 >= server.CONFIDENCE_THRESHOLD);
  assert.ok(!(84 >= server.CONFIDENCE_THRESHOLD));
});

test("checkForEvidence tolerates ```json fences from Claude", async (t) => {
  setup(
    "```json\n" +
      JSON.stringify({ has_answer: false, verdict: "unverifiable", confidence: 20 }) +
      "\n```",
  );
  t.after(reset);

  const out = await server.checkForEvidence({
    id: "w1",
    whisper_id: "w1",
    whisper_title: "X",
    urls: ["https://example.com"],
  });
  assert.equal(out.has_answer, false);
  assert.equal(out.confidence, 20);
});

test("checkForEvidence propagates parse errors when Claude returns prose", async (t) => {
  setup("Sorry, I cannot determine that from the sources.");
  t.after(reset);

  await assert.rejects(
    server.checkForEvidence({
      id: "w1",
      whisper_id: "w1",
      whisper_title: "X",
      urls: ["https://example.com"],
    }),
    /JSON/i,
  );
});

test("checkForEvidence survives a failed fetch — still asks Claude with UNAVAILABLE marker", async (t) => {
  server.__setFetchURL(async (url) => ({ url, content: null, success: false }));
  const http = queuedHttpRequest([
    claudeResponse(JSON.stringify({ has_answer: false, verdict: "unverifiable", confidence: 10 })),
  ]);
  server.__setHttpRequest(http);
  t.after(reset);

  await server.checkForEvidence({
    id: "w1",
    whisper_id: "w1",
    whisper_title: "Y",
    urls: ["https://broken.example.com"],
  });

  const claudeCall = http.calls[0];
  assert.ok(claudeCall.body.includes("UNAVAILABLE"), "expected UNAVAILABLE marker in Claude prompt");
});

test("checkForDisruption returns the parsed disruption verdict", async (t) => {
  setup(JSON.stringify({ disrupted: true, reason: "Match cancelled." }));
  t.after(reset);

  const out = await server.checkForDisruption({
    whisper_title: "Will X happen?",
    urls: ["https://example.com"],
    oracle_hint: "",
  });
  assert.equal(out.disrupted, true);
  assert.equal(out.reason, "Match cancelled.");
});
