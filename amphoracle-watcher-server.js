// AMPHORACLE WATCHER SERVER v2.2
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const cheerio = require("cheerio");
const axios = require("axios");

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const BASE44_API = "https://api.base44.com/api/apps/69d1545f93121e831922ce33/entities";
const BASE44_KEY = process.env.BASE44_API_KEY;
const PRE_FETCH_SECONDS = 60;
const scheduled = new Set();

async function checkPendingWatchers() {
  try {
    const res = await axios.get(`${BASE44_API}/OracleWatcher`, {
      params: { status: "pending", limit: 100 },
      headers: { "x-api-key": BASE44_KEY }
    });
    const watchers = res.data.entities || [];
    const now = Date.now();
    for (const watcher of watchers) {
      if (scheduled.has(watcher.id)) continue;
      const revealTime = new Date(watcher.reveal_date).getTime();
      const msUntilFetch = revealTime - PRE_FETCH_SECONDS * 1000 - now;
      if (msUntilFetch <= 0) {
        console.log(`[SCHEDULER] Immediate: "${watcher.whisper_title}"`);
        scheduled.add(watcher.id);
        runReveal(watcher);
      } else if (msUntilFetch <= 120000) {
        console.log(`[SCHEDULER] Scheduled in ${Math.round(msUntilFetch/1000)}s: "${watcher.whisper_title}"`);
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
    const res = await axios.get(fullUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AmphoracleOracle/1.0)" },
      timeout: 10000
    });
    const $ = cheerio.load(res.data);
    $("script, style, nav, footer, header, aside").remove();
    const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, 8000);
    return { url, content: text, success: true };
  } catch (err) {
    return { url, content: null, success: false, error: err.message };
  }
}

async function getOracleVerdict(whisperTitle, oracleHint, fetchedContents) {
  const contentBlock = fetchedContents
    .map(f => f.success ? `--- SOURCE: ${f.url} ---\n${f.content}` : `--- SOURCE: ${f.url} --- FAILED: ${f.error}`)
    .join("\n\n");

  const response = await anthropic.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 1000,
    thinking: { type: "enabled", budget_tokens: 8000 },
    system: `You are the Oracle of Amphoracle. Deliver your verdict as JSON only:
{"verdict":"true or false or unverifiable","confidence":0-100,"reasoning":"2-3 sentences in Oracle voice"}`,
    messages: [{
      role: "user",
      content: `WHISPER: "${whisperTitle}"\nORACLE HINT: ${oracleHint}\nLIVE CONTENT:\n${contentBlock}\nDeliver your verdict.`
    }]
  });

  const textBlock = response.content.find(b => b.type === "text");
  if (!textBlock) throw new Error("No text response");
  return JSON.parse(textBlock.text.replace(/```json|```/g, "").trim());
}

async function writeVerdict(watcherId, whisperId, revealDate, verdict, confidence, reasoning) {
  const msToReveal = new Date(revealDate).getTime() - Date.now();
  if (msToReveal > 0) {
    console.log(`[ORACLE] Holding for ${Math.round(msToReveal/1000)}s...`);
    await new Promise(resolve => setTimeout(resolve, msToReveal));
  }
  const ts = new Date().toISOString();
  await Promise.all([
    axios.patch(`${BASE44_API}/OracleWatcher/${watcherId}`,
      { status: "revealed", oracle_verdict: verdict, oracle_confidence: confidence, oracle_reasoning: reasoning, revealed_at: ts },
      { headers: { "Content-Type": "application/json", "x-api-key": BASE44_KEY } }
    ),
    axios.patch(`${BASE44_API}/Whisper/${whisperId}`,
      { status: "revealed", verdict, confidence, narrative: reasoning, revealed_at: ts },
      { headers: { "Content-Type": "application/json", "x-api-key": BASE44_KEY } }
    )
  ]);
}

async function runReveal(watcher) {
  const { id, whisper_id, whisper_title, urls, oracle_hint, reveal_date } = watcher;
  console.log(`\n🏺 Revealing: "${whisper_title}"`);
  await axios.patch(`${BASE44_API}/OracleWatcher/${id}`,
    { status: "fetching" },
    { headers: { "Content-Type": "application/json", "x-api-key": BASE44_KEY } }
  );
  try {
    const fetchResults = await Promise.all((urls || []).map(fetchURL));
    console.log(`[ORACLE] Fetched ${fetchResults.filter(f => f.success).length}/${fetchResults.length} URLs`);
    const { verdict, confidence, reasoning } = await getOracleVerdict(
      whisper_title,
      oracle_hint || "Determine if the prediction came true.",
      fetchResults
    );
    console.log(`[ORACLE] VERDICT: ${verdict.toUpperCase()} — ${confidence}%`);
    await writeVerdict(id, whisper_id, reveal_date, verdict, confidence, reasoning);
    console.log(`[ORACLE] ✓ Done. 🏺\n`);
  } catch (err) {
    console.error(`[ORACLE] Failed:`, err.message);
    await axios.patch(`${BASE44_API}/OracleWatcher/${id}`,
      { status: "failed", error_message: err.message },
      { headers: { "Content-Type": "application/json", "x-api-key": BASE44_KEY } }
    );
    scheduled.delete(id);
  }
}

app.post("/reveal", async (req, res) => {
  const { watcher_id, whisper_id, whisper_title, urls, oracle_hint, reveal_date } = req.body;
  if (!watcher_id || !whisper_id) return res.status(400).json({ error: "Missing fields" });
  res.json({ status: "processing" });
  runReveal({ id: watcher_id, whisper_id, whisper_title, urls: urls || [], oracle_hint, reveal_date: reveal_date || new Date().toISOString() });
});

app.get("/", (req, res) => {
  res.json({ status: "online", service: "Amphoracle Watcher Server v2.2", oracle: "watching", scheduled_watchers: scheduled.size, uptime: Math.floor(process.uptime()) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n🏺 Amphoracle Watcher Server v2.2 — Port ${PORT}\n`));
