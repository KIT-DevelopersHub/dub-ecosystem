// LP のアクセス解析スクリプト（#904）。LP Worker が公開ページの </body> 直前に差し込む（全ての版・Worker が
// 描くチケット / 登壇者募集 / スポンサー募集ページに同じものが入る。版ごとのビルドに依存しない）。
//
// 来訪者の負担をかけない:
//  - 同意バナー・cookie・外部の計測サービスは使わない。送るのはページを離れる / 隠れる時の sendBeacon 1 回だけ。
//  - 訪問（セッション）はこのタブの sessionStorage だけで数える（30 分操作が無ければ次の訪問）。識別子は送らない。
//  - Do Not Track / Global Privacy Control が有効なら何もしない。
//  - 計測の失敗は表示に一切影響させない（全体を try で包む）。
// 送る内容の検証と丸めは api-gateway（@dub/types lpInsights.parseInsightBeacon）。
// No runtime imports: runs under workerd and `node --test` (strip-only TS).

export const DEFAULT_DUB_API_BASE = "https://dub-api-gateway.developershub-site.workers.dev";

const SCRIPT = `(function(){try{
var w=window,d=document,n=navigator;
if(n.doNotTrack==="1"||w.doNotTrack==="1"||n.globalPrivacyControl===true)return;
var API=__API__+"/api/v1/public/lp-events",KEY="dub_lp_s",TTL=1800000,now=Date.now(),SEC=/^[a-z][a-z0-9-]{0,31}$/;
var ss=null;try{ss=w.sessionStorage;ss.setItem("dub_lp_t","1");ss.removeItem("dub_lp_t")}catch(e){ss=null}
var st=null;try{st=ss?JSON.parse(ss.getItem(KEY)||"null"):null}catch(e){st=null}
var first=!st||typeof st.t!=="number"||now-st.t>TTL;
if(first){var q=new URLSearchParams(location.search);st={src:q.get("utm_source"),med:q.get("utm_medium"),cmp:q.get("utm_campaign"),steps:[]}}
if(!Array.isArray(st.steps))st.steps=[];
function save(){st.t=Date.now();try{if(ss)ss.setItem(KEY,JSON.stringify(st))}catch(e){}}
save();
var path=location.pathname,steps=[];
function step(s){if(st.steps.indexOf(s)<0){st.steps.push(s);steps.push(s);save()}}
if(/^\\/tickets\\/?$/.test(path))step("tickets");
if(d.querySelector("[data-lp-purchase]"))step("purchase");
d.addEventListener("submit",function(e){var f=e.target;if(f&&f.matches&&f.matches("form.buy"))step("checkout")},true);
var vis=0,since=d.visibilityState==="hidden"?0:now;
function tick(){if(since){vis+=Date.now()-since;since=0}}
var maxS=0;function sc(){var h=d.documentElement,s=((w.scrollY||0)+(w.innerHeight||0))/Math.max(1,h.scrollHeight||1)*100;if(s>maxS)maxS=Math.min(100,s)}
w.addEventListener("scroll",sc,{passive:true});sc();
var seen={},secs=[];
if("IntersectionObserver" in w){var io=new IntersectionObserver(function(es){es.forEach(function(e){var id=e.target.id;if(seen[id]||!e.isIntersecting)return;if(e.intersectionRatio>=0.5||e.intersectionRect.height>=w.innerHeight*0.5){seen[id]=1;secs.push(id);io.unobserve(e.target)}})},{threshold:[0,0.25,0.5,0.75,1]});
[].forEach.call(d.querySelectorAll("section[id]"),function(el){if(SEC.test(el.id))io.observe(el)})}
var ctas=[];
function secOf(el){if(el.id==="lp-tickets-cta")return "float";var s=el.closest("section[id]");if(s&&SEC.test(s.id))return s.id;return el.closest("header")?"header":el.closest("footer")?"footer":"page"}
d.addEventListener("click",function(e){var t=e.target;if(!t||!t.closest)return;var el=t.closest("a[href],[data-lp-tk]");if(!el)return;var k=null;
if(el.hasAttribute("data-lp-tk"))k="tickets";else{var u;try{u=new URL(el.getAttribute("href"),location.href)}catch(x){return}
if(u.protocol==="mailto:")k="contact";else if(u.origin===location.origin){var p=u.pathname;if(/^\\/tickets/.test(p))k="tickets";else if(/^\\/proposals/.test(p))k="proposal";else if(/^\\/sponsors/.test(p))k="sponsor";else if(u.hash&&p===location.pathname)k="nav"}
else if(u.protocol==="https:"||u.protocol==="http:")k="out:"+u.hostname.toLowerCase().replace(/^www\\./,"").replace(/[^a-z0-9.-]/g,"").slice(0,60)}
if(k&&ctas.length<12)ctas.push(k+"@"+secOf(el))},true);
var vit=null;
if(first&&w.PerformanceObserver){vit={};var ty=PerformanceObserver.supportedEntryTypes||[];
function po(type,cb,o){if(ty.indexOf(type)<0)return;try{var x={type:type,buffered:true};for(var k in o)x[k]=o[k];new PerformanceObserver(function(l){l.getEntries().forEach(cb)}).observe(x)}catch(e){}}
var cls=0,sv=0,sf=0,sl=0;if(ty.indexOf("layout-shift")>=0)vit.cls=0;
po("largest-contentful-paint",function(e){vit.lcp=Math.round(e.startTime)});
po("layout-shift",function(e){if(e.hadRecentInput)return;if(sv&&e.startTime-sl<1000&&e.startTime-sf<5000)sv+=e.value;else{sv=e.value;sf=e.startTime}sl=e.startTime;if(sv>cls)cls=sv;vit.cls=Math.round(cls*1000)/1000});
po("event",function(e){if(e.interactionId&&(vit.inp===undefined||e.duration>vit.inp))vit.inp=Math.round(e.duration)},{durationThreshold:40})}
var sent=false;
function send(){if(sent)return;sent=true;tick();sc();
var body=JSON.stringify({v:1,path:path,first:first,src:st.src||null,med:first?st.med||null:null,cmp:first?st.cmp||null:null,ref:first?(d.referrer||null):null,ms:vis,scroll:Math.round(maxS),sec:secs,cta:ctas,steps:steps,vit:vit});
try{if(!(n.sendBeacon&&n.sendBeacon(API,new Blob([body],{type:"text/plain"}))))fetch(API,{method:"POST",body:body,keepalive:true,mode:"no-cors"})}catch(e){}}
d.addEventListener("visibilitychange",function(){if(d.visibilityState==="hidden")send();else if(!sent)since=Date.now()});
w.addEventListener("pagehide",send);
}catch(e){}})();`;

/** The inline script (without the <script> tag). */
export function insightsScript(apiBase: string): string {
  return SCRIPT.replace("__API__", JSON.stringify(apiBase.replace(/\/+$/, "")));
}

/** `<script>` to append to <body>. */
export function insightsTag(apiBase: string): string {
  return `<script id="lp-insights">${insightsScript(apiBase)}</script>`;
}

/** 差し込むか。LP_INSIGHTS=off で止める。デモ（TICKETS_DEMO=1）は送り先を明示した時だけ。 */
export function insightsApiBase(env: { LP_INSIGHTS?: string; TICKETS_DEMO?: string; DUB_API_BASE?: string }): string | null {
  if (env.LP_INSIGHTS === "off") return null;
  if (env.DUB_API_BASE) return env.DUB_API_BASE;
  return env.TICKETS_DEMO === "1" ? null : DEFAULT_DUB_API_BASE;
}
