const test = require("node:test");
const assert = require("node:assert/strict");
const { isSafeURL, isPrivateIPv4, isPrivateIPv6, isPrivateHostname } = require("../lib/url-guard");

test("isSafeURL: allows public https URL", () => {
  const r = isSafeURL("https://www.espn.com/");
  assert.equal(r.ok, true);
});

test("isSafeURL: allows public http URL", () => {
  const r = isSafeURL("http://example.com/path?q=1");
  assert.equal(r.ok, true);
});

test("isSafeURL: rejects invalid URL strings", () => {
  assert.equal(isSafeURL("").ok, false);
  assert.equal(isSafeURL("not a url").ok, false);
  assert.equal(isSafeURL("htp:/x").ok, false);
});

test("isSafeURL: rejects non-http(s) protocols", () => {
  assert.equal(isSafeURL("file:///etc/passwd").reason, "unsupported_protocol");
  assert.equal(isSafeURL("gopher://example.com/").reason, "unsupported_protocol");
  assert.equal(isSafeURL("javascript:alert(1)").reason, "unsupported_protocol");
  assert.equal(isSafeURL("ftp://example.com/").reason, "unsupported_protocol");
  assert.equal(isSafeURL("data:text/plain,hello").reason, "unsupported_protocol");
});

test("isSafeURL: blocks loopback IPv4", () => {
  assert.equal(isSafeURL("http://127.0.0.1/").reason, "private_ipv4");
  assert.equal(isSafeURL("http://127.255.255.254/").reason, "private_ipv4");
});

test("isSafeURL: blocks RFC1918 private IPv4 ranges", () => {
  assert.equal(isSafeURL("http://10.0.0.1/").reason, "private_ipv4");
  assert.equal(isSafeURL("http://10.255.255.255/").reason, "private_ipv4");
  assert.equal(isSafeURL("http://172.16.0.1/").reason, "private_ipv4");
  assert.equal(isSafeURL("http://172.31.255.1/").reason, "private_ipv4");
  assert.equal(isSafeURL("http://192.168.1.1/").reason, "private_ipv4");
});

test("isSafeURL: allows public IPv4 that happens to be 172.15.x or 172.32.x (outside /12)", () => {
  // 172.15.x.x and 172.32.x.x are NOT private.
  assert.equal(isSafeURL("http://172.15.0.1/").ok, true);
  assert.equal(isSafeURL("http://172.32.0.1/").ok, true);
});

test("isSafeURL: blocks AWS/GCP cloud-metadata link-local IP", () => {
  assert.equal(isSafeURL("http://169.254.169.254/").reason, "private_ipv4");
  assert.equal(isSafeURL("http://169.254.1.1/").reason, "private_ipv4");
});

test("isSafeURL: blocks unspecified and multicast", () => {
  assert.equal(isSafeURL("http://0.0.0.0/").reason, "private_ipv4");
  assert.equal(isSafeURL("http://224.0.0.1/").reason, "private_ipv4");
  assert.equal(isSafeURL("http://240.0.0.1/").reason, "private_ipv4");
});

test("isSafeURL: blocks carrier-grade NAT (100.64.0.0/10)", () => {
  assert.equal(isSafeURL("http://100.64.0.1/").reason, "private_ipv4");
  assert.equal(isSafeURL("http://100.127.255.255/").reason, "private_ipv4");
  // boundaries
  assert.equal(isSafeURL("http://100.63.255.255/").ok, true);
  assert.equal(isSafeURL("http://100.128.0.1/").ok, true);
});

test("isSafeURL: blocks IPv6 loopback / unspecified", () => {
  assert.equal(isSafeURL("http://[::1]/").reason, "private_ipv6");
  assert.equal(isSafeURL("http://[::]/").reason, "private_ipv6");
});

test("isSafeURL: blocks IPv6 unique-local (fc00::/7)", () => {
  assert.equal(isSafeURL("http://[fc00::1]/").reason, "private_ipv6");
  assert.equal(isSafeURL("http://[fd12:3456:789a::1]/").reason, "private_ipv6");
});

