const express = require("express");
const cheerio = require("cheerio");
const https = require("https");
const http = require("http");

const app = express();
app.use(express.json());

const BASE44_API = "https://api.base44.com/api/apps/69d1545f93121e831922ce33/entities";
const BASE44_KEY = process.env.BASE44_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const PRE_FETCH_SECONDS = 60;
const scheduled = new Set();

// Simple HTTP request helper - no external deps
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

function fetchURL(url) {
  return new Promise((resolve) => {
    const fullUrl = url.startsWith("http") ? url : "https://" + url;
    const parsed = new URL(fullUrl);
    const options = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AmphoracleOracle/1.0)" },
    };
    const lib = parsed.protocol === "http:" ? http : https;
    let data = "";
    const req = lib.request(options, (res) => {
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          const $ = cheerio.load(data);
          $("script, style, nav, footer, header").remove();
          const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, 6000);
          resolve({ url, content: text, success: true });
        } catch(e) {
          resolve({ url, content: data.slice(0, 6000), success: true });
        }
      });
    });
    req.on("error", (e) => resolve({ url, content: null, success: false, error: e.message }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ url, content: null, success: false, error: "Timeout" }); });
    req.end();
  });
}

async function callClaude(whisperTitle, oracleHint, fetchedContents) {
  const contentBlock = fetchedContents
    .map(f => f.success ? `--- SOURCE: ${f.url} ---\n${f.content}` : `--- SOURCE: ${f.url} --- FAILED: ${f.error}`)
    .join("\n\n");

  const body = JSON.stringify({
    model: "claude-opus-4-6",
    max_tokens: 1000,
    system: `You are the Oracle of Amphoracle. Deliver your verdict as JSON only, no markdown:
{"verdict":"true","confidence":85,"reasoning":"Oracle voice explanation"}
verdict must be: true, false, or unverifiable`,
    messages: [{
      role: "user",
      content: `WHISPER: "${whisperTitle}"\nHINT: ${oracleHint}\nCONTENT:\n${contentBlock}\nDeliver verdict as JSON.`
    }]
  });

  const parsed = new URL("https://api.anthropic.com/v1/messages");
  const res = await httpRequest({
    protocol: "https:",
    hostname: parsed.hostname,
    path: parsed.pathname,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Length": Buffer.byteLength(body)
    }
  }, body);

  const textBlock = res.data.content && res.data.content.find(b => b.type === "text");
  if (!textBlock) throw new Error("No text from Claude: " + JSON.stringify(res.data));
  return JSON.parse(textBlock.text.replace(/```json|```/g, "").trim());
}

async function patchBase44(entity, id, payload) {
  const body = JSON.stringify(payload);
  const parsed = new URL(`${BASE44_API}/${entity}/${id}`);
  return httpRequest({
    protocol: "https:",
    hostname: parsed.hostname,
    path: parsed.pathname,
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": BASE44_KEY,
      "Content-Length": Buffer.byteLength(body)
    }
  }, body);
}

async function getWatchers() {
  const parsed = new URL(`${BASE44_API}/OracleWatcher?status=pending&limit=100`);
  const res = await httpRequest({
    protocol: "https:",
    hostname: parsed.hostname,
    path: parsed.pathname + parsed.search,
    method: "GET",
    headers: { "x-api-key": BASE44_KEY }
  });
  return (res.data && res.data.entities) || [];
}

async function checkPendingWatchers() {
  try {
    const watchers = await getWatchers();
    const now = Date.now();
    for (const w of watchers) {
      if (scheduled.has(w.id)) continue;
      const revealTime = new Date(w.reveal_date).getTime();
      const msUntilFetch = revealTime - PRE_FETCH_SECONDS * 1000 - now;
      if (msUntilFetch <= 0) {
        console.log(`[SCHEDULER] Immediate: "${w.whisper_title}"`);
        scheduled.add(w.id);
        runReveal(w);
      } else if (msUntilFetch <= 120000) {
        console.log(`[SCHEDULER] In ${Math.round(msUntilFetch/1000)}s: "${w.whisper_title}"`);
        scheduled.add(w.id);
        setTimeout(() => runReveal(w), msUntilFetch);
      }
    }
  } catch(e) {
    console.error("[SCHEDULER] Error:", e.message);
  }
}

async function runReveal(watcher) {
  const { id, whisper_id, whisper_title, urls, oracle_hint, reveal_date } = watcher;
  console.log(`\n🏺 Revealing: "${whisper_title}"`);
  await patchBase44("OracleWatcher", id, { status: "fetching" });
  try {
    const fetchResults = await Promise.all((urls || []).map(fetchURL));
    console.log(`[ORACLE] Fetched ${fetchResults.filter(f=>f.success).length}/${fetchResults.length} URLs`);
    const { verdict, confidence, reasoning } = await callClaude(whisper_title, oracle_hint || "Did this prediction come true?", fetchResults);
    console.log(`[ORACLE] ${verdict.toUpperCase()} — ${confidence}%`);
    const msToReveal = new Date(reveal_date).getTime() - Date.now();
    if (msToReveal > 0) {
      console.log(`[ORACLE] Holding ${Math.round(msToReveal/1000)}s...`);
      await new Promise(r => setTimeout(r, msToReveal));
    }
    const ts = new Date().toISOString();
    await Promise.all([
      patchBase44("OracleWatcher", id, { status: "revealed", oracle_verdict: verdict, oracle_confidence: confidence, oracle_reasoning: reasoning, revealed_at: ts }),
      patchBase44("Whisper", whisper_id, { status: "revealed", verdict, confidence, narrative: reasoning, revealed_at: ts })
    ]);
    console.log(`[ORACLE] ✓ Done. 🏺\n`);
  } catch(e) {
    console.error(`[ORACLE] Failed:`, e.message);
    await patchBase44("OracleWatcher", id, { status: "failed", error_message: e.message });
    scheduled.delete(id);
  }
}

