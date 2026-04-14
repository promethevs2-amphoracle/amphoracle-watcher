// ============================================================
// AMPHORACLE WATCHER SERVER v4.0
// Evidence-based Oracle — no fixed reveal dates
// Polls continuously, locks on confidence, reveals after 15 min
// ============================================================

const express = require("express");
const cheerio = require("cheerio");
const https = require("https");
const http = require("http");

const app = express();
app.use(express.json());

const BASE44_API = "https://api.base44.com/api/apps/69d1545f93121e831922ce33/entities";
const BASE44_KEY = process.env.BASE44_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

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

// ─── CALL CLAUDE ─────────────────────────────────────────────
async function callClaude(systemPrompt, userMessage, maxTokens = 800) {
  const body = JSON.stringify({
    model: "claude-opus-4-6",
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }]
  });

  const res = await httpRequest({
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
async function patchBase44(entity, id, payload) {
  const body = JSON.stringify(payload);
  return httpRequest({
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
  const res = await httpRequest({
    protocol: "https:",
    hostname: "api.base44.com",
    path: "/api/apps/69d1545f93121e831922ce33/entities/OracleWatcher?status=pending&limit=100",
    method: "GET",
    headers: { "x-api-key": BASE44_KEY }
  });
  return (res.data && res.data.entities) || [];
}

// ─── DISRUPTION CHECK ────────────────────────────────────────
async function checkForDisruption(watcher) {
  const { whisper_title, urls, oracle_hint } = watcher;

  const fetchResults = await Promise.all((urls || []).slice(0, 2).map(fetchURL));
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

  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

// ─── ORACLE EVIDENCE CHECK ────────────────────────────────────
async function checkForEvidence(watcher) {
  const { id, whisper_id, whisper_title, urls, oracle_hint } = watcher;

  // Fetch all sources
  const fetchResults = await Promise.all((urls || []).map(fetchURL));
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
  const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
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

  locked.delete(whisper_id);
  revealTimers.delete(whisper_id);
  console.log(`[ORACLE] ✓ Revealed: "${whisper_title}" 🏺\n`);
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

      // Rate limit: don't check same whisper more than once per 5 min
      const last = lastChecked.get(watcher.whisper_id) || 0;
      if (Date.now() - last < PER_WHISPER_CHECK_INTERVAL) continue;

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

// Start polling
setInterval(pollWatchers, POLL_INTERVAL_MS);
setTimeout(pollWatchers, 5000);

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
    const fetchResults = await Promise.all(urls.slice(0, 2).map(fetchURL));
    const contentBlock = fetchResults
      .map(f => f.success ? `--- ${f.url} ---\n${f.content}` : `--- ${f.url} --- UNAVAILABLE ---`)
      .join("\n\n");

    const today = new Date().toISOString();
    const raw = await callClaude(
      `You are the Oracle of Amphoracle. Today is ${today}. Recommend the best date/time for this whisper to be verified based on when the answer will be known. Respond in JSON only: {"recommended_date":"ISO 8601","reason":"one sentence","confidence":"high/medium/low"}`,
      `WHISPER: "${whisper_title}"\nCATEGORY: ${category}\nTOPIC: ${symbol_or_topic || ""}\n\nSOURCES:\n${contentBlock}`,
      300
    );

    const result = JSON.parse(raw.replace(/```json|```/g, "").trim());
    res.json({ success: true, ...result });
  } catch(e) {
    // Fallback
    const fallback = new Date();
    fallback.setDate(fallback.getDate() + 7);
    fallback.setUTCHours(20, 0, 0, 0);
    res.json({ success: false, recommended_date: fallback.toISOString(), reason: "Default — 7 days", confidence: "low" });
  }
});

// Health check
app.get("/", (req, res) => res.json({
  status: "online",
  service: "Amphoracle Watcher v4.0",
  oracle: "hunting",
  active_watchers_checked: lastChecked.size,
  locked_pending_reveal: locked.size,
  uptime: Math.floor(process.uptime())
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n🏺 Amphoracle Watcher v4.0 — Evidence-Based Oracle — Port ${PORT}\n`));
