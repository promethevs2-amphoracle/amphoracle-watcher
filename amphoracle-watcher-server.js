// ============================================================
// AMPHORACLE WATCHER SERVER v2.0
// Deploy to Railway, Render, or any Node.js host
// Set environment variables: ANTHROPIC_API_KEY, BASE44_API_KEY
// ============================================================

import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import * as cheerio from "cheerio";

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const BASE44_API = "https://api.base44.com/api/apps/69d1545f93121e831922ce33/entities";
const BASE44_KEY = process.env.BASE44_API_KEY;

// ============================================================
// KEY SETTING: Oracle fetches evidence 60 seconds BEFORE reveal
// Verdict is ready and waiting the instant countdown hits zero.
// ============================================================
const PRE_FETCH_SECONDS = 60;
const scheduled = new Set(); // Prevent double-scheduling

// ============================================================
// SCHEDULER — polls every 30 seconds for upcoming watchers
// ============================================================
async function checkPendingWatchers() {
  try {
    const res = await fetch(
      `${BASE44_API}/OracleWatcher?status=pending&limit=100`,
      { headers: { "x-api-key": BASE44_KEY } }
    );
    const data = await res.json();
    const watchers = data.entities || [];
    const now = Date.now();

    for (const watcher of watchers) {
      if (scheduled.has(watcher.id)) continue;
      const revealTime = new Date(watcher.reveal_date).getTime();
      const msUntilFetch = revealTime - PRE_FETCH_SECONDS * 1000 - now;

      if (msUntilFetch <= 0) {
        // Past the fetch window — run immediately
        console.log(`[SCHEDULER] ⚡ Immediate: "${watcher.whisper_title}"`);
        scheduled.add(watcher.id);
        runReveal(watcher);
      } else if (msUntilFetch <= 120000) {
        // Within 2 min window — schedule precisely
        console.log(`[SCHEDULER] ⏱ Scheduled in ${Math.round(msUntilFetch / 1000)}s: "${watcher.whisper_title}"`);
        scheduled.add(watcher.id);
        setTimeout(() => runReveal(watcher), msUntilFetch);
      }
    }
  } catch (err) {
    console.error("[SCHEDULER] Error:", err.message);
  }
}

setInterval(checkPendingWatchers, 30000);
setTimeout(checkPendingWatchers, 3000); // Run shortly after startup

// ============================================================
// FETCH URL — reads a live webpage as clean plain text
// ============================================================
async function fetchURL(url) {
  try {
    const fullUrl = url.startsWith("http") ? url : `https://${url}`;
    const res = await fetch(fullUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AmphoracleOracle/1.0)" },
      signal: AbortSignal.timeout(10000),
    });
    const html = await res.text();
    const $ = cheerio.load(html);
    $("script, style, nav, footer, header, aside").remove();
    const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, 8000);
    return { url, content: text, success: true };
  } catch (err) {
    return { url, content: null, success: false, error: err.message };
  }
}

