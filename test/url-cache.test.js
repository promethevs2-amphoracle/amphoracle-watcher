const test = require("node:test");
const assert = require("node:assert/strict");
const { createCacheContext, withCache } = require("../lib/url-cache");

test("withCache: returns the same promise for repeat URLs in one context", async () => {
  let calls = 0;
  const fetcher = async (url) => { calls++; return { url, content: "x", success: true }; };
  const ctx = createCacheContext();
  const cached = withCache(fetcher, ctx);

  const a = await cached("https://espn.com");
  const b = await cached("https://espn.com");
  assert.equal(calls, 1, "second call should hit the cache");
  assert.equal(a.url, b.url);
});

test("withCache: different URLs hit the underlying fetcher independently", async () => {
  let calls = 0;
  const fetcher = async (url) => { calls++; return { url }; };
  const ctx = createCacheContext();
  const cached = withCache(fetcher, ctx);

  await cached("https://a.com");
  await cached("https://b.com");
  assert.equal(calls, 2);
});

test("withCache: concurrent calls for the same URL share the in-flight promise", async () => {
  let calls = 0;
  let resolveInner;
  const fetcher = (url) => {
    calls++;
    return new Promise((resolve) => { resolveInner = () => resolve({ url, ok: true }); });
  };
  const ctx = createCacheContext();
  const cached = withCache(fetcher, ctx);

  // Two concurrent calls for the same URL
  const p1 = cached("https://x.com");
  const p2 = cached("https://x.com");
  assert.equal(calls, 1, "second call must NOT trigger another fetch");

  resolveInner();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.deepEqual(r1, r2);
});

test("withCache: a fresh context has no memory of a prior context", async () => {
  let calls = 0;
  const fetcher = async (url) => { calls++; return { url }; };

  const ctx1 = createCacheContext();
  const cached1 = withCache(fetcher, ctx1);
  await cached1("https://x.com");

  const ctx2 = createCacheContext();
  const cached2 = withCache(fetcher, ctx2);
  await cached2("https://x.com");

  assert.equal(calls, 2, "second context must not see ctx1's cache");
});

test("withCache: caches even failed results (we don't retry within a request)", async () => {
  let calls = 0;
  const fetcher = async (url) => {
    calls++;
    return { url, content: null, success: false, error: "Timeout" };
  };
  const ctx = createCacheContext();
  const cached = withCache(fetcher, ctx);
  const a = await cached("https://x.com");
  const b = await cached("https://x.com");
  assert.equal(calls, 1);
  assert.equal(a.success, false);
  assert.equal(b.success, false);
});
