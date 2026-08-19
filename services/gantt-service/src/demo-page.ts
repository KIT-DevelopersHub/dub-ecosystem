// DEV-ONLY self-contained demo of the GanttRoom realtime layer (presence + live data
// sync) against the REAL Durable Object, driven by two browser tabs — NO auth/gateway/
// task stack required. Served by index.ts only when GANTT_RT_DEV_TICKET=1. This is the
// preview harness for the "two tabs see each other" acceptance check; the production UI
// integration lives in apps/fe4-task-gantt (this page mirrors its wire protocol + the
// presence colour/initial logic so the demo faithfully represents the shipped feature).
//
// The shared task list here is reconstructed PURELY from the realtime change stream
// (each frame carries taskId + kind + at), so both tabs converge with no payload and no
// reload — exactly the "server is truth, WS is the signal" model the app uses (there the
// authoritative values come from the REST API; here the deterministic transform stands in
// for that fetch so the demo needs no database).
export const DEMO_PAGE_HTML = String.raw`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Gantt Realtime デモ — プレゼンス & 同時編集</title>
<style>
  :root { --bg:#f8fafc; --panel:#fff; --line:#e5e7eb; --ink:#0f172a; --muted:#64748b; --brand:#1570ef; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, -apple-system, "Hiragino Kaku Gothic ProN", sans-serif; background:var(--bg); color:var(--ink); }
  header { display:flex; align-items:center; gap:16px; padding:12px 20px; background:var(--panel); border-bottom:1px solid var(--line); position:sticky; top:0; }
  h1 { font-size:15px; margin:0; font-weight:650; }
  .who { font-size:12px; color:var(--muted); }
  .spacer { flex:1; }
  /* presence bar */
  .presence { display:flex; align-items:center; }
  .avatars { display:flex; }
  .avatar { position:relative; width:34px; height:34px; border-radius:50%; display:flex; align-items:center; justify-content:center;
    color:#fff; font-size:13px; font-weight:650; margin-left:-8px; border:2px solid var(--panel); box-shadow:0 1px 2px rgba(0,0,0,.12); }
  .avatar:first-child { margin-left:0; }
  .avatar.editing { box-shadow:0 0 0 2px var(--panel), 0 0 0 4px #f79009; animation:pulse 1.6s ease-in-out infinite; }
  .avatar .badge { position:absolute; bottom:-3px; right:-3px; background:#f79009; color:#fff; font-size:8px; padding:1px 3px; border-radius:6px; line-height:1; }
  .avatar.me::after { content:"あなた"; position:absolute; top:-16px; left:50%; transform:translateX(-50%); font-size:9px; color:var(--muted); white-space:nowrap; }
  .overflow { width:34px; height:34px; border-radius:50%; background:#cbd5e1; color:#334155; font-size:12px; font-weight:650; display:flex; align-items:center; justify-content:center; margin-left:-8px; border:2px solid var(--panel); }
  @keyframes pulse { 0%,100%{ box-shadow:0 0 0 2px var(--panel), 0 0 0 4px #f79009; } 50%{ box-shadow:0 0 0 2px var(--panel), 0 0 0 7px rgba(247,144,9,.25); } }
  .status { font-size:11px; padding:3px 8px; border-radius:999px; background:#eef2ff; color:#3538cd; }
  .status.open { background:#ecfdf3; color:#067647; }
  .status.down { background:#fef3f2; color:#b42318; }
  main { max-width:860px; margin:22px auto; padding:0 20px; }
  .toolbar { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px; }
  button { font: inherit; font-size:13px; padding:7px 12px; border-radius:8px; border:1px solid var(--line); background:var(--panel); cursor:pointer; }
  button.primary { background:var(--brand); color:#fff; border-color:var(--brand); }
  button:disabled { opacity:.45; cursor:not-allowed; }
  .list { background:var(--panel); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  .row { display:flex; align-items:center; gap:12px; padding:11px 14px; border-bottom:1px solid var(--line); }
  .row:last-child { border-bottom:none; }
  .row.sel { background:#eff8ff; }
  .row .bar { height:10px; border-radius:5px; background:var(--brand); }
  .row .t { font-size:13px; font-weight:600; }
  .row .m { font-size:11px; color:var(--muted); }
  .row .flash { animation:flash 1s ease; }
  @keyframes flash { from { background:#fff7c2; } to { background:transparent; } }
  .empty { padding:24px; text-align:center; color:var(--muted); font-size:13px; }
  .log { margin-top:16px; font-size:11px; color:var(--muted); max-height:150px; overflow:auto; }
  .log div { padding:2px 0; border-bottom:1px dashed #eef2f6; }
</style>
</head>
<body>
<header>
  <h1>ガント リアルタイム</h1>
  <span class="who" id="who"></span>
  <span class="spacer"></span>
  <div class="presence"><div class="avatars" id="avatars"></div></div>
  <span class="status" id="status">接続中…</span>
</header>
<main>
  <div class="toolbar">
    <button class="primary" id="add">＋ タスクを追加</button>
    <button id="date" disabled>選択タスクの日付を変更</button>
    <button id="del" disabled>選択タスクを削除</button>
    <button id="edit" disabled>編集モード: OFF</button>
  </div>
  <div class="list" id="list"><div class="empty">タスクはまだありません。「＋ タスクを追加」を押してください。</div></div>
  <div class="log" id="log"></div>
</main>
<script>
(function () {
  var qs = new URLSearchParams(location.search);
  var userId = qs.get("user") || ("usr_" + Math.random().toString(36).slice(2, 7));
  var name = qs.get("name") || userId;
  var eventId = qs.get("eventId") || "evt_demo";
  document.getElementById("who").textContent = name + " として閲覧中";

  // deterministic colour from userId (mirrors fe4 presence-color.ts)
  function hueFor(id){ var h=0; for(var i=0;i<id.length;i++){ h=(h*31+id.charCodeAt(i))>>>0; } return h%360; }
  function colorFor(id){ return "hsl(" + hueFor(id) + " 62% 45%)"; }
  function initials(label){
    if(!label) return "?";
    var s=label.trim();
    if(/^[\x00-\x7F]+$/.test(s)){ var p=s.split(/\s+/); return (p.length>1?(p[0][0]+p[1][0]):s.slice(0,2)).toUpperCase(); }
    return Array.from(s)[0];
  }

  var self = { userId: userId, displayName: name };
  var tasks = [];              // shared model, reconstructed from the change stream
  var selected = null;
  var editing = false;
  var ws = null, hb = null;

  function log(msg){ var l=document.getElementById("log"); var d=document.createElement("div"); d.textContent="["+new Date().toLocaleTimeString()+"] "+msg; l.prepend(d); }

  function setStatus(s, cls){ var el=document.getElementById("status"); el.textContent=s; el.className="status "+(cls||""); }

  function renderPresence(users){
    var box=document.getElementById("avatars"); box.innerHTML="";
    var MAX=5; var shown=users.slice(0,MAX);
    shown.forEach(function(u){
      var a=document.createElement("div");
      a.className="avatar"+(u.editing?" editing":"")+(u.userId===self.userId?" me":"");
      a.style.background=colorFor(u.userId);
      a.title=(u.displayName||u.userId)+(u.editing?"（編集中）":"（閲覧中）");
      a.textContent=initials(u.displayName||u.userId);
      if(u.editing){ var b=document.createElement("span"); b.className="badge"; b.textContent="編集"; a.appendChild(b); }
      box.appendChild(a);
    });
    if(users.length>MAX){ var o=document.createElement("div"); o.className="overflow"; o.textContent="+"+(users.length-MAX); box.appendChild(o); }
  }

  function renderList(flashId){
    var el=document.getElementById("list");
    if(tasks.length===0){ el.innerHTML='<div class="empty">タスクはまだありません。</div>'; return; }
    el.innerHTML="";
    tasks.forEach(function(t){
      var row=document.createElement("div");
      row.className="row"+(t.id===selected?" sel":"")+(t.id===flashId?" flash":"");
      var w=40+(hueFor(t.id)%160);
      row.innerHTML='<div class="bar" style="width:'+w+'px"></div>'+
        '<div style="flex:1"><div class="t">'+t.title+'</div><div class="m">更新: '+new Date(t.at).toLocaleTimeString()+' · '+t.id+'</div></div>';
      row.onclick=function(){ selected=t.id; refreshButtons(); renderList(); };
      el.appendChild(row);
    });
  }

  function refreshButtons(){
    document.getElementById("del").disabled = !selected;
    document.getElementById("date").disabled = !selected;
    document.getElementById("edit").disabled = false;
  }

  // apply a change frame to the shared model (deterministic; no payload needed)
  function applyChange(change, taskId, at){
    if(change==="task.deleted"){ tasks=tasks.filter(function(t){return t.id!==taskId;}); if(selected===taskId) selected=null; }
    else { // upsert / schedule / any unknown kind -> ensure the row exists + bump its time
      var found=tasks.find(function(t){return t.id===taskId;});
      if(found){ found.at=at; }
      else { tasks.push({ id: taskId, title: "タスク " + taskId.replace("tsk_",""), at: at }); }
    }
    renderList(taskId); refreshButtons();
  }

  function send(obj){ if(ws && ws.readyState===1){ ws.send(JSON.stringify(obj)); } }

  // local op = optimistic apply + broadcast the signal (author excluded by the DO)
  function localChange(change, taskId){
    var at=new Date().toISOString();
    applyChange(change, taskId, at);
    send({ t:"change", change: change, taskId: taskId });
    log("送信: "+change+" ("+taskId+")");
  }

  document.getElementById("add").onclick=function(){ localChange("task.upserted", "tsk_"+Math.random().toString(36).slice(2,6)); };
  document.getElementById("date").onclick=function(){ if(selected) localChange("schedule", selected); };
  document.getElementById("del").onclick=function(){ if(selected) localChange("task.deleted", selected); };
  document.getElementById("edit").onclick=function(){
    editing=!editing;
    this.textContent="編集モード: "+(editing?"ON":"OFF");
    send({ t:"state", editing: editing, editingTaskId: selected });
  };

  function connect(){
    setStatus("接続中…","");
    fetch("/dev-ws-ticket?eventId="+encodeURIComponent(eventId)+"&userId="+encodeURIComponent(userId)+"&name="+encodeURIComponent(name))
      .then(function(r){ return r.json(); })
      .then(function(t){
        self=t.self;
        var url=t.doUrl + (t.doUrl.indexOf("?")>=0?"&":"?") + "ticket=" + encodeURIComponent(t.ticket);
        ws=new WebSocket(url);
        ws.onopen=function(){ setStatus("接続済み","open"); send({t:"hello"}); hb=setInterval(function(){ send({t:"ping"}); }, 15000); };
        ws.onmessage=function(ev){
          if(ev.data==="pong") return;
          var m; try{ m=JSON.parse(ev.data); }catch(e){ return; }
          if(m.kind==="presence"){ renderPresence(m.users); }
          else if(m.kind==="data.changed"){ applyChange(m.change, m.taskId, m.at); log("受信: "+m.change+" ("+m.taskId+") by "+m.actorId); }
        };
        ws.onclose=function(){ setStatus("切断 — 再接続します","down"); clearInterval(hb); setTimeout(connect, 1500); };
        ws.onerror=function(){ try{ ws.close(); }catch(e){} };
      })
      .catch(function(){ setStatus("チケット取得失敗","down"); setTimeout(connect, 2000); });
  }
  connect();
})();
</script>
</body>
</html>`;
