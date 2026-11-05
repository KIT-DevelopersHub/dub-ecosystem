// 完了画面の SNS 共有ダイアログ（/tickets/thanks・/proposals/thanks）。
// X は投稿画面を文面入りで開ける。Instagram は外部から文面を渡せないので、文面をコピーしてから
// スマホは共有シートで画像を渡し、PC は instagram.com を開く。
import { escapeHtml } from "./html.ts";

export const SHARE_HASHTAG = "#北陸ITカンファレンス";
const SHARE_IMAGE = "/og-default.png";

/** LP top carrying a 流入元 (utm_source), so shares show up in LP管理's ログ管理. */
export function shareUrl(origin: string, source: string): string {
  return `${origin}/?utm_source=${source}`;
}

export function shareText(message: string): string {
  return `${message}\n${SHARE_HASHTAG}`;
}

export function xShareHref(text: string, url: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
}

const STYLE =
  ".share{width:min(480px,calc(100vw - 32px));margin:auto;padding:32px;border:0;border-radius:24px;color:var(--ink);box-shadow:var(--sh-xl)}" +
  ".share::backdrop{background:rgba(7,18,53,.6)}" +
  ".share h2{margin:0 40px 8px 0;font-family:var(--disp);font-size:22px;font-weight:900;color:var(--h)}" +
  ".share p{margin:0 0 16px;font-size:14px;color:var(--mute)}" +
  ".share textarea{min-height:0;resize:none;font-size:14px;margin:0 0 16px;background:#f6f8fc}" +
  ".share-x{position:absolute;top:18px;right:18px;width:36px;height:36px;border:0;border-radius:50%;background:#eef0f4;color:var(--ink);font-size:20px;line-height:1;cursor:pointer}" +
  ".share-btns{display:grid;grid-template-columns:1fr 1fr;gap:10px}" +
  ".share-btn{display:flex;align-items:center;justify-content:center;gap:8px;min-height:48px;padding:0 14px;border:1.5px solid #d5dbe8;border-radius:12px;background:#fff;color:var(--ink);font:inherit;font-size:14px;font-weight:800;text-decoration:none;cursor:pointer}" +
  ".btn2[hidden],.share-btn[hidden]{display:none}" +
  ".share-btn svg{width:18px;height:18px;flex:none}" +
  ".share-btn--x{background:#000;border-color:#000;color:#fff}" +
  ".share-btn--ig{background:linear-gradient(45deg,#f09433,#dc2743 50%,#bc1888);border-color:transparent;color:#fff}" +
  ".share .share-status{min-height:20px;margin:12px 0 0;font-weight:700;color:var(--blue)}" +
  "@media (max-width:420px){.share{padding:24px}.share-btns{grid-template-columns:1fr}}";

const ICON_X =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.9 2H22l-7.3 8.3L23.3 22h-6.7l-5.3-6.9L5.2 22H2.1l7.8-8.9L1.7 2h6.9l4.8 6.3zm-1.2 18h1.9L7.4 3.9H5.4z"/></svg>';
const ICON_IG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg>';

const SCRIPT = `(function(){var d=document,D=d.querySelector("[data-lp-share]"),n=navigator;if(!D||!D.showModal)return;
var q=function(s){return D.querySelector(s)},O=d.querySelector("[data-share-open]"),S=q("[data-share-status]"),A=q("textarea").value,T=D.getAttribute("data-text"),U=D.getAttribute("data-native-url"),I=null,K="lp-share:"+D.getAttribute("data-key"),C=q("[data-share-native]");
function copy(t,m){var f=function(){S.textContent="コピーできませんでした。文章を選択してコピーしてください。"};try{n.clipboard.writeText(t).then(function(){S.textContent=m},f)}catch(e){f()}}
function open(){D.showModal()}
O.hidden=false;O.addEventListener("click",open);
q("[data-share-close]").addEventListener("click",function(){D.close()});
D.addEventListener("click",function(e){if(e.target===D)D.close()});
q("[data-share-copy]").addEventListener("click",function(){copy(A,"文章をコピーしました。")});
var M=matchMedia("(pointer:coarse)").matches&&n.canShare;
if(M)fetch(D.getAttribute("data-image")).then(function(r){return r.blob()}).then(function(b){var f=new File([b],"hokuriku-it-conference.png",{type:"image/png"});if(n.canShare({files:[f]}))I=f}).catch(function(){});
q("[data-share-ig]").addEventListener("click",function(e){copy(T,"投稿文をコピーしました。Instagram に貼り付けてください。");if(I){e.preventDefault();n.share({files:[I]}).catch(function(){})}});
if(n.share){C.hidden=false;C.addEventListener("click",function(){n.share({text:T,url:U}).catch(function(){})})}
try{if(sessionStorage.getItem(K))return;sessionStorage.setItem(K,"1")}catch(e){}
open()})();`;

export interface ShareOptions {
  /** Same-kind thanks pages open the dialog once per browser session. */
  key: "tickets" | "proposals";
  origin: string;
  heading: string;
  /** Post body without the hashtag. */
  message: string;
}

/** Button for the `.acts` row, shown by the script (the dialog needs JS). */
export const SHARE_OPEN_BUTTON = '<button type="button" class="btn2" data-share-open hidden>SNS でシェアする</button>';

export function renderShareDialog(o: ShareOptions): string {
  const text = shareText(o.message);
  const copied = `${text}\n${shareUrl(o.origin, "share-copy")}`;
  return (
    `<style>${STYLE}</style>` +
    `<dialog class="share" data-lp-share aria-labelledby="share-title" data-key="${o.key}" data-image="${SHARE_IMAGE}"` +
    ` data-text="${escapeHtml(text)}" data-native-url="${escapeHtml(shareUrl(o.origin, "share-native"))}">` +
    '<button type="button" class="share-x" data-share-close aria-label="閉じる">×</button>' +
    `<h2 id="share-title">${escapeHtml(o.heading)}</h2>` +
    `<p>${SHARE_HASHTAG} をつけて、カンファレンスを一緒に盛り上げてください。</p>` +
    `<textarea readonly rows="3" aria-label="投稿する文章">${escapeHtml(copied)}</textarea>` +
    '<div class="share-btns">' +
    `<a class="share-btn share-btn--x" target="_blank" rel="noopener noreferrer" href="${escapeHtml(xShareHref(text, shareUrl(o.origin, "share-x")))}">${ICON_X}X でポスト</a>` +
    `<a class="share-btn share-btn--ig" target="_blank" rel="noopener noreferrer" href="https://www.instagram.com/" data-share-ig>${ICON_IG}Instagram</a>` +
    '<button type="button" class="share-btn" data-share-copy>文章をコピー</button>' +
    '<button type="button" class="share-btn" data-share-native hidden>他のアプリで共有</button>' +
    "</div>" +
    '<p class="share-status" data-share-status role="status"></p>' +
    `</dialog><script>${SCRIPT}</script>`
  );
}
