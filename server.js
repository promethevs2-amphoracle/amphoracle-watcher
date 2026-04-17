// ============================================================
// AMPHORACLE WATCHER SERVER v4.1
// Evidence-based Oracle — no fixed reveal dates
// Polls continuously, locks on confidence, reveals after 15 min
// ============================================================

const express = require("express");
const cheerio = require("cheerio");
const https = require("https");
const http = require("http");

const { parseClaudeJSON } = require("./lib/parse-claude-json");
const { decidePollInterval } = require("./lib/poll-interval");
const { filterFutureWhispers } = require("./lib/filter-future-whispers");

const app = express();
app.use(express.json());

// CORS — allow Base44 frontend
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const BASE44_API = "https://api.base44.com/api/apps/69d1545f93121e831922ce33/entities";
const BASE44_KEY = process.env.BASE44_API_KEY;
const ANTHROPIC_KEY = process.env.amphoracle_railway;

const CONFIDENCE_THRESHOLD = 85; // Oracle locks when >= 85% confident
const LOCK_TO_REVEAL_MS = 15 * 60 * 1000; // 15 minutes
const POLL_INTERVAL_MS = 30 * 1000; // Poll every 30s
const PER_WHISPER_CHECK_INTERVAL = 5 * 60 * 1000; // Check each whisper every 5 min

const locked = new Map(); // whisper_id -> lock timestamp
const lastChecked = new Map(); // whisper_id -> last check timestamp
const revealTimers = new Map(); // whisper_id -> reveal timeout

// ─── HTTP HELPER ────────────────────────────────────────────
function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const lib = options.protocol === "http:" ? http : https;
    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Timeout")); });
    if (body) req.write(body);
    req.end();
  });
}

// Injection points so tests can replace the network boundary without
// touching runtime behavior. Production keeps the originals.
let _httpRequest = httpRequest;
let _fetchURL;

// ─── FETCH URL ───────────────────────────────────────────────
function fetchURL(url) {
  return new Promise((resolve) => {
    try {
      const fullUrl = url.startsWith("http") ? url : "https://" + url;
      const parsed = new URL(fullUrl);
      const lib = parsed.protocol === "http:" ? http : https;
      let data = "";
      const req = lib.request({
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; AmphoracleOracle/1.0)" },
      }, (res) => {
        res.on("data", (chunk) => data += chunk);
        res.on("end", () => {
          try {
            const $ = cheerio.load(data);
            $("script, style, nav, footer, header, aside, iframe").remove();
            const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, 5000);
            resolve({ url, content: text, success: true });
          } catch(e) {
            resolve({ url, content: data.slice(0, 5000), success: true });
          }
        });
      });
      req.on("error", (e) => resolve({ url, content: null, success: false, error: e.message }));
      req.setTimeout(10000, () => { req.destroy(); resolve({ url, content: null, success: false, error: "Timeout" }); });
      req.end();
    } catch(e) {
      resolve({ url, content: null, success: false, error: e.message });
    }
  });
}

_fetchURL = fetchURL;

// ─── CALL CLAUDE ─────────────────────────────────────────────
async function callClaude(systemPrompt, userMessage, maxTokens = 800) {
  const body = JSON.stringify({
    model: "claude-opus-4-6",
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }]
  });

  const res = await _httpRequest({
    protocol: "https:",
    hostname: "api.anthropic.com",
    path: "/v1/messages",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Length": Buffer.byteLength(body)
    }
  }, body);

  const textBlock = res.data.content && res.data.content.find(b => b.type === "text");
  if (!textBlock) throw new Error("No text from Claude: " + JSON.stringify(res.data).slice(0, 200));
  return textBlock.text;
}

// ─── BASE44 HELPERS ──────────────────────────────────────────