test("isSafeURL: blocks IPv6 link-local (fe80::/10)", () => {
  assert.equal(isSafeURL("http://[fe80::1]/").reason, "private_ipv6");
});

test("isSafeURL: blocks IPv4-mapped IPv6 to private addresses", () => {
  assert.equal(isSafeURL("http://[::ffff:127.0.0.1]/").reason, "private_ipv6");
  assert.equal(isSafeURL("http://[::ffff:10.0.0.1]/").reason, "private_ipv6");
});

test("isSafeURL: blocks private hostnames", () => {
  assert.equal(isSafeURL("http://localhost/").reason, "private_hostname");
  assert.equal(isSafeURL("http://LOCALHOST/").reason, "private_hostname");
  assert.equal(isSafeURL("http://api.local/").reason, "private_hostname");
  assert.equal(isSafeURL("http://svc.internal/").reason, "private_hostname");
  assert.equal(isSafeURL("http://metadata/").reason, "private_hostname");
  assert.equal(isSafeURL("http://metadata.google.internal/").reason, "private_hostname");
});

test("isSafeURL: allowlist enforces domain + subdomain match", () => {
  const allowlist = ["espn.com", "reuters.com"];
  assert.equal(isSafeURL("https://espn.com/path", { allowlist }).ok, true);
  assert.equal(isSafeURL("https://www.espn.com/path", { allowlist }).ok, true);
  assert.equal(isSafeURL("https://api.v2.espn.com/", { allowlist }).ok, true);
  assert.equal(isSafeURL("https://reuters.com/", { allowlist }).ok, true);

  assert.equal(isSafeURL("https://evil.com/", { allowlist }).reason, "not_on_allowlist");
  // String suffix match must use ".domain" boundary, not bare suffix
  assert.equal(isSafeURL("https://notespn.com/", { allowlist }).reason, "not_on_allowlist");
  assert.equal(isSafeURL("https://espn.com.evil.com/", { allowlist }).reason, "not_on_allowlist");
});

test("isSafeURL: allowlist is case-insensitive", () => {
  const allowlist = ["Espn.COM"];
  assert.equal(isSafeURL("https://WWW.ESPN.com/", { allowlist }).ok, true);
});

test("isSafeURL: empty allowlist means no restriction beyond private-IP blocking", () => {
  assert.equal(isSafeURL("https://random-site.example/", { allowlist: [] }).ok, true);
});

test("isSafeURL: allowlist does not permit private IP even if the IP literal is listed", () => {
  const allowlist = ["127.0.0.1"];
  assert.equal(isSafeURL("http://127.0.0.1/", { allowlist }).reason, "private_ipv4");
});

test("isPrivateIPv4: rejects malformed input", () => {
  assert.equal(isPrivateIPv4("not.an.ip.addr"), false);
  assert.equal(isPrivateIPv4("1.2.3"), false);
  assert.equal(isPrivateIPv4("999.1.1.1"), false);
});

test("isPrivateIPv6: handles mixed case and abbreviations", () => {
  assert.equal(isPrivateIPv6("FC00::1"), true);
  assert.equal(isPrivateIPv6("::1"), true);
  assert.equal(isPrivateIPv6("FE80::abcd"), true);
  assert.equal(isPrivateIPv6("2001:db8::1"), false); // documentation range, technically reserved but public-reachable for tests — treat as public here
});

test("isPrivateHostname: matches the documented classes", () => {
  assert.equal(isPrivateHostname("localhost"), true);
  assert.equal(isPrivateHostname("foo.localhost"), true);
  assert.equal(isPrivateHostname("myservice.local"), true);
  assert.equal(isPrivateHostname("myservice.internal"), true);
  assert.equal(isPrivateHostname("metadata"), true);
  assert.equal(isPrivateHostname("example.com"), false);
  assert.equal(isPrivateHostname("www.localhost.com"), false);
});
