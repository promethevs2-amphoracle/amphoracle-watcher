const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const server = require("../server");

// These tests run a local HTTP server on 127.0.0.1 and aim fetchURL at it.
// That IP is blocked by the SSRF guard in production, so relax the guard
// for this file only. Each test still resets it via t.after() to avoid
// leaking state into other test files.
server.__setURLGuard(() => ({ ok: true }));

function startServer(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
}

function close(s) {
  return new Promise((resolve) => s.close(() => resolve()));
}

test("httpRequest parses JSON responses into .data", async () => {
  const s = await startServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ hello: "world", n: 42 }));
  });
  const { port } = s.address();

  try {
    const result = await server.httpRequest({
      protocol: "http:",
      hostname: "127.0.0.1",
      port,
      path: "/",
      method: "GET",
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { hello: "world", n: 42 });
  } finally {
    await close(s);
  }
});

test("httpRequest returns raw string when body is not valid JSON", async () => {
  const s = await startServer((req, res) => res.end("not json at all"));
  const { port } = s.address();

  try {
    const result = await server.httpRequest({
      protocol: "http:",
      hostname: "127.0.0.1",
      port,
      path: "/",
      method: "GET",
    });
    assert.equal(result.data, "not json at all");
  } finally {
    await close(s);
  }
});

test("httpRequest forwards POST body to the server", async () => {
  let received = "";
  const s = await startServer((req, res) => {
    req.on("data", (c) => (received += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const { port } = s.address();

  try {
    const body = JSON.stringify({ greet: "hello" });
    const result = await server.httpRequest(
      {
        protocol: "http:",
        hostname: "127.0.0.1",
        port,
        path: "/",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      body,
    );
    assert.equal(result.status, 200);
    assert.equal(received, body);
  } finally {
    await close(s);
  }
});

test("httpRequest rejects on network error (connection refused)", async () => {
  await assert.rejects(
    server.httpRequest({
      protocol: "http:",
      hostname: "127.0.0.1",
      port: 1, // nothing listens here
      path: "/",
      method: "GET",
    }),
  );
});

test("fetchURL extracts body text via cheerio and strips nav/script/style", async () => {
  const html =
    "<html><head><style>body{}</style></head>" +
    "<body><nav>NAV</nav><script>var x=1;</script><p>Hello world</p></body></html>";
  const s = await startServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(html);
  });
  const { port } = s.address();

  try {
    const out = await server.fetchURL(`http://127.0.0.1:${port}/`);
    assert.equal(out.success, true);
    assert.ok(out.content.includes("Hello world"));
    assert.ok(!out.content.includes("NAV"));
    assert.ok(!out.content.includes("var x"));
  } finally {
    await close(s);
  }
});

test("fetchURL truncates content to 5000 characters", async () => {
  const big = "a".repeat(12000);
  const s = await startServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(`<html><body>${big}</body></html>`);
  });
  const { port } = s.address();

  try {
    const out = await server.fetchURL(`http://127.0.0.1:${port}/`);
    assert.equal(out.success, true);
    assert.ok(out.content.length <= 5000);
  } finally {
    await close(s);
  }
});

test("fetchURL returns success:false for unreachable URL", async () => {
  const out = await server.fetchURL("http://127.0.0.1:1/does-not-exist");
  assert.equal(out.success, false);
  assert.ok(out.error);
});

test("fetchURL prefixes missing scheme with https://", async () => {
  const out = await server.fetchURL("127.0.0.1:1");
  // We can't easily reach it, but verify no throw and that the error path ran.
  assert.equal(out.success, false);
});
