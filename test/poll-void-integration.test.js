// Integration tests for the Phase-1 void path through pollWatchers.
//
// The unit tests in confidence-gate.test.js assert what the prompt
// INSTRUCTS Claude to do. These tests prove the end-to-end behaviour:
// when Claude returns disrupted:true (for either a real-event disruption
// OR a false premise), the watcher must call patchBase44 with
// status=unverifiable and unverifiable_reason = the LLM's reason text
// (no hardcoded "cancelled/postponed" string).

const test = require("node:test");
const assert = require("node:assert/strict");
const server = require("../server");
const { stubFetchURL } = require("./helpers/mocks");

// Routed httpRequest mock: returns the right response based on the
// outbound call's hostname/method. Distinguishes Claude's two parallel
// calls (disruption vs evidence) by looking for the "FALSE PREMISE"
// marker in the system prompt body.
function makePollMock({ watchers, disruptionVerdict, evidenceVerdict }) {
  const calls = [];
  async function fn(options, body) {
    calls.push({ options, body });
    if (options.hostname === "api.anthropic.com") {
      const isDisruptionCheck = typeof body === "string" && body.includes("FALSE PREMISE");
      const verdict = isDisruptionCheck ? disruptionVerdict : evidenceVerdict;
      return {
        status: 200,
        data: { content: [{ type: "text", text: JSON.stringify(verdict) }] },
      };
    }
    if (options.hostname === "api.base44.com") {
      if (options.method === "GET" && options.path.includes("OracleWatcher")) {
        return { status: 200, data: { entities: watchers } };
      }
      // GET WhisperVote (for notifyAllVoters) — return empty list
      if (options.method === "GET" && options.path.includes("WhisperVote")) {
        return { status: 200, data: { entities: [] } };
      }
      // PATCH or POST — ack
      return { status: 200, data: { ok: true } };
    }
    return { status: 200, data: {} };
  }
  fn.calls = calls;
  return fn;
}

function resetState() {
  server.locked.clear();
  server.lastChecked.clear();
  for (const t of server.revealTimers.values()) clearTimeout(t);
  server.revealTimers.clear();
  server.__resetHttpRequest();
  server.__resetFetchURL();
}

test("pollWatchers: false-premise verdict voids the whisper with the LLM's reason (no hardcoded string)", async (t) => {
  t.after(resetState);
  server.__setFetchURL(stubFetchURL({ "https://example.com": "no mention of any such event anywhere" }));

  const falsePremiseReason = "No such event can be found in any reputable source.";
  const http = makePollMock({
    watchers: [{
      id: "watcher-1",
      whisper_id: "wh-false-premise",
      whisper_title: "Will the Mars Olympics 2026 finals end before 9 PM?",
      urls: ["https://example.com"],
      oracle_hint: "",
      check_after_date: null,
    }],
    disruptionVerdict: { disrupted: true, reason: falsePremiseReason },
    evidenceVerdict: { has_answer: false, verdict: "unverifiable", confidence: 10 },
  });
  server.__setHttpRequest(http);

  await server.pollWatchers();

  const whisperPatch = http.calls.find(c =>
    c.options.method === "PATCH" && c.options.path.includes("/Whisper/wh-false-premise"));
  assert.ok(whisperPatch, "expected a PATCH on Whisper/wh-false-premise");

  const body = JSON.parse(whisperPatch.body);
  assert.equal(body.status, "unverifiable",
    "whisper must be marked unverifiable on false-premise verdict");
  assert.equal(body.unverifiable_reason, falsePremiseReason,
    "unverifiable_reason must be the LLM's reason text verbatim — no hardcoded 'cancelled' string");

  const watcherPatch = http.calls.find(c =>
    c.options.method === "PATCH" && c.options.path.includes("/OracleWatcher/watcher-1"));
  assert.ok(watcherPatch, "expected a PATCH on OracleWatcher/watcher-1");
  const watcherBody = JSON.parse(watcherPatch.body);
  assert.equal(watcherBody.oracle_verdict, "unverifiable");
  assert.equal(watcherBody.oracle_reasoning, falsePremiseReason,
    "oracle_reasoning must also be the LLM's text verbatim");
});

test("pollWatchers: real-event disruption verdict voids the whisper with the LLM's reason (regression: behaviour preserved)", async (t) => {
  t.after(resetState);
  server.__setFetchURL(stubFetchURL({ "https://example.com": "match cancelled due to storm" }));

  const disruptionReason = "Match cancelled due to severe weather.";
  const http = makePollMock({
    watchers: [{
      id: "watcher-2",
      whisper_id: "wh-disrupted",
      whisper_title: "Will Team A beat Team B today?",
      urls: ["https://example.com"],
      oracle_hint: "",
      check_after_date: null,
    }],
    disruptionVerdict: { disrupted: true, reason: disruptionReason },
    evidenceVerdict: { has_answer: false, verdict: "unverifiable", confidence: 5 },
  });
  server.__setHttpRequest(http);

  await server.pollWatchers();

  const whisperPatch = http.calls.find(c =>
    c.options.method === "PATCH" && c.options.path.includes("/Whisper/wh-disrupted"));
  assert.ok(whisperPatch, "expected a PATCH on Whisper/wh-disrupted");

  const body = JSON.parse(whisperPatch.body);
  assert.equal(body.status, "unverifiable",
    "real-event disruption must also produce status=unverifiable (same branch as false premise)");
  assert.equal(body.unverifiable_reason, disruptionReason,
    "unverifiable_reason must be the LLM's reason — proves no hardcoded wording");
});

test("pollWatchers: when disrupted=false, no void PATCH fires (sanity check — void path is gated on the boolean)", async (t) => {
  t.after(resetState);
  server.__setFetchURL(stubFetchURL({ "https://example.com": "event is on schedule" }));

  const http = makePollMock({
    watchers: [{
      id: "watcher-3",
      whisper_id: "wh-healthy",
      whisper_title: "Will Team A beat Team B today?",
      urls: ["https://example.com"],
      oracle_hint: "",
      check_after_date: null,
    }],
    disruptionVerdict: { disrupted: false, reason: null },
    evidenceVerdict: { has_answer: false, verdict: "unverifiable", confidence: 30 },
  });
  server.__setHttpRequest(http);

  await server.pollWatchers();

  const voidPatch = http.calls.find(c =>
    c.options.method === "PATCH" &&
    c.options.path.includes("/Whisper/wh-healthy") &&
    typeof c.body === "string" && c.body.includes("unverifiable"));
  assert.equal(voidPatch, undefined,
    "no void PATCH should fire when disrupted=false and confidence is below threshold");
});
