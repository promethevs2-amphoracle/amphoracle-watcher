const test = require("node:test");
const assert = require("node:assert/strict");
const { parseClaudeJSON } = require("../lib/parse-claude-json");

test("parses plain JSON", () => {
  assert.deepEqual(parseClaudeJSON('{"a":1}'), { a: 1 });
});

test("strips ```json fences", () => {
  const raw = '```json\n{"verdict":"true","confidence":92}\n```';
  assert.deepEqual(parseClaudeJSON(raw), { verdict: "true", confidence: 92 });
});

test("strips bare ``` fences", () => {
  assert.deepEqual(parseClaudeJSON('```\n{"x":true}\n```'), { x: true });
});

test("tolerates surrounding whitespace", () => {
  assert.deepEqual(parseClaudeJSON('   \n {"ok":1}\n  '), { ok: 1 });
});

test("throws on non-JSON content", () => {
  assert.throws(() => parseClaudeJSON("Sorry, I cannot help."), SyntaxError);
});

test("throws on truncated JSON", () => {
  assert.throws(() => parseClaudeJSON('{"verdict":"tr'), SyntaxError);
});

test("throws on non-string input", () => {
  assert.throws(() => parseClaudeJSON({ a: 1 }), TypeError);
  assert.throws(() => parseClaudeJSON(null), TypeError);
});

test("preserves nested fields used by the Oracle", () => {
  const raw =
    '```json\n' +
    '{"has_answer":true,"verdict":"false","confidence":87,"reasoning":"r","evidence":"e"}\n' +
    '```';
  const parsed = parseClaudeJSON(raw);
  assert.equal(parsed.has_answer, true);
  assert.equal(parsed.verdict, "false");
  assert.equal(parsed.confidence, 87);
});

test("known failure mode: trailing prose after JSON — documents current behavior", () => {
  // Claude sometimes appends a trailing sentence. Current impl throws.
  // This test pins the behavior so we notice if it silently changes.
  const raw = '{"a":1}\nHope this helps!';
  assert.throws(() => parseClaudeJSON(raw), SyntaxError);
});