// Post a single notification record
async function createNotification(userEmail, type, message, whisperId) {
  const body = JSON.stringify({
    user_email: userEmail,
    type,
    message,
    whisper_id: whisperId,
    is_read: false
  });
  try {
    await _httpRequest({
      protocol: "https:",
      hostname: "api.base44.com",
      path: "/api/apps/69d1545f93121e831922ce33/entities/Notification",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": BASE44_KEY,
        "Content-Length": Buffer.byteLength(body)
      }
    }, body);
  } catch(e) {
    console.log(`[NOTIFY] Failed to create notification for ${userEmail}:`, e.message);
  }
}

// Get all voters for a whisper
async function getVotersForWhisper(whisperId) {
  try {
    const res = await _httpRequest({
      protocol: "https:",
      hostname: "api.base44.com",
      path: `/api/apps/69d1545f93121e831922ce33/entities/WhisperVote?whisper_id=${whisperId}&limit=500`,
      method: "GET",
      headers: { "x-api-key": BASE44_KEY }
    });
    return (res.data && res.data.entities) || [];
  } catch(e) {
    console.log(`[NOTIFY] Failed to get voters for whisper ${whisperId}:`, e.message);
    return [];
  }
}

// Notify all voters of a whisper
async function notifyAllVoters(whisperId, whisperTitle, type, message) {
  const voters = await getVotersForWhisper(whisperId);
  if (!voters.length) return;
  console.log(`[NOTIFY] Sending ${type} to ${voters.length} voters for "${whisperTitle}"`);
  for (const voter of voters) {
    if (voter.voter_email) {
      await createNotification(voter.voter_email, type, message, whisperId);
    }
  }
}

async function patchBase44(entity, id, payload) {
  const body = JSON.stringify(payload);
  return _httpRequest({
    protocol: "https:",
    hostname: "api.base44.com",
    path: `/api/apps/69d1545f93121e831922ce33/entities/${entity}/${id}`,
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": BASE44_KEY,
      "Content-Length": Buffer.byteLength(body)
    }
  }, body);
}

async function getWatchers() {
  const res = await _httpRequest({
    protocol: "https:",
    hostname: "api.base44.com",
    path: "/api/apps/69d1545f93121e831922ce33/entities/OracleWatcher?status=pending&limit=100",
    method: "GET",
    headers: { "x-api-key": BASE44_KEY }
  });
  return (res.data && res.data.entities) || [];
}

// List Whispers currently in the lock window (between lock and reveal).
async function listLockedWhispers() {
  const res = await _httpRequest({
    protocol: "https:",
    hostname: "api.base44.com",
    path: "/api/apps/69d1545f93121e831922ce33/entities/Whisper?status=locked&limit=100",
    method: "GET",
    headers: { "x-api-key": BASE44_KEY }
  });
  return (res.data && res.data.entities) || [];
}

// Find the OracleWatcher for a given whisper_id. Returns null if none.
async function getWatcherByWhisperId(whisperId) {
  const res = await _httpRequest({
    protocol: "https:",
    hostname: "api.base44.com",
    path: `/api/apps/69d1545f93121e831922ce33/entities/OracleWatcher?whisper_id=${encodeURIComponent(whisperId)}&limit=1`,
    method: "GET",
    headers: { "x-api-key": BASE44_KEY }
  });
  const entities = (res.data && res.data.entities) || [];
  return entities[0] || null;
}

// ─── DISRUPTION CHECK ────────────────────────────────────────
async function checkForDisruption(watcher) {
  const { whisper_title, urls, oracle_hint } = watcher;

  const fetchResults = await Promise.all((urls || []).slice(0, 2).map(_fetchURL));
  const contentBlock = fetchResults
    .map(f => f.success ? `--- SOURCE: ${f.url} ---\n${f.content}` : `--- SOURCE: ${f.url} --- UNAVAILABLE ---`)
    .join("\n\n");

  const raw = await callClaude(
    `You are the Oracle of Amphoracle. Check if anything has disrupted or cancelled the event this prediction is based on — making it impossible to verify. Look for: cancellations, postponements, withdrawals, trading halts, deaths, legal blocks, weather cancellations, or any event that prevents the prediction from being answerable.

Respond in JSON only:
{
  "disrupted": true or false,
  "reason": "If disrupted: one sentence in Oracle voice explaining what happened. If not disrupted: null"
}`,
    `WHISPER: "${whisper_title}"\nHINT: ${oracle_hint || ""}\n\nSOURCES:\n${contentBlock}`,
    300
  );

  return parseClaudeJSON(raw);
}

