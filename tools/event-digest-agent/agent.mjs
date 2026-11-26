#!/usr/bin/env node
// Mac mini side of the event AI digest (#879) — a STUB until the Mac mini arrives.
//
// Dials OUT to event-service's EventDigestHub DO over a WebSocket (no inbound port at
// home), answers {t:"req", id, op, payload} frames with {t:"res", id, ok, body}, and
// keeps the link alive with "ping" (answered by the DO runtime without waking it).
//
//   DIGEST_HUB_URL=wss://<event-digest host>/agent/event-digest/ws \
//   DIGEST_AGENT_SECRET=... \
//   LOCAL_LLM_URL=http://127.0.0.1:8080/v1/chat/completions \   # optional; absent => echo mode
//   node tools/event-digest-agent/agent.mjs
//
// Node 22+ (global WebSocket). No dependencies on purpose.
const HUB = process.env.DIGEST_HUB_URL;
const SECRET = process.env.DIGEST_AGENT_SECRET;
const LLM = process.env.LOCAL_LLM_URL ?? "";
const MODEL = process.env.LOCAL_LLM_MODEL ?? "inkling-2-mini";
if (!HUB || !SECRET) {
  console.error("DIGEST_HUB_URL and DIGEST_AGENT_SECRET are required");
  process.exit(2);
}

const PING_MS = 30_000;
let backoff = 1_000;

/** Ask the local model; null when no model is configured (echo mode). */
async function complete(system, user) {
  if (!LLM) return null;
  const res = await fetch(LLM, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, temperature: 0.2, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`local llm ${res.status}`);
  const j = await res.json();
  return j.choices?.[0]?.message?.content ?? "";
}

// summarize: input = { event, changed[], all[], previous }. Every returned line MUST carry
// a link copied from an input item — event-service drops any line whose link it did not
// produce, so an invented source can never reach the screen.
async function summarize(input) {
  const items = (input?.all ?? []).flatMap((s) => s.items ?? []);
  const text = await complete(
    "あなたはイベント運営のまとめ係です。与えられた項目だけを使い、1行1文で要点を日本語で書きます。各行は JSON {\"text\",\"source\",\"link\"} で、link は必ず入力の link をそのまま使います。JSON 配列だけを返します。",
    JSON.stringify({ event: input?.event, changed: input?.changed, items }),
  );
  if (text === null) return { lines: items.slice(0, 20).map((i) => ({ text: i.text, source: i.source, link: i.link })) };
  try {
    const lines = JSON.parse(text);
    return { lines: Array.isArray(lines) ? lines : [] };
  } catch {
    return { lines: [] };
  }
}

// ask: { eventId, question }. Phase 2 answers from the LOCAL index (SQLite + vectors on
// this Mac mini, rebuilt from Cloudflare-side reads). Not built yet: say so honestly.
async function ask(payload) {
  return { answer: `まだ質問には答えられません（ローカル索引は準備中）: ${String(payload?.question ?? "").slice(0, 50)}`, sources: [] };
}

function connect() {
  const ws = new WebSocket(HUB, { headers: { Authorization: `Bearer ${SECRET}` } });
  let ping;
  ws.addEventListener("open", () => {
    backoff = 1_000;
    console.log("connected", HUB);
    ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), PING_MS);
  });
  ws.addEventListener("message", async (ev) => {
    if (ev.data === "pong") return;
    let f;
    try {
      f = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (f?.t !== "req" || typeof f.id !== "string") return;
    try {
      const body = f.op === "summarize" ? await summarize(f.payload) : f.op === "ask" ? await ask(f.payload) : { error: "unknown_op" };
      ws.send(JSON.stringify({ t: "res", id: f.id, ok: true, body }));
    } catch (err) {
      ws.send(JSON.stringify({ t: "res", id: f.id, ok: false, body: { error: String(err?.message ?? err) } }));
    }
  });
  ws.addEventListener("close", () => {
    clearInterval(ping);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 60_000);
  });
  ws.addEventListener("error", () => ws.close());
}

connect();