setInterval(checkPendingWatchers, 30000);
setTimeout(checkPendingWatchers, 3000);

// ============================================================
// RECOMMEND DATE ENDPOINT — called when a whisper is being created
// Returns the best reveal date/time based on live web research
// ============================================================
app.post("/recommend-date", async (req, res) => {
  const { whisper_title, category, symbol_or_topic } = req.body;
  if (!whisper_title) return res.status(400).json({ error: "Missing whisper_title" });

  console.log(`[RECOMMEND] Finding best reveal date for: "${whisper_title}"`);

  try {
    // Fetch relevant URLs based on category
    const urlsByCategory = {
      stocks_crypto: ["https://coinmarketcap.com", "https://finance.yahoo.com/markets"],
      sports: ["https://espn.com", "https://bbc.com/sport"],
      politics: ["https://reuters.com", "https://bbc.com/news"],
      entertainment: ["https://variety.com", "https://deadline.com"],
      streaming_influencers: ["https://socialblade.com", "https://youtube.com/trending"]
    };

    const urls = urlsByCategory[category] || ["https://reuters.com", "https://bbc.com/news"];
    const fetchResults = await Promise.all(urls.slice(0, 2).map(fetchURL));
    const contentBlock = fetchResults
      .map(f => f.success ? `--- SOURCE: ${f.url} ---\n${f.content}` : `--- FAILED: ${f.url} ---`)
      .join("\n\n");

    const today = new Date().toISOString();
    const body = JSON.stringify({
      model: "claude-opus-4-6",
      max_tokens: 500,
      system: `You are the Oracle of Amphoracle. Given a prediction whisper, determine the optimal reveal date and time based on real-world events. Today is ${today}.

Rules:
- For sports predictions: recommend the exact end time of the game/event
- For stock/crypto: recommend market close time on the deadline date
- For politics: recommend the stated deadline date at 8pm UTC
- For entertainment releases: recommend the release date at midnight
- Always pick a specific date that makes sense for the prediction to be verified
- Never recommend more than 365 days in the future
- Never recommend less than 1 hour in the future

Respond in JSON only:
{
  "recommended_date": "ISO 8601 datetime string",
  "reason": "One sentence explaining why this date makes sense",
  "confidence": "high/medium/low"
}`,
      messages: [{
        role: "user",
        content: `WHISPER: "${whisper_title}"\nCATEGORY: ${category}\nTOPIC: ${symbol_or_topic || "unknown"}\n\nLIVE CONTENT:\n${contentBlock}\n\nRecommend the best reveal date.`
      }]
    });

    const parsed = new URL("https://api.anthropic.com/v1/messages");
    const claudeRes = await httpRequest({
      protocol: "https:",
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(body)
      }
    }, body);

    const textBlock = claudeRes.data.content && claudeRes.data.content.find(b => b.type === "text");
    if (!textBlock) throw new Error("No response from Claude");

    const result = JSON.parse(textBlock.text.replace(/```json|```/g, "").trim());
    console.log(`[RECOMMEND] ✓ ${result.recommended_date} — ${result.reason}`);
    res.json({ success: true, ...result });

  } catch(e) {
    console.error(`[RECOMMEND] Failed:`, e.message);
    // Fallback: 7 days from now at 8pm UTC
    const fallback = new Date();
    fallback.setDate(fallback.getDate() + 7);
    fallback.setUTCHours(20, 0, 0, 0);
    res.json({
      success: false,
      recommended_date: fallback.toISOString(),
      reason: "Default recommendation — 7 days from now",
      confidence: "low"
    });
  }
});

app.post("/reveal", async (req, res) => {
  const { watcher_id, whisper_id, whisper_title, urls, oracle_hint, reveal_date } = req.body;
  if (!watcher_id || !whisper_id) return res.status(400).json({ error: "Missing fields" });
  res.json({ status: "processing" });
  runReveal({ id: watcher_id, whisper_id, whisper_title, urls: urls||[], oracle_hint, reveal_date: reveal_date||new Date().toISOString() });
});

app.get("/", (req, res) => res.json({ status: "online", service: "Amphoracle Watcher v3.1", oracle: "watching", scheduled: scheduled.size, uptime: Math.floor(process.uptime()) }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n🏺 Amphoracle Watcher v3.1 — Port ${PORT}\n`));
