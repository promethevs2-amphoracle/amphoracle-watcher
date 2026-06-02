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

// Phase-1 must catch FALSE PREMISES (event doesn't exist), not just disruptions
// of real events. The prompt is the contract here — if "FALSE PREMISE" drops
// out of the system prompt, Claude reverts to assuming the event is real.
test("checkForDisruption prompt instructs Claude to flag false premises (event-not-found), not just disruptions", async (t) => {
  const http = setup(JSON.stringify({ disrupted: false, reason: null }));
  t.after(reset);

  await server.checkForDisruption({
    whisper_title: "Will the Mars Olympics 2026 finals end before 9 PM?",
    urls: ["https://example.com"],
    oracle_hint: "",
  });

  const body = http.calls[0].body;
  assert.match(body, /FALSE PREMISE/, "system prompt must instruct Claude to detect false-premise events");
  assert.match(body, /Absence of the event across all sources counts as a false premise/,
    "system prompt must tell Claude that absence-of-evidence counts as false premise (not 'unknown')");
});

// When oracle_hint is present, Phase-1 should treat it as the expected
// verification source, so a hint-matching source showing nothing strongly
// suggests false premise.
test("checkForDisruption prompt elevates oracle_hint to EXPECTED VERIFICATION SOURCE when present", async (t) => {
  const http = setup(JSON.stringify({ disrupted: false, reason: null }));
  t.after(reset);

  await server.checkForDisruption({
    whisper_title: "Will Real Madrid beat Barcelona?",
    urls: ["https://example.com"],
    oracle_hint: "official LaLiga match statistics",
  });

  const body = http.calls[0].body;
  assert.match(body, /EXPECTED VERIFICATION SOURCE/, "system prompt must mark hint as expected verification source");
  assert.match(body, /official LaLiga match statistics/, "user message must still carry the hint text through to Claude");
});

// When oracle_hint is present, Phase-2 (checkForEvidence) should prioritize
// it as the authoritative source. New custom-whisper flow ships hints like
// "official LaLiga match statistics" — Claude must weight that over noise.
test("checkForEvidence prompt elevates oracle_hint to PRIORITY / EXPECTED SOURCE when present", async (t) => {
  const http = setup(JSON.stringify({ has_answer: false, verdict: "unverifiable", confidence: 10 }));
  t.after(reset);

  await server.checkForEvidence({
    id: "w1",
    whisper_id: "w1",
    whisper_title: "Did Real Madrid win?",
    urls: ["https://example.com"],
    oracle_hint: "official LaLiga match statistics",
  });

  const body = http.calls[0].body;
  assert.match(body, /PRIORITY \/ EXPECTED SOURCE/, "system prompt must mark hint as priority/expected source");
  assert.match(body, /priority source to check first/, "system prompt must tell Claude to check the hint source first");
  assert.match(body, /base the verdict on evidence strength/,
    "system prompt must base the verdict on evidence strength, not blind hint-trust");
  assert.match(body, /multiple independent authoritative sources contradict the hint source, do not lock a verdict; require corroboration/,
    "system prompt must require corroboration and refuse to lock when authoritative sources contradict the hint");
  assert.match(body, /official LaLiga match statistics/, "user message must still carry the hint text through to Claude");
});

// Backward-compat: when no hint is given, the evidence prompt still works
// and falls back to the existing "Determine if this prediction came true"
// instruction in the user message.
test("checkForEvidence still uses default fallback wording when oracle_hint is empty", async (t) => {
  const http = setup(JSON.stringify({ has_answer: false, verdict: "unverifiable", confidence: 10 }));
  t.after(reset);

  await server.checkForEvidence({
    id: "w1",
    whisper_id: "w1",
    whisper_title: "Did X happen?",
    urls: ["https://example.com"],
    // no oracle_hint
  });

  const body = http.calls[0].body;
  assert.match(body, /Determine if this prediction came true based on the sources/,
    "empty hint must fall back to the default 'determine if this prediction came true' wording");
});