// ─── ORACLE EVIDENCE CHECK ────────────────────────────────────
async function checkForEvidence(watcher) {
  const { id, whisper_id, whisper_title, urls, oracle_hint } = watcher;

  // Fetch all sources
  const fetchResults = await Promise.all((urls || []).map(_fetchURL));
  const successCount = fetchResults.filter(f => f.success).length;
  console.log(`[ORACLE] Checked ${successCount}/${fetchResults.length} sources for: "${whisper_title}"`);

  const contentBlock = fetchResults
    .map(f => f.success ? `--- SOURCE: ${f.url} ---\n${f.content}` : `--- SOURCE: ${f.url} --- UNAVAILABLE ---`)
    .join("\n\n");

  const systemPrompt = `You are the Oracle of Amphoracle. You check live sources to determine if a binary prediction has come true.

RULES:
- Only deliver a verdict if you find CONCLUSIVE evidence in the sources
- If evidence is inconclusive or the event hasn't happened yet, say so clearly
- Confidence must be >= 85 to lock a verdict
- Be extremely precise — this prediction will be revealed to thousands of seers

Respond in JSON only, no markdown:
{
  "has_answer": true or false,
  "verdict": "true" or "false" or "unverifiable",
  "confidence": 0-100,
  "reasoning": "2-3 sentences in dramatic Oracle voice explaining the verdict",
  "evidence": "The specific fact found that proves the verdict"
}`;

  const userMessage = `WHISPER: "${whisper_title}"
VERIFICATION HINT: ${oracle_hint || "Determine if this prediction came true based on the sources."}

LIVE SOURCES:
${contentBlock}

Has this prediction been conclusively answered? If confidence is below 85, set has_answer to false.`;

  const raw = await callClaude(systemPrompt, userMessage);
  const parsed = parseClaudeJSON(raw);
  return parsed;
}

// ─── LOCK WHISPER (Oracle found answer) ──────────────────────
async function lockWhisper(watcher, verdict, confidence, reasoning, evidence) {
  const { id, whisper_id, whisper_title } = watcher;
  const lockTime = new Date().toISOString();

  console.log(`\n🔒 LOCKING: "${whisper_title}" — ${verdict.toUpperCase()} (${confidence}%)`);

  locked.set(whisper_id, Date.now());

  // Update OracleWatcher to locked
  await patchBase44("OracleWatcher", id, {
    status: "fetched",
    oracle_verdict: verdict,
    oracle_confidence: confidence,
    oracle_reasoning: reasoning,
    evidence_found: evidence
  });

  // Lock the Whisper — starts 15-min window
  await patchBase44("Whisper", whisper_id, {
    status: "locked",
    oracle_lock_time: lockTime,
    reveal_scheduled_for: new Date(Date.now() + LOCK_TO_REVEAL_MS).toISOString()
  });


  // Notify all voters — Oracle has locked, reveal in 15 min
  await notifyAllVoters(
    whisper_id,
    whisper_title,
    "oracle_locked",
    `🔒 The Oracle has found the answer. The Chamber opens in 15 minutes. Be present for the reveal.`
  );

  // Schedule reveal in 15 minutes
  const timer = setTimeout(() => executeReveal(watcher, verdict, confidence, reasoning), LOCK_TO_REVEAL_MS);
  revealTimers.set(whisper_id, timer);

  console.log(`[ORACLE] ⏳ Reveal scheduled in 15 minutes for "${whisper_title}"`);
}

