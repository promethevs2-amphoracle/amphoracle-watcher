const test = require("node:test");
const assert = require("node:assert/strict");
const server = require("../server");
const { requestJSON } = require("./helpers/http-client");
const { claudeResponse, queuedHttpRequest, stubFetchURL } = require("./helpers/mocks");

function reset() {
  server.__resetHttpRequest();
  server.__resetFetchURL();
}

// Build a fetchURL stub that succeeds for any URL.
function alwaysFetchURL() {
  return async (url) => ({ url, content: "sample content", success: true });
}

test("/scout drops past-dated whispers and keeps future ones", async (t) => {
  t.after(reset);
  server.__setFetchURL(alwaysFetchURL());

  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const future = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();

  const whispers = [
    { title: "past", check_after_date: past },
    { title: "future", check_after_date: future },
    { title: "no-date" },
  ];

  server.__setHttpRequest(
    queuedHttpRequest([claudeResponse(JSON.stringify({ whispers }))]),
  );

  const res = await requestJSON(server.app, "POST", "/scout", {
    topic: "bitcoin",
    category: "stocks_crypto",
  });

  assert.equal(res.status, 200);
  assert.equal(res.data.success, true);
  const titles = res.data.whispers.map((w) => w.title).sort();
  assert.deepEqual(titles, ["future", "no-date"]);
});

test("/scout returns success:false when Claude yields zero whispers", async (t) => {
  t.after(reset);
  server.__setFetchURL(alwaysFetchURL());
  server.__setHttpRequest(
    queuedHttpRequest([claudeResponse(JSON.stringify({ whispers: [] }))]),
  );

  const res = await requestJSON(server.app, "POST", "/scout", {
    topic: "empty-topic",
    category: "politics",
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.success, false);
  assert.deepEqual(res.data.whispers, []);
});

test("/scout 500s when all source fetches fail", async (t) => {
  t.after(reset);
  server.__setFetchURL(async (url) => ({ url, content: null, success: false }));
  // No Claude call expected since we short-circuit before it.
  server.__setHttpRequest(queuedHttpRequest([]));

  const res = await requestJSON(server.app, "POST", "/scout", {
    topic: "anything",
    category: "sports",
  });
  assert.equal(res.status, 500);
  assert.equal(res.data.success, false);
  assert.match(res.data.error, /Could not fetch any sources/);
});

test("/scout defaults to politics sources for unknown category", async (t) => {
  t.after(reset);
  const fetched = [];
  server.__setFetchURL(async (url) => {
    fetched.push(url);
    return { url, content: "x", success: true };
  });
  server.__setHttpRequest(
    queuedHttpRequest([claudeResponse(JSON.stringify({ whispers: [] }))]),
  );

  await requestJSON(server.app, "POST", "/scout", {
    topic: "anything",
    category: "not-a-real-category",
  });

  const hasReuters = fetched.some((u) => u.includes("reuters.com"));
  assert.ok(hasReuters, "unknown category should fall back to politics (Reuters)");
});

test("/scout drops whispers with invalid date strings", async (t) => {
  t.after(reset);
  server.__setFetchURL(alwaysFetchURL());

  const whispers = [
    { title: "bad-date", check_after_date: "tomorrow" },
    { title: "good", check_after_date: new Date(Date.now() + 3600_000).toISOString() },
  ];
  server.__setHttpRequest(
    queuedHttpRequest([claudeResponse(JSON.stringify({ whispers }))]),
  );

  const res = await requestJSON(server.app, "POST", "/scout", {
    topic: "x",
    category: "entertainment",
  });

  assert.equal(res.data.whispers.length, 1);
  assert.equal(res.data.whispers[0].title, "good");
});

test("/scout succeeds with valid whispers end-to-end", async (t) => {
  t.after(reset);
  server.__setFetchURL(alwaysFetchURL());

  const futureDate1 = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const futureDate2 = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  const pastDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const whispers = [
    {
      title: "Will Bitcoin reach $50k?",
      category: "stocks_crypto",
      symbol_or_topic: "BTC",
      verification_hint: "Check CoinMarketCap BTC price",
      sources: ["https://coinmarketcap.com"],
      check_after_date: futureDate1,
      duration_type: "daily",
      event_found: "Bitcoin at current price",
    },
    {
      title: "Will Ethereum hit $3k?",
      category: "stocks_crypto",
      symbol_or_topic: "ETH",
      verification_hint: "Check Ethereum price",
      sources: ["https://coinmarketcap.com"],
      check_after_date: futureDate2,
      duration_type: "daily",
      event_found: "Ethereum at current price",
    },
    {
      title: "Past event",
      category: "stocks_crypto",
      check_after_date: pastDate,
      // This should be filtered out
    },
  ];

  server.__setHttpRequest(
    queuedHttpRequest([claudeResponse(JSON.stringify({ whispers }))]),
  );

  const res = await requestJSON(server.app, "POST", "/scout", {
    topic: "bitcoin ethereum",
    category: "stocks_crypto",
  });

  assert.equal(res.status, 200);
  assert.equal(res.data.success, true);
  assert.equal(res.data.whispers.length, 2, "should include 2 future-dated whispers, filter out past");
  assert.ok(res.data.whispers.some((w) => w.title === "Will Bitcoin reach $50k?"));
  assert.ok(res.data.whispers.some((w) => w.title === "Will Ethereum hit $3k?"));
  assert.equal(
    res.data.whispers.some((w) => w.title === "Past event"),
    false,
    "past-dated whispers should be filtered out"
  );
});