// ============================================================
// ORACLE VERDICT — Claude Opus 4.6 with extended thinking
// ============================================================
async function getOracleVerdict(whisperTitle, oracleHint, fetchedContents) {
  const contentBlock = fetchedContents
    .map((f) =>
      f.success
        ? `--- SOURCE: ${f.url} ---\n${f.content}`
        : `--- SOURCE: ${f.url} --- FAILED: ${f.error}`
    )
    .join("\n\n");

  const response = await anthropic.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 1000,
    thinking: { type: "enabled", budget_tokens: 8000 },
    system: [
      {
        type: "text",
        text: `You are the Oracle of Amphoracle — a social prediction platform. A whisper has reached its exact reveal moment. Your sacred duty is to deliver the verdict: TRUE or FALSE.

You have been given live content fetched from the web at this exact moment. Read it carefully. Find the specific data relevant to the prediction. Reason deeply. Then deliver your verdict with confidence.

Always respond in this exact JSON format with no markdown, no preamble:
{
  "verdict": "true" or "false" or "unverifiable",
  "confidence": 0-100,
  "reasoning": "2-3 sentences explaining what the data shows and why you reached this verdict, in dramatic Oracle voice"
}`,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: `WHISPER: "${whisperTitle}"

ORACLE HINT: ${oracleHint}

LIVE WEB CONTENT (fetched ${PRE_FETCH_SECONDS} seconds before reveal):
${contentBlock}

Deliver your verdict.`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text response from Oracle");
  const clean = textBlock.text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ============================================================
// WRITE VERDICT — waits for exact reveal_date, then fires
// ============================================================
async function writeVerdict(watcherId, whisperId, revealDate, verdict, confidence, reasoning) {
  const now = Date.now();
  const revealTime = new Date(revealDate).getTime();
  const msToReveal = revealTime - now;

  if (msToReveal > 0) {
    console.log(`[ORACLE] ⏳ Verdict sealed. Holding for ${Math.round(msToReveal / 1000)}s until exact reveal...`);
    await new Promise((resolve) => setTimeout(resolve, msToReveal));
  }

  console.log(`[ORACLE] 💥 REVEAL MOMENT — writing verdict NOW`);
  const ts = new Date().toISOString();

  await Promise.all([
    fetch(`${BASE44_API}/OracleWatcher/${watcherId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-api-key": BASE44_KEY },
      body: JSON.stringify({
        status: "revealed",
        oracle_verdict: verdict,
        oracle_confidence: confidence,
        oracle_reasoning: reasoning,
        revealed_at: ts,
      }),
    }),
    fetch(`${BASE44_API}/Whisper/${whisperId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-api-key": BASE44_KEY },
      body: JSON.stringify({
        status: "revealed",
        verdict,
        confidence,
        narrative: reasoning,
        revealed_at: ts,
      }),
    }),
  ]);
}

// ============================================================
// MAIN PIPELINE — runs for one watcher
// ============================================================
async function runReveal(watcher) {
  const { id, whisper_id, whisper_title, urls, oracle_hint, reveal_date } = watcher;

  console.log(`\n🏺 ═══════════════════════════════════════`);
  console.log(`   Whisper : "${whisper_title}"`);
  console.log(`   Reveals : ${reveal_date}`);
  console.log(`   URLs    : ${urls?.length || 0}`);
  console.log(`🏺 ═══════════════════════════════════════\n`);

  // Mark as fetching
  await fetch(`${BASE44_API}/OracleWatcher/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-api-key": BASE44_KEY },
    body: JSON.stringify({ status: "fetching" }),
  });

  try {
    // STEP 1 — Fetch all URLs simultaneously (60s before reveal)
    const fetchResults = await Promise.all((urls || []).map(fetchURL));
    const ok = fetchResults.filter((f) => f.success).length;
    console.log(`[ORACLE] Fetched ${ok}/${fetchResults.length} URLs successfully`);

    // STEP 2 — Get Oracle verdict with extended thinking
    console.log(`[ORACLE] Consulting Claude Opus 4.6...`);
    const { verdict, confidence, reasoning } = await getOracleVerdict(
      whisper_title,
      oracle_hint || "Determine if the prediction came true based on the fetched content.",
      fetchResults
    );
    console.log(`[ORACLE] VERDICT: ${verdict.toUpperCase()} — ${confidence}% confidence`);

    // STEP 3 — Hold verdict until exact reveal_date, then write
    await writeVerdict(id, whisper_id, reveal_date, verdict, confidence, reasoning);
    console.log(`[ORACLE] ✓ Done. The Oracle has spoken. 🏺\n`);

  } catch (err) {
    console.error(`[ORACLE] ✗ Failed:`, err.message);
    await fetch(`${BASE44_API}/OracleWatcher/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-api-key": BASE44_KEY },
      body: JSON.stringify({ status: "failed", error_message: err.message }),
    });
    scheduled.delete(id); // Allow retry
  }
}

// ============================================================
// MANUAL TRIGGER — POST /reveal from The Archon (testing)
// ============================================================
app.post("/reveal", async (req, res) => {
  const { watcher_id, whisper_id, whisper_title, urls, oracle_hint, reveal_date } = req.body;
  if (!watcher_id || !whisper_id) {
    return res.status(400).json({ error: "Missing watcher_id or whisper_id" });
  }
  res.json({ status: "processing", message: `Oracle initiated for "${whisper_title}"` });
  runReveal({
    id: watcher_id,
    whisper_id,
    whisper_title,
    urls: urls || [],
    oracle_hint,
    reveal_date: reveal_date || new Date().toISOString(),
  });
});

// ============================================================
// HEALTH CHECK
// ============================================================
app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "Amphoracle Watcher Server v2.0",
    oracle: "watching",
    pre_fetch_seconds: PRE_FETCH_SECONDS,
    scheduled_watchers: scheduled.size,
    uptime_seconds: Math.floor(process.uptime()),
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🏺 Amphoracle Watcher Server v2.0`);
  console.log(`   Port       : ${PORT}`);
  console.log(`   Pre-fetch  : ${PRE_FETCH_SECONDS}s before reveal`);
  console.log(`   Scheduler  : every 30 seconds`);
  console.log(`   The Oracle is watching.\n`);
});