// ─── EXECUTE REVEAL ───────────────────────────────────────────
async function executeReveal(watcher, verdict, confidence, reasoning) {
  const { id, whisper_id, whisper_title } = watcher;
  const ts = new Date().toISOString();

  console.log(`\n🏺 REVEALING: "${whisper_title}" — ${verdict.toUpperCase()}`);

  await Promise.all([
    patchBase44("OracleWatcher", id, {
      status: "revealed",
      revealed_at: ts
    }),
    patchBase44("Whisper", whisper_id, {
      status: "revealed",
      verdict,
      confidence,
      narrative: reasoning,
      revealed_at: ts
    })
  ]);

  // Notify all voters — verdict is in
  const verdictUpper = verdict.toUpperCase();
  await notifyAllVoters(
    whisper_id,
    whisper_title,
    "oracle_revealed",
    `🏺 The Oracle has spoken. Enter the Chamber to witness the verdict on "${whisper_title.slice(0, 50)}..."`
  );

  locked.delete(whisper_id);
  revealTimers.delete(whisper_id);
  console.log(`[ORACLE] ✓ Revealed: "${whisper_title}" 🏺\n`);
}

// ─── BOOT-TIME REVEAL RECOVERY ───────────────────────────────
// In-memory revealTimers are lost on restart. Without this, any whisper
// locked before a restart stays locked forever and never reveals.
async function recoverRevealTimers() {
  try {
    const whispers = await listLockedWhispers();
    if (whispers.length === 0) {
      console.log("[RECOVERY] No locked whispers to recover");
      return { recovered: 0, fired: 0, scheduled: 0, skipped: 0 };
    }

    console.log(`[RECOVERY] Found ${whispers.length} locked whisper(s) to recover`);
    const now = Date.now();
    let fired = 0, scheduled = 0, skipped = 0;

    for (const whisper of whispers) {
      const whisperId = whisper.id;

      if (revealTimers.has(whisperId)) { skipped++; continue; }

      const revealAt = whisper.reveal_scheduled_for ? Date.parse(whisper.reveal_scheduled_for) : NaN;
      if (!Number.isFinite(revealAt)) {
        console.log(`[RECOVERY] Whisper ${whisperId} missing reveal_scheduled_for — skipping`);
        skipped++;
        continue;
      }

      const watcher = await getWatcherByWhisperId(whisperId);
      if (!watcher) {
        console.log(`[RECOVERY] No watcher for locked whisper ${whisperId} — skipping`);
        skipped++;
        continue;
      }

      const watcherArg = {
        id: watcher.id,
        whisper_id: whisperId,
        whisper_title: whisper.title || watcher.whisper_title || ""
      };
      const verdict = watcher.oracle_verdict;
      const confidence = watcher.oracle_confidence;
      const reasoning = watcher.oracle_reasoning;

      locked.set(whisperId, Date.parse(whisper.oracle_lock_time) || now);

      const remaining = revealAt - now;
      if (remaining <= 0) {
        console.log(`[RECOVERY] Reveal overdue for "${watcherArg.whisper_title}" — firing now`);
        executeReveal(watcherArg, verdict, confidence, reasoning).catch((e) =>
          console.error("[RECOVERY] executeReveal error:", e.message)
        );
        fired++;
      } else {
        console.log(`[RECOVERY] Re-scheduling reveal for "${watcherArg.whisper_title}" in ${Math.round(remaining / 1000)}s`);
        const timer = setTimeout(
          () => executeReveal(watcherArg, verdict, confidence, reasoning),
          remaining
        );
        revealTimers.set(whisperId, timer);
        scheduled++;
      }
    }

    console.log(`[RECOVERY] Done — fired: ${fired}, scheduled: ${scheduled}, skipped: ${skipped}`);
    return { recovered: whispers.length, fired, scheduled, skipped };
  } catch (e) {
    console.error("[RECOVERY] Error recovering reveal timers:", e.message);
    return { recovered: 0, fired: 0, scheduled: 0, skipped: 0, error: e.message };
  }
}

