// ============================================================
// AMPHORACLE WATCHER SERVER v2.1
// ============================================================

import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import * as cheerio from "cheerio";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const BASE44_API = "https://api.base44.com/api/apps/69d1545f93121e831922ce33/entities";
const BASE44_KEY = process.env.BASE44_API_KEY;

const PRE_FETCH_SECONDS = 60;
const scheduled = new Set();

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
        console.log(`[SCHEDULER] ⚡ Immediate: "${watcher.whisper_title}"`);
        scheduled.add(watcher.id);
        runReveal(watcher);
      } else if (msUntilFetch <= 120000) {
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
setTimeout(checkPendingWatchers, 3000);

async function fetchURL(url) {
  try {
    const fullUrl = url.startsWith("http") ? url : `https://${url}`;
    const res = await fetch(fullUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AmphoracleOracle/1.0)" },
      timeout: 10000,
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
        text: `You are the Oracle of Amphoracle. A whisper has reached its reveal moment. Deliver your verdict: TRUE or FALSE.

Respond in this exact JSON format only:
{
  "verdict": "true" or "false" or "unverifiable",
  "confidence": 0-100,
  "reasoning": "2-3 sentences in dramatic Oracle voice"
}`,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: `WHISPER: "${whisperTitle}"\n\nORACLE HINT: ${oracleHint}\n\nLIVE CONTENT:\n${contentBlock}\n\nDeliver your verdict.`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text response from Oracle");
  const clean = textBlock.text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

async function writeVerdict(watcherId, whisperId, revealDate, verdict, confidence, reasoning) {
  const now = Date.now();
  const revealTime = new Date(revealDate).getTime();
  const msToReveal = revealTime - now;

  if (msToReveal > 0) {
    console.log(`[ORACLE] ⏳ Holding for ${Math.round(msToReveal / 1000)}s until exact reveal...`);
    await new Promise((resolve) => setTimeout(resolve, msToReveal));
  }

  const ts = new Date().toISOString();
  await Promise.all([
    fetch(`${BASE44_API}/OracleWatcher/${watcherId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-api-key": BASE44_KEY },
      body: JSON.stringify({ status: "revealed", oracle_verdict: verdict, oracle_confidence: confidence, oracle_reasoning: reasoning, revealed_at: ts }),
    }),
    fetch(`${BASE44_API}/Whisper/${whisperId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-api-key": BASE44_KEY },
      body: JSON.stringify({ status: "revealed", verdict, confidence, narrative: reasoning, revealed_at: ts }),
    }),
  ]);
}

async function runReveal(watcher) {
  const { id, whisper_id, whisper_title, urls, oracle_hint, reveal_date } = watcher;
  console.log(`\n🏺 Revealing: "${whisper_title}"`);

  await fetch(`${BASE44_API}/OracleWatcher/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-api-key": BASE44_KEY },
    body: JSON.stringify({ status: "fetching" }),
  });

  try {
    const fetchResults = await Promise.all((urls || []).map(fetchURL));
    console.log(`[ORACLE] Fetched ${fetchResults.filter((f) => f.success).length}/${fetchResults.length} URLs`);

    const { verdict, confidence, reasoning } = await getOracleVerdict(
      whisper_title,
      oracle_hint || "Determine if the prediction came true.",
      fetchResults
    );
    console.log(`[ORACLE] VERDICT: ${verdict.toUpperCase()} — ${confidence}% confidence`);

    await writeVerdict(id, whisper_id, reveal_date, verdict, confidence, reasoning);
    console.log(`[ORACLE] ✓ The Oracle has spoken. 🏺\n`);
  } catch (err) {
    console.error(`[ORACLE] ✗ Failed:`, err.message);
    await fetch(`${BASE44_API}/OracleWatcher/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-api-key": BASE44_KEY },
      body: JSON.stringify({ status: "failed", error_message: err.message }),
    });
    scheduled.delete(id);
  }
}

app.post("/reveal", async (req, res) => {
  const { watcher_id, whisper_id, whisper_title, urls, oracle_hint, reveal_date } = req.body;
  if (!watcher_id || !whisper_id) return res.status(400).json({ error: "Missing watcher_id or whisper_id" });
  res.json({ status: "processing", message: `Oracle initiated for "${whisper_title}"` });
  runReveal({ id: watcher_id, whisper_id, whisper_title, urls: urls || [], oracle_hint, reveal_date: reveal_date || new Date().toISOString() });
});

app.get("/", (req, res) => {
  res.json({ status: "online", service: "Amphoracle Watcher Server v2.1", oracle: "watching", scheduled_watchers: scheduled.size, uptime_seconds: Math.floor(process.uptime()) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🏺 Amphoracle Watcher Server v2.1 — Port ${PORT}\n`);
});
