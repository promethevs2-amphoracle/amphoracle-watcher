// Parse a JSON response from Claude, tolerating optional markdown fences
// and surrounding whitespace. Throws on truly malformed input so callers
// can decide the failure mode.
function parseClaudeJSON(raw) {
  if (typeof raw !== "string") {
    throw new TypeError("parseClaudeJSON expects a string");
  }
  const stripped = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(stripped);
}

module.exports = { parseClaudeJSON };
