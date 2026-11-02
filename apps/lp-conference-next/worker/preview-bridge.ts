// LP管理（fe2）のミニプレビューとスクロールを連動させる postMessage の橋渡し（worker/index.ts から使う）。
// プレビュー表示（?version= / ?config=draft / ?tickets= / ?proposals=）のときだけ、インラインの小さな
// script を <body> に足す。通常の公開表示には絶対に足さない。
//  LP → 親: {type:"lp:sections", sections:[{id, top}]}（読み込み時・hello への返事）
//           {type:"lp:scroll", activeSection}（閲覧者が LP をスクロールして一番上のセクションが変わったときだけ）
//           {type:"lp:select", section}（選択モードでセクションをクリックしたとき）
//  親 → LP: {type:"lp:hello", select?}（再送の依頼。select:true で選択モード） / {type:"lp:scrollTo", section}
// 選択モード（LP管理の編集画面のプレビューだけが頼む）: セクションにホバーで枠、クリックはリンクや
// ボタンとして動かさず lp:select を送る。選んだセクション（クリック / scrollTo）には枠を残す。
// 全画面のプレビュー（LpViewer）は select を頼まないので、今までどおり普通に操作できる。
// 宛先と送信元は許可リストのオリジンだけ（"*" は使わない）。
// No runtime-only imports so it runs under both workerd and `node --test` (strip-only TS).

/** LP管理（fe2）のオリジン: 本番・workers.dev・staging 2 枠・demo。ローカルは下の正規表現。 */
export const BRIDGE_ORIGINS: readonly string[] = [
  "https://app.developershub.jp",
  "https://dub-fe2-app-shell.developershub-site.workers.dev",
  "https://dub-fe2-app-shell-staging.developershub-site.workers.dev",
  "https://dub-fe2-app-shell-staging2.developershub-site.workers.dev",
  "https://fe2-demo.developershub-site.workers.dev",
];

/** ローカル開発（vite dev / preview の任意のポート）。 */
export const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

/** env.PREVIEW_PARENT_ORIGINS（カンマ区切り）で足すオリジン。https の正しいオリジンだけ受け付ける。 */
export function parseExtraOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => {
      try {
        return /^https:\/\//.test(s) && new URL(s).origin === s;
      } catch {
        return false;
      }
    });
}

export function bridgeOriginAllowed(origin: string, extra: readonly string[] = []): boolean {
  return BRIDGE_ORIGINS.includes(origin) || extra.includes(origin) || LOCAL_ORIGIN.test(origin);
}

/** 足すのはプレビュー表示の HTML ページで、公開設定（data-lp-slot）を持つ版だけ。 */
export function shouldInjectBridge(p: { page: boolean; siteConfig: boolean; previewing: boolean }): boolean {
  return p.page && p.siteConfig && p.previewing;
}

/**
 * 注入する script（<script> タグ込み）。スロットは display:contents なので、位置は中の最初の要素で測る。
 * 親のオリジンは ancestorOrigins / referrer から取り、許可リストに無ければ何も送らない。
 * 親から許可オリジンのメッセージが来たら、そのオリジンを宛先にする（referrer が落ちる環境向け）。
 */
export function bridgeScript(extra: readonly string[] = []): string {
  const list = JSON.stringify([...BRIDGE_ORIGINS, ...extra]).replace(/</g, "\\u003c");
  const js = `(function(){
if(window.parent===window)return;
var L=${list},R=${LOCAL_ORIGIN.toString()};
function ok(o){return typeof o==="string"&&(L.indexOf(o)>=0||R.test(o))}
var T=null;
try{var ao=location.ancestorOrigins;if(ao&&ao.length&&ok(ao[0]))T=ao[0]}catch(e){}
if(!T&&document.referrer){try{var ro=new URL(document.referrer).origin;if(ok(ro))T=ro}catch(e){}}
function post(m){if(T)window.parent.postMessage(m,T)}
function topOf(el){var r=el.getBoundingClientRect();if(r.height>0)return r.top;var c=el.querySelectorAll("*");for(var i=0;i<c.length;i++){var q=c[i].getBoundingClientRect();if(q.height>0)return q.top}return null}
function list(){var out=[],s=document.querySelectorAll("[data-lp-slot]");for(var i=0;i<s.length;i++){var t=topOf(s[i]);if(t!==null)out.push({id:s[i].getAttribute("data-lp-slot"),top:Math.round(t+window.scrollY)})}return out}
function active(){var s=list(),a=null,y=window.scrollY+window.innerHeight*0.25;for(var i=0;i<s.length;i++){if(s[i].top<=y)a=s[i].id}return a||(s[0]?s[0].id:null)}
var last=null,quiet=0,raf=0;
function report(){var a=active();if(!a||a===last)return;last=a;if(Date.now()>=quiet)post({type:"lp:scroll",activeSection:a})}
function hello(){post({type:"lp:sections",sections:list()});last=active()}
window.addEventListener("scroll",function(){if(!raf)raf=requestAnimationFrame(function(){raf=0;report()})},{passive:true});
window.addEventListener("message",function(e){
if(e.source!==window.parent||!ok(e.origin))return;
var d=e.data;if(!d||typeof d!=="object")return;
T=e.origin;
if(d.type==="lp:hello"){if(d.select===true)selectMode();hello();return}
if(d.type==="lp:scrollTo"&&typeof d.section==="string"){var s=list();for(var i=0;i<s.length;i++){if(s[i].id===d.section){quiet=Date.now()+800;last=d.section;mark(d.section);window.scrollTo({top:Math.max(0,s[i].top-8),behavior:"smooth"});return}}}
});
var SEL=false;
function mark(id){if(!SEL)return;var o=document.querySelectorAll(".lp-edit-sel");for(var i=0;i<o.length;i++)o[i].classList.remove("lp-edit-sel");var s=document.querySelectorAll("[data-lp-slot]");for(var j=0;j<s.length;j++){if(s[j].getAttribute("data-lp-slot")!==id)continue;var c=s[j].querySelectorAll("[data-lp-variant]>*");for(var k=0;k<c.length;k++)c[k].classList.add("lp-edit-sel")}}
function selectMode(){if(SEL)return;SEL=true;document.documentElement.classList.add("lp-edit");var st=document.createElement("style");st.textContent="html.lp-edit [data-lp-variant]>*{cursor:pointer}html.lp-edit [data-lp-variant]>*:hover{outline:3px dashed rgba(37,99,235,.55);outline-offset:-3px}html.lp-edit .lp-edit-sel{outline:3px solid rgba(37,99,235,.9)!important;outline-offset:-3px}";document.head.appendChild(st);
document.addEventListener("click",function(e){var t=e.target,el=t&&t.closest?t.closest("[data-lp-slot]"):null;if(!el)return;e.preventDefault();e.stopPropagation();var id=el.getAttribute("data-lp-slot");mark(id);last=id;post({type:"lp:select",section:id})},true)}
if(document.readyState==="complete")hello();else window.addEventListener("load",hello);
})();`;
  return `<script id="lp-preview-bridge">${js}</script>`;
}
