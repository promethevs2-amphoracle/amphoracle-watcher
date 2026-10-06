const test = require("node:test");
const assert = require("node:assert/strict");
const server = require("../server");
const { requestJSON } = require("./helpers/http-client");
const { claudeResponse, queuedHttpRequest, stubFetchURL } = require("./helpers/mocks");

function reset() {
  server.__resetHttpRequest();
  server.__resetFetchURL();
}

const body = {
  whisper_id: "w1",
  whisper_title: "BTC closes above $100k on Friday",
  urls: ["https://example.com/btc"],
  oracle_hint: "coinmarketcap",
};

test("/verdict 400s when whisper_id or whisper_title is missing", async () => {
  let res = await requestJSON(server.app, "POST", "/verdict", { whisper_title: "t" });
  assert.equal(res.status, 400);
  res = await requestJSON(server.app, "POST", "/verdict", { whisper_id: "w" });
  assert.equal(res.status, 400);
});

test("/verdict returns the Oracle's verdict synchronously and writes nothing", async (t) => {
  t.after(reset);
  server.__setFetchURL(stubFetchURL({ "https://example.com/btc": "BTC closed at $101,200 on Friday." }));
  const http = queuedHttpRequest([
    claudeResponse(JSON.stringify({
      has_answer: true, verdict: "true", confidence: 92,
      reasoning: "The ledger speaks.", evidence: "Close: $101,200",
    })),
  ]);
  server.__setHttpRequest(http);

  const res = await requestJSON(server.app, "POST", "/verdict", body);
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, {
    verdict: "true", confidence: 92, reasoning: "The ledger speaks.",
    evidence: "Close: $101,200", has_answer: true,
  });
  // Exactly one outbound call (Anthropic) — no Base44 PATCHes.
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].options.hostname, "api.anthropic.com");
  assert.equal(server.locked.size, 0);
});

test("/verdict coerces a sub-threshold answer to unverifiable", async (t) => {
  t.after(reset);
  server.__setFetchURL(stubFetchURL({}));
  server.__setHttpRequest(queuedHttpRequest([
    claudeResponse(JSON.stringify({ has_answer: true, verdict: "true", confidence: 60, reasoning: "Murky." })),
  ]));
  const res = await requestJSON(server.app, "POST", "/verdict", body);
  assert.equal(res.status, 200);
  assert.equal(res.data.verdict, "unverifiable");
  assert.equal(res.data.has_answer, false);
  assert.equal(res.data.confidence, 60);
});

test("/verdict always returns a non-empty reasoning and a 0-100 confidence", async (t) => {
  t.after(reset);
  server.__setFetchURL(stubFetchURL({}));
  server.__setHttpRequest(queuedHttpRequest([
    claudeResponse(JSON.stringify({ has_answer: false, verdict: "unverifiable", confidence: 240 })),
  ]));
  const res = await requestJSON(server.app, "POST", "/verdict", body);
  assert.equal(res.status, 200);
  assert.equal(res.data.verdict, "unverifiable");
  assert.equal(res.data.confidence, 100);
  assert.ok(res.data.reasoning.length > 0);
});

test("/verdict 502s when the Oracle call fails", async (t) => {
  t.after(reset);
  server.__setFetchURL(stubFetchURL({}));
  server.__setHttpRequest(async () => { throw new Error("boom"); });
  const res = await requestJSON(server.app, "POST", "/verdict", body);
  assert.equal(res.status, 502);
});

test("toSyncVerdict rejects an off-enum verdict even at high confidence", () => {
  const out = server.toSyncVerdict({ has_answer: true, verdict: "maybe", confidence: 99, reasoning: "x" });
  assert.equal(out.verdict, "unverifiable");
  assert.equal(out.has_answer, false);
});