// ─── MAIN POLL LOOP ───────────────────────────────────────────
async function pollWatchers() {
  try {
    const watchers = await getWatchers();
    if (watchers.length === 0) return;

    console.log(`[POLL] Checking ${watchers.length} active watcher(s)...`);

    for (const watcher of watchers) {
      // Skip if already locked
      if (locked.has(watcher.whisper_id)) continue;

      // Smart polling intensity based on check_after_date
      const now = Date.now();
      const checkAfterDate = watcher.check_after_date ? new Date(watcher.check_after_date).getTime() : null;
      const last = lastChecked.get(watcher.whisper_id) || 0;
      const checkInterval = decidePollInterval(now, checkAfterDate);

      if (now - last < checkInterval) continue;

      lastChecked.set(watcher.whisper_id, Date.now());

      try {
        // Run both checks in parallel
        const [disruption, evidence] = await Promise.all([
          checkForDisruption(watcher),
          checkForEvidence(watcher)
        ]);

        if (disruption.disrupted) {
          // Mark unverifiable with reason
          console.log(`\n⚠️ DISRUPTED: "${watcher.whisper_title}" — ${disruption.reason}`);
          await Promise.all([
            patchBase44("OracleWatcher", watcher.id, { status: "revealed", oracle_verdict: "unverifiable", oracle_reasoning: disruption.reason, revealed_at: new Date().toISOString() }),
            patchBase44("Whisper", watcher.whisper_id, { status: "unverifiable", unverifiable_reason: disruption.reason, revealed_at: new Date().toISOString() })
          ]);
          locked.delete(watcher.whisper_id);
        } else if (evidence.has_answer && evidence.confidence >= CONFIDENCE_THRESHOLD) {
          await lockWhisper(watcher, evidence.verdict, evidence.confidence, evidence.reasoning, evidence.evidence);
        } else {
          console.log(`[POLL] No answer yet for "${watcher.whisper_title}" (confidence: ${evidence.confidence || 0}%)`);
        }
      } catch(e) {
        console.error(`[POLL] Error checking "${watcher.whisper_title}":`, e.message);
      }
    }
  } catch(e) {
    console.error("[POLL] Error:", e.message);
  }
}

function startBackgroundPolling() {
  const pollTimer = setInterval(pollWatchers, POLL_INTERVAL_MS);
  const initialTimer = setTimeout(async () => {
    try {
      console.log("[STARTUP] Running initial poll...");
      await pollWatchers();
    } catch (e) {
      console.error("[STARTUP] Error during initial poll (will retry):", e.message);
      // Don't exit — let the service stay up and retry on next poll interval
    }
  }, 5000);
  return { pollTimer, initialTimer };
}

function installProcessGuards() {
  // Catch unhandled promise rejections
  process.on("unhandledRejection", (reason, promise) => {
    console.error("[ERROR] Unhandled rejection (will continue):", reason);
    // Don't exit — let the service continue running
  });

  // Catch synchronous uncaught exceptions
  process.on("uncaughtException", (error) => {
    console.error("[ERROR] Uncaught exception (will continue):", error.message, error.stack);
    // Don't exit — let the service continue running
  });
}

// ─── ENDPOINTS ────────────────────────────────────────────────

// Manual reveal trigger
app.post("/reveal", async (req, res) => {
  const { watcher_id, whisper_id, whisper_title, urls, oracle_hint } = req.body;
  if (!watcher_id || !whisper_id) return res.status(400).json({ error: "Missing fields" });
  res.json({ status: "checking" });
  const watcher = { id: watcher_id, whisper_id, whisper_title, urls: urls || [], oracle_hint };
  try {
    const result = await checkForEvidence(watcher);
    if (result.has_answer) {
      await lockWhisper(watcher, result.verdict, result.confidence, result.reasoning, result.evidence);
    } else {
      console.log(`[MANUAL] No conclusive answer found for "${whisper_title}"`);
    }
  } catch(e) {
    console.error("[MANUAL] Error:", e.message);
  }
});

