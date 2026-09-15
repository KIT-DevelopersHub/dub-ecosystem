// Built-in zero-build test UI served at GET /. This is a smoke-test fallback so
// the exec bridge is usable with no frontend build at all. The real product UI
// lives in commander/web (Vite + React) and talks to the same endpoints.

export const INDEX_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Commander daemon</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 0; background: #0f1115; color: #e6e6e6; }
  header { padding: 12px 16px; border-bottom: 1px solid #2a2f3a; font-weight: 600; }
  main { padding: 16px; max-width: 900px; margin: 0 auto; }
  textarea { width: 100%; box-sizing: border-box; min-height: 72px; background: #1a1e27;
    color: #e6e6e6; border: 1px solid #2a2f3a; border-radius: 8px; padding: 10px; font: inherit; }
  button { margin-top: 8px; padding: 8px 16px; border: 0; border-radius: 8px;
    background: #3b82f6; color: #fff; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  pre { background: #12151c; border: 1px solid #2a2f3a; border-radius: 8px; padding: 12px;
    white-space: pre-wrap; word-break: break-word; max-height: 60vh; overflow: auto; }
  .status { margin: 8px 0; font-weight: 600; }
</style>
</head>
<body>
<header>Commander daemon — exec bridge (built-in test UI)</header>
<main>
  <textarea id="prompt" placeholder="claude -p に渡すプロンプト">Reply with the single word: PONG</textarea>
  <div><button id="run">Run</button></div>
  <div class="status" id="status"></div>
  <pre id="log"></pre>
</main>
<script>
const $ = (id) => document.getElementById(id);
$("run").addEventListener("click", async () => {
  $("run").disabled = true;
  $("log").textContent = "";
  $("status").textContent = "starting...";
  try {
    const r = await fetch("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: $("prompt").value }),
    });
    const { runId } = await r.json();
    const es = new EventSource("/runs/" + runId + "/events");
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data);
      if (ev.type === "status") $("status").textContent = "status: " + ev.status;
      $("log").textContent += m.data + "\\n";
      $("log").scrollTop = $("log").scrollHeight;
      if (ev.type === "status" && (ev.status === "succeeded" || ev.status === "failed")) {
        es.close();
        $("run").disabled = false;
      }
    };
    es.onerror = () => { es.close(); $("run").disabled = false; };
  } catch (e) {
    $("status").textContent = "error: " + e;
    $("run").disabled = false;
  }
});
</script>
</body>
</html>`;
