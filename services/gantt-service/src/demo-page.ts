// DEV/DEMO-ONLY self-contained demo of the GanttRoom presence layer against the REAL
// Durable Object, driven by two browser tabs — NO auth/gateway/task/DB stack required.
// Served by index.ts only when GANTT_RT_DEV_TICKET=1. This is the reviewable harness for
// the "two tabs see each other at the top" acceptance check; the production UI integration
// lives in apps/fe4-task-gantt (this page mirrors its wire protocol + the presence
// colour/initial logic so the demo faithfully represents the shipped feature).
//
// Each tab picks a random identity (id + display name), opens a WS to the shared demo room
// via an unauthenticated dev ws-ticket, and renders the live "who else is here" avatar row.
// Open a second tab → both rows gain the other person; close one → it disappears within a
// tick. The DB is never touched; the DO holds no rows; idle sockets hibernate → cost $0.
export const DEMO_PAGE_HTML = String.raw`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Gantt プレゼンス デモ — 今このガントを見ている人</title>
<style>
  :root { --bg:#f8fafc; --panel:#fff; --line:#e5e7eb; --ink:#0f172a; --muted:#64748b; --brand:#1570ef; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, -apple-system, "Hiragino Kaku Gothic ProN", sans-serif; background:var(--bg); color:var(--ink); }
  header { display:flex; align-items:center; gap:16px; padding:14px 22px; background:var(--panel); border-bottom:1px solid var(--line); position:sticky; top:0; }
  h1 { font-size:15px; margin:0; font-weight:650; }
  .sub { font-size:12px; color:var(--muted); margin-top:2px; }
  .spacer { flex:1; }
  .presence { display:flex; align-items:center; gap:12px; padding:6px 12px; border-radius:999px; background:rgba(15,23,42,.04); }
  .avatars { display:flex; }
  .avatar { position:relative; width:34px; height:34px; border-radius:50%; display:flex; align-items:center; justify-content:center;
    color:#fff; font-size:13px; font-weight:650; margin-left:-8px; border:2px solid var(--panel); box-shadow:0 1px 2px rgba(0,0,0,.12); }
  .avatar:first-child { margin-left:0; }
  .overflow { width:34px; height:34px; border-radius:50%; background:#cbd5e1; color:#334155; font-size:12px; font-weight:650;
    display:flex; align-items:center; justify-content:center; margin-left:-8px; border:2px solid var(--panel); }
  .count { font-size:12px; color:var(--muted); white-space:nowrap; }
  .dot { width:8px; height:8px; border-radius:50%; background:#94a3b8; }
  .dot.open { background:#16a34a; } .dot.connecting,.dot.reconnecting { background:#f59e0b; } .dot.closed { background:#94a3b8; }
  main { max-width:760px; margin:26px auto; padding:0 22px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:18px 20px; }
  .me { display:flex; align-items:center; gap:12px; }
  .me .who { font-size:14px; font-weight:600; }
  .me .id { font-size:11px; color:var(--muted); }
  .hint { margin-top:16px; font-size:13px; color:var(--muted); line-height:1.7; }
  .hint b { color:var(--ink); }
  .log { margin-top:18px; font-size:11px; color:var(--muted); max-height:180px; overflow:auto; border-top:1px dashed var(--line); padding-top:10px; }
  .log div { padding:2px 0; }
</style>
</head>
<body>
<header>
  <div>
    <h1>Gantt プレゼンス デモ</h1>
    <div class="sub">同じガント（イベント）を開いている人が上部にリアルタイム表示されます（自分以外）。</div>
  </div>
  <div class="spacer"></div>
  <div class="presence" data-testid="demo-presence-bar">
    <span class="dot connecting" id="dot"></span>
    <div class="avatars" id="avatars" role="list" aria-label="このガントを見ている他のメンバー"></div>
    <span class="count" id="count">接続中…</span>
  </div>
</header>
<main>
  <div class="card">
    <div class="me">
      <span class="avatar" id="me-avatar"></span>
      <div>
        <div class="who">あなた: <span id="me-name"></span></div>
        <div class="id" id="me-id"></div>
      </div>
    </div>
    <div class="hint">
      この画面を <b>もう1つのタブ / ウィンドウ</b> で開くと、上部のプレゼンスにお互いが現れます。<br />
      タブを閉じると、もう一方の上部からそのアバターが消えます。<br />
      （リアル backend の Durable Object + WebSocket に接続。DB は不使用・$0）
    </div>
    <div class="log" id="log" aria-label="イベントログ"></div>
  </div>
</main>
<script>
(function () {
  var EVENT_ID = "demo-event";
  var NAMES = ["田中 花子","佐藤 健","山田 太郎","Ada Lovelace","Grace Hopper","鈴木 一郎","Linus T.","高橋 美咲"];
  // Per-tab identity (sessionStorage keeps it across reloads; a new tab gets a fresh one).
  var id = sessionStorage.getItem("demo-user-id");
  var name = sessionStorage.getItem("demo-user-name");
  if (!id) {
    id = "demo_" + Math.random().toString(36).slice(2, 8);
    name = NAMES[Math.floor(Math.random() * NAMES.length)] + " (" + id.slice(-3) + ")";
    sessionStorage.setItem("demo-user-id", id);
    sessionStorage.setItem("demo-user-name", name);
  }

  function hashId(s){var h=2166136261;for(var i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}
  function color(uid){return "hsl(" + (hashId(uid)%360) + " 58% 42%)";}
  function initials(label){var s=(label||"").trim();if(!s)return "?";
    if(/^[\x00-\x7F]+$/.test(s)){var p=s.split(/\s+/).filter(Boolean);return p.length>1?(p[0][0]+p[1][0]).toUpperCase():s.slice(0,2).toUpperCase();}
    return Array.from(s)[0];}

  var elDot=document.getElementById("dot"), elAvatars=document.getElementById("avatars"),
      elCount=document.getElementById("count"), elLog=document.getElementById("log");
  document.getElementById("me-name").textContent=name;
  document.getElementById("me-id").textContent=id;
  var ma=document.getElementById("me-avatar"); ma.textContent=initials(name); ma.style.background=color(id);

  function log(msg){var d=document.createElement("div");d.textContent="["+new Date().toLocaleTimeString()+"] "+msg;elLog.prepend(d);}
  function setStatus(s,label){elDot.className="dot "+s;if(label)elCount.textContent=label;}

  function renderPresence(users){
    var others=users.filter(function(u){return u.userId!==id;});
    elAvatars.innerHTML="";
    var max=8, shown=others.slice(0,max);
    shown.forEach(function(u){
      var label=u.displayName||u.userId;
      var a=document.createElement("span");
      a.className="avatar"; a.style.background=color(u.userId); a.textContent=initials(label);
      a.title=label+" — 閲覧中"; a.setAttribute("role","listitem");
      a.setAttribute("data-testid","demo-presence-avatar-"+u.userId);
      elAvatars.appendChild(a);
    });
    if(others.length>max){var o=document.createElement("span");o.className="overflow";o.textContent="+"+(others.length-max);elAvatars.appendChild(o);}
    elCount.textContent = others.length>0 ? ("他 "+others.length+" 人が閲覧中") : "自分だけが閲覧中";
  }

  var ws=null, ping=null, backoff=1000;
  async function connect(){
    setStatus("connecting","接続中…");
    var ticket;
    try{
      var q="eventId="+encodeURIComponent(EVENT_ID)+"&userId="+encodeURIComponent(id)+"&displayName="+encodeURIComponent(name);
      var res=await fetch("/demo/ws-ticket?"+q);
      if(!res.ok) throw new Error("ticket "+res.status);
      ticket=await res.json();
    }catch(e){ log("ticket 取得失敗: "+e.message+" — 再試行"); return retry(); }
    var url=ticket.doUrl+(ticket.doUrl.indexOf("?")>=0?"&":"?")+"ticket="+encodeURIComponent(ticket.ticket);
    try{ ws=new WebSocket(url); }catch(e){ log("WS 生成失敗: "+e.message); return retry(); }
    ws.onopen=function(){ backoff=1000; setStatus("open"); log("接続しました"); try{ws.send("hello");}catch(e){}
      clearInterval(ping); ping=setInterval(function(){try{ws.send("ping");}catch(e){}},25000); };
    ws.onmessage=function(e){ if(typeof e.data!=="string"||e.data==="pong")return;
      var ev; try{ev=JSON.parse(e.data);}catch(_){return;} if(ev.eventId!==EVENT_ID)return;
      if(ev.kind==="presence"){ renderPresence(ev.users); log("プレゼンス更新: "+ev.users.length+" 人接続中"); } };
    ws.onclose=function(){ clearInterval(ping); setStatus("reconnecting","再接続中…"); log("切断 — 再接続します"); retry(); };
    ws.onerror=function(){ try{ws.close();}catch(e){} };
  }
  function retry(){ setStatus("reconnecting","再接続中…"); setTimeout(connect, backoff); backoff=Math.min(backoff*2,30000); }
  window.addEventListener("beforeunload", function(){ try{ if(ws) ws.close(); }catch(e){} });
  connect();
})();
</script>
</body>
</html>`;
