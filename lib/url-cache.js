// Per-request fetchURL cache.
//
// During a single poll cycle, both checkForDisruption (top 2 URLs) and
// checkForEvidence (all URLs) fetch the same source URLs. Without dedup
// each URL gets hit twice, which doubles latency and can cause sites to
// rate-limit us. This cache memoizes results for the lifetime of a
// caller-supplied context.
//
// The cache key is the URL string. Concurrent calls for the same URL
// share the same in-flight promise rather than starting a second fetch.
//
// Usage:
//   const ctx = createCacheContext();
//   const cachedFetch = withCache(fetchURL, ctx);
//   await Promise.all(urls.map(cachedFetch));
//
// The context is intentionally not module-level — callers create one per
// logical "request" (a single poll iteration, a single /scout call, etc.)
// and discard it after. That way nothing leaks between requests, and
// stale results can't survive the request boundary.

function createCacheContext() {
  return new Map(); // url -> Promise<fetchURL result>
}

function withCache(fetchFn, context) {
  return function cachedFetch(url) {
    if (context.has(url)) {
      return context.get(url);
    }
    const promise = fetchFn(url);
    context.set(url, promise);
    return promise;
  };
}

module.exports = { createCacheContext, withCache };
