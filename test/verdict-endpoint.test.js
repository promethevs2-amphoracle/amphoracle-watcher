const test = require("node:test");
const assert = require("node:assert/strict");
const server = require("../server");
const { requestJSON } = require("./helpers/http-client");
const { claudeResponse, queuedHttpRequest, stubFetchURL } = require("./helpers/mocks");

function reset() {
  server.__resetHttpRequest();
  server.__resetFetchURL();
  server.sourceMemo.clear();
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
    evidence: "Close: $101,200", has_answer: true, disrupted: false, unchanged: false,
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

test("/verdict returns unverifiable with the disruption reason when the event is voided", async (t) => {
  t.after(reset);
  server.__setFetchURL(stubFetchURL({}));
  server.__setHttpRequest(queuedHttpRequest([
    claudeResponse(JSON.stringify({
      disrupted: true, disruption_reason: "The match was washed out by storm.",
      has_answer: true, verdict: "true", confidence: 95, reasoning: "ignored",
    })),
  ]));
  const res = await requestJSON(server.app, "POST", "/verdict", body);
  assert.equal(res.status, 200);
  assert.equal(res.data.verdict, "unverifiable");
  assert.equal(res.data.disrupted, true);
  assert.equal(res.data.has_answer, false);
  assert.equal(res.data.reasoning, "The match was washed out by storm.");
});

test("/verdict skips the model call when the sources are unchanged since the last check", async (t) => {
  t.after(reset);
  server.__setFetchURL(stubFetchURL({ "https://example.com/btc": "Markets open. No close yet." }));
  const http = queuedHttpRequest([
    claudeResponse(JSON.stringify({ has_answer: false, verdict: "unverifiable", confidence: 20, reasoning: "Not yet." })),
  ]);
  server.__setHttpRequest(http);

  const first = await requestJSON(server.app, "POST", "/verdict", body);
  const second = await requestJSON(server.app, "POST", "/verdict", body);
  assert.equal(first.data.unchanged, false);
  assert.equal(second.data.unchanged, true);
  assert.equal(second.data.reasoning, "Not yet.");
  assert.equal(http.calls.length, 1, "second check must not call Anthropic");

  // A changed page triggers a fresh call.
  server.__setFetchURL(stubFetchURL({ "https://example.com/btc": "BTC closed at $101,200." }));
  http.calls.length = 0;
  server.__setHttpRequest(queuedHttpRequest([
    claudeResponse(JSON.stringify({ has_answer: true, verdict: "true", confidence: 96, reasoning: "The ledger speaks." })),
  ]));
  const third = await requestJSON(server.app, "POST", "/verdict", body);
  assert.equal(third.data.verdict, "true");
  assert.equal(third.data.unchanged, false);
});

test("checkWhisper memo expires after UNCHANGED_SOURCE_TTL_MS", async (t) => {
  t.after(reset);
  server.__setFetchURL(stubFetchURL({ "https://example.com/btc": "same page" }));
  let clock = 1_000_000;
  const now = () => clock;
  const http = queuedHttpRequest([
    claudeResponse(JSON.stringify({ has_answer: false, verdict: "unverifiable", confidence: 5, reasoning: "a" })),
    claudeResponse(JSON.stringify({ has_answer: false, verdict: "unverifiable", confidence: 5, reasoning: "b" })),
  ]);
  server.__setHttpRequest(http);
  const w = { whisper_id: "ttl", whisper_title: "t", urls: ["https://example.com/btc"] };
  await server.checkWhisper(w, { now });
  clock += server.UNCHANGED_SOURCE_TTL_MS - 1;
  assert.equal((await server.checkWhisper(w, { now })).unchanged, true);
  clock += 2;
  const fresh = await server.checkWhisper(w, { now });
  assert.equal(fresh.unchanged, undefined);
  assert.equal(fresh.reasoning, "b");
  assert.equal(http.calls.length, 2);
});

test("pruneState drops the source memo for whispers no longer active", () => {
  server.sourceMemo.set("gone", { hash: "x", result: {}, at: Date.now() });
  server.sourceMemo.set("here", { hash: "y", result: {}, at: Date.now() });
  server.pruneState(["here"]);
  assert.equal(server.sourceMemo.has("gone"), false);
  assert.equal(server.sourceMemo.has("here"), true);
  server.sourceMemo.clear();
});
