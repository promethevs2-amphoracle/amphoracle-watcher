const test = require("node:test");
const assert = require("node:assert/strict");
const server = require("../server");

function resetGuard() {
  server.__resetURLGuard();
  delete process.env.FETCH_URL_ALLOWLIST;
}

test("fetchURL: blocks 127.0.0.1 with success:false and 'blocked:' error", async (t) => {
  t.after(resetGuard);
  const out = await server.fetchURL("http://127.0.0.1:9/ping");
  assert.equal(out.success, false);
  assert.equal(out.error, "blocked:private_ipv4");
});

test("fetchURL: blocks the AWS metadata IP (169.254.169.254)", async (t) => {
  t.after(resetGuard);
  const out = await server.fetchURL("http://169.254.169.254/latest/meta-data/");
  assert.equal(out.success, false);
  assert.equal(out.error, "blocked:private_ipv4");
});

test("fetchURL: blocks localhost hostname", async (t) => {
  t.after(resetGuard);
  const out = await server.fetchURL("http://localhost:8080/admin");
  assert.equal(out.success, false);
  assert.equal(out.error, "blocked:private_hostname");
});

test("fetchURL: blocks file:// protocol", async (t) => {
  t.after(resetGuard);
  const out = await server.fetchURL("file:///etc/passwd");
  assert.equal(out.success, false);
  assert.equal(out.error, "blocked:unsupported_protocol");
});

test("fetchURL: blocks IPv6 loopback", async (t) => {
  t.after(resetGuard);
  const out = await server.fetchURL("http://[::1]:80/");
  assert.equal(out.success, false);
  assert.equal(out.error, "blocked:private_ipv6");
});

test("fetchURL: blocks *.local hostname", async (t) => {
  t.after(resetGuard);
  const out = await server.fetchURL("http://router.local/");
  assert.equal(out.success, false);
  assert.equal(out.error, "blocked:private_hostname");
});

test("fetchURL: with FETCH_URL_ALLOWLIST set, blocks non-listed public domain", async (t) => {
  t.after(resetGuard);
  process.env.FETCH_URL_ALLOWLIST = "espn.com,reuters.com";
  const out = await server.fetchURL("https://random-other-site.example/");
  assert.equal(out.success, false);
  assert.equal(out.error, "blocked:not_on_allowlist");
});

test("fetchURL: without FETCH_URL_ALLOWLIST, public URLs pass the guard (network may still fail)", async (t) => {
  t.after(resetGuard);
  // We don't actually want to hit the network; override the guard to a
  // tracker to confirm it approved the URL, then return an artificial
  // block on the next call to avoid an outbound request.
  let seen = null;
  server.__setURLGuard((u) => {
    seen = u;
    return { ok: false, reason: "test_short_circuit" };
  });
  const out = await server.fetchURL("https://www.espn.com/scores");
  assert.equal(seen, "https://www.espn.com/scores");
  assert.equal(out.success, false);
  assert.equal(out.error, "blocked:test_short_circuit");
});

test("fetchURL: guard sees https-prefixed URL when scheme is omitted", async (t) => {
  t.after(resetGuard);
  let seen = null;
  server.__setURLGuard((u) => {
    seen = u;
    return { ok: false, reason: "test_short_circuit" };
  });
  await server.fetchURL("example.com/path");
  assert.equal(seen, "https://example.com/path", "missing scheme should be promoted to https:// before guard check");
});