// Date recommendation
app.post("/recommend-date", async (req, res) => {
  const { whisper_title, category, symbol_or_topic } = req.body;
  if (!whisper_title) return res.status(400).json({ error: "Missing whisper_title" });

  // Source priority by category
  const sourcesByCategory = {
    stocks_crypto: ["https://coinmarketcap.com", "https://finance.yahoo.com/markets"],
    sports: ["https://www.espn.com", "https://www.bbc.com/sport"],
    politics: ["https://www.reuters.com", "https://www.bbc.com/news"],
    entertainment: ["https://variety.com", "https://deadline.com"],
    streaming_influencers: ["https://socialblade.com", "https://www.youtube.com/feed/trending"]
  };

  const urls = sourcesByCategory[category] || sourcesByCategory.politics;

  try {
    const fetchResults = await Promise.all(urls.slice(0, 2).map(_fetchURL));
    const contentBlock = fetchResults
      .map(f => f.success ? `--- ${f.url} ---\n${f.content}` : `--- ${f.url} --- UNAVAILABLE ---`)
      .join("\n\n");

    const today = new Date().toISOString();
    const raw = await callClaude(
      `You are the Oracle of Amphoracle. Today is ${today}. Recommend the best date/time for this whisper to be verified based on when the answer will be known. Respond in JSON only: {"recommended_date":"ISO 8601","reason":"one sentence","confidence":"high/medium/low"}`,
      `WHISPER: "${whisper_title}"\nCATEGORY: ${category}\nTOPIC: ${symbol_or_topic || ""}\n\nSOURCES:\n${contentBlock}`,
      300
    );

    const result = parseClaudeJSON(raw);
    res.json({ success: true, ...result });
  } catch(e) {
    // Fallback
    const fallback = new Date();
    fallback.setDate(fallback.getDate() + 7);
    fallback.setUTCHours(20, 0, 0, 0);
    res.json({ success: false, recommended_date: fallback.toISOString(), reason: "Default — 7 days", confidence: "low" });
  }
});

// ─── SCOUT ENDPOINT — Archon research tool ───────────────────
// Searches real sources and returns 3 real whispers with real dates
app.post("/scout", async (req, res) => {
  const { topic, category } = req.body;
  if (!topic || !category) return res.status(400).json({ error: "Missing topic or category" });

  console.log(`[SCOUT] Searching for real events: "${topic}" in ${category}`);

  // Priority sources by category — most reliable first
  const sourcesByCategory = {
    sports: [
      `https://www.espn.com/search/results?q=${encodeURIComponent(topic)}`,
      `https://www.bbc.com/sport`,
      `https://www.sofascore.com`,
      `https://www.flashscore.com`
    ],
    stocks_crypto: [
      `https://finance.yahoo.com/search?p=${encodeURIComponent(topic)}`,
      `https://coinmarketcap.com/currencies/${encodeURIComponent(topic.toLowerCase())}/`,
      `https://www.marketwatch.com/search?q=${encodeURIComponent(topic)}`
    ],
    politics: [
      `https://www.reuters.com/search/news?blob=${encodeURIComponent(topic)}`,
      `https://apnews.com/search?q=${encodeURIComponent(topic)}`,
      `https://www.bbc.com/news`
    ],
    entertainment: [
      `https://variety.com/?s=${encodeURIComponent(topic)}`,
      `https://deadline.com/?s=${encodeURIComponent(topic)}`,
      `https://www.hollywoodreporter.com/search/?q=${encodeURIComponent(topic)}`
    ],
    streaming_influencers: [
      `https://socialblade.com/search/query?query=${encodeURIComponent(topic)}`,
      `https://www.youtube.com/results?search_query=${encodeURIComponent(topic)}`,
      `https://twitter.com/search?q=${encodeURIComponent(topic)}&f=news`
    ]
  };

  const urls = sourcesByCategory[category] || sourcesByCategory.politics;

  try {
    // Fetch top 3 sources in parallel
    const fetchResults = await Promise.all(urls.slice(0, 3).map(_fetchURL));
    const successfulFetches = fetchResults.filter(f => f.success);

    if (successfulFetches.length === 0) {
      throw new Error("Could not fetch any sources");
    }

    const contentBlock = fetchResults
      .map(f => f.success
        ? `--- SOURCE: ${f.url} ---\n${f.content}`
        : `--- SOURCE: ${f.url} --- UNAVAILABLE ---`)
      .join("\n\n");

    const today = new Date().toISOString();
    const todayDate = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    const raw = await callClaude(
      `You are The Archon of Amphoracle. Today is ${today} (${todayDate}).

Your job: find REAL upcoming events related to the topic from the live sources provided, then create exactly 3 binary prediction whispers.

CRITICAL RULES:
1. ONLY use events you can actually see in the sources — NO hallucination, NO guessing
2. Every whisper title MUST include the REAL event date you found in the sources
3. All dates must be AFTER today (${today})
4. Every whisper must be answerable TRUE or FALSE
5. If you cannot find 3 real events, create fewer — never invent fake events
6. Format dates as "Month Dayth Year" e.g. "April 15th 2026"

Respond in JSON only, no markdown:
{
  "whispers": [
    {
      "title": "Will [topic] [do something] on [REAL DATE from sources]?",
      "category": "${category}",
      "symbol_or_topic": "${topic}",
      "verification_hint": "exactly what to check and where",
      "sources": ["primary url to verify", "secondary url"],
      "check_after_date": "ISO 8601 datetime",
      "duration_type": "daily|weekly|monthly|yearly",
      "event_found": "the real event name and date you found in the sources"
    }
  ]
}`,
      `TOPIC: "${topic}"\nCATEGORY: ${category}\n\nLIVE SOURCE CONTENT:\n${contentBlock}`,
      1200
    );

    const parsed = parseClaudeJSON(raw);
    const whispers = parsed.whispers || [];

    if (whispers.length === 0) {
      return res.json({
        success: false,
        error: "No real upcoming events found for this topic",
        whispers: []
      });
    }

    // Validate all dates are in the future
    const validWhispers = filterFutureWhispers(whispers, Date.now());

    console.log(`[SCOUT] Found ${validWhispers.length} real events for "${topic}"`);
    res.json({ success: true, whispers: validWhispers });

  } catch(e) {
    console.error(`[SCOUT] Failed:`, e.message);
    res.status(500).json({ success: false, error: e.message, whispers: [] });
  }
});

// Health check
app.get("/", (req, res) => res.json({
  status: "online",
  service: "Amphoracle Watcher v4.1",
  oracle: "hunting",
  active_watchers_checked: lastChecked.size,
  locked_pending_reveal: locked.size,
  uptime: Math.floor(process.uptime())
}));

const PORT = process.env.PORT || 3000;

// Only auto-start when run directly — not when required from tests.
if (require.main === module) {
  installProcessGuards();
  recoverRevealTimers().catch((e) => console.error("[RECOVERY] Boot error:", e.message));
  startBackgroundPolling();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n🏺 Amphoracle Watcher v4.1 — Evidence-Based Oracle — Port ${PORT}`);
    console.log(`[STARTUP] Server listening on port ${PORT}. Initial poll in 5 seconds...\n`);
  });
}

module.exports = {
  app,
  // functions
  httpRequest,
  fetchURL,
  callClaude,
  createNotification,
  getVotersForWhisper,
  notifyAllVoters,
  patchBase44,
  getWatchers,
  listLockedWhispers,
  getWatcherByWhisperId,
  recoverRevealTimers,
  checkForDisruption,
  checkForEvidence,
  lockWhisper,
  executeReveal,
  pollWatchers,
  startBackgroundPolling,
  // state
  locked,
  lastChecked,
  revealTimers,
  // constants
  CONFIDENCE_THRESHOLD,
  LOCK_TO_REVEAL_MS,
  POLL_INTERVAL_MS,
  PER_WHISPER_CHECK_INTERVAL,
  // test injection points
  __setHttpRequest(fn) { _httpRequest = fn; },
  __resetHttpRequest() { _httpRequest = httpRequest; },
  __setFetchURL(fn) { _fetchURL = fn; },
  __resetFetchURL() { _fetchURL = fetchURL; },
};
