// /privacy（プライバシーポリシー）。本文は Dub の会計アプリで編集し、member-service の内部口
// （GET /members/internal/accounting/privacy-policy）から読む。未保存・読めない時は既定の文案を出す
// （読めない時は直前に読めた本文があればそれ）。本文は lp-markdown で描く（入力は全部エスケープ・決まったタグだけ）。
// No runtime imports outside the repo's pure TS: runs under workerd and `node --test` (strip-only TS).
import { renderLpMarkdown } from "../../../packages/types/src/lp-markdown.ts";
import { DEFAULT_PRIVACY_POLICY, PRIVACY_POLICY_MAX, formatPolicyDate } from "../../../packages/types/src/privacy-policy.ts";
import { escapeHtml } from "./html.ts";
import { hero, shell } from "./tickets.ts";

export const PRIVACY_PATH = "/privacy";
const CACHE_MS = 60_000;
const TIMEOUT_MS = 1_500;

export const isPrivacyPath = (pathname: string): boolean => pathname === PRIVACY_PATH || pathname === `${PRIVACY_PATH}/`;

export interface PublicPolicy {
  body: string;
  /** null = 既定の文案（まだ保存されていない）。 */
  updatedAt: string | null;
}

/** 内部口の応答を読む。形が違えば undefined（= 読めなかった扱い）。 */
export function parsePolicyResponse(raw: unknown): PublicPolicy | null | undefined {
  if (!raw || typeof raw !== "object" || !("policy" in raw)) return undefined;
  const p = (raw as { policy: unknown }).policy;
  if (p === null) return null;
  if (!p || typeof p !== "object") return undefined;
  const { body, updatedAt } = p as { body?: unknown; updatedAt?: unknown };
  if (typeof body !== "string" || !body.trim() || typeof updatedAt !== "string") return undefined;
  return { body, updatedAt };
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** isolate ごとの読み手（60 秒キャッシュ）。fetch が無い（demo など）なら常に既定の文案。 */
export function createPolicySource(fetcher: Fetch | null, now: () => number = Date.now): () => Promise<PublicPolicy> {
  let cache: { value: PublicPolicy; at: number } | null = null;
  let lastGood: PublicPolicy | null = null;
  const fallback: PublicPolicy = { body: DEFAULT_PRIVACY_POLICY, updatedAt: null };
  return async () => {
    const t = now();
    if (cache && t - cache.at < CACHE_MS) return cache.value;
    let value: PublicPolicy | null | undefined;
    try {
      if (fetcher) {
        const res = await fetcher("https://member-service/members/internal/accounting/privacy-policy", {
          headers: { "x-dub-internal": "1" },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.ok) value = parsePolicyResponse(await res.json());
      }
    } catch {
      // Never fail the page because of the policy source.
    }
    // null = 未保存（既定の文案）。undefined = 読めなかった → 直前に読めた本文。
    const resolved = value === undefined ? (lastGood ?? fallback) : (value ?? fallback);
    if (value !== undefined) lastGood = resolved;
    cache = { value: resolved, at: t };
    return resolved;
  };
}

const STYLE =
  "<style>" +
  ".policy h2{font-size:20px;margin:0 0 4px}" +
  ".policy .upd{margin:0 0 24px;color:var(--mute);font-size:14px}" +
  ".policy .md{font-size:15px;line-height:1.95;overflow-wrap:anywhere}" +
  ".policy .md h3{margin:2em 0 .6em;padding-bottom:.3em;border-bottom:2px solid var(--bd);font-size:18px;line-height:1.5}" +
  ".policy .md h4{margin:1.4em 0 .5em;font-size:16px}" +
  ".policy .md p{margin:0 0 1em}" +
  ".policy .md ul,.policy .md ol{margin:0 0 1em;padding-left:1.5em}" +
  ".policy .md li+li{margin-top:.3em}" +
  ".policy .md blockquote{margin:0 0 1em;padding:8px 14px;border-left:4px solid var(--blue);background:var(--alt);color:var(--soft)}" +
  ".policy .md hr{margin:1.6em 0;border:0;border-top:1px solid var(--bd)}" +
  ".policy .md code{padding:.1em .35em;border-radius:6px;background:var(--alt);font-size:.9em}" +
  ".policy .md img{max-width:100%;height:auto}" +
  "</style>";

export function renderPrivacyPage(policy: PublicPolicy, demo: boolean): string {
  const date = policy.updatedAt ? formatPolicyDate(policy.updatedAt) : null;
  const html = renderLpMarkdown(policy.body, { max: PRIVACY_POLICY_MAX });
  return shell(
    "プライバシーポリシー",
    STYLE +
      hero({ title: "プライバシーポリシー", ghost: "PRIVACY", eyebrow: "PRIVACY POLICY", small: true }) +
      '<div class="body"><div class="wrap"><section class="card policy" data-lp-privacy>' +
      (date ? `<p class="upd" data-lp-privacy-updated>最終更新日: ${escapeHtml(date)}</p>` : "") +
      `<div class="md">${html}</div>` +
      "</section></div></div>",
    demo,
  );
}

/** /privacy の応答。GET / HEAD だけ。 */
export async function handlePrivacy(req: Request, getPolicy: () => Promise<PublicPolicy>, demo: boolean): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const page = renderPrivacyPage(await getPolicy(), demo);
  return new Response(req.method === "HEAD" ? null : page, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" },
  });
}

/**
 * 全ての版の LP フッター（.footer-bottom-inner）に「プライバシーポリシー」のリンクを足すスクリプト。
 * HTML に直接差し込むと Next の hydration が食い違ってフッターごと描き直される（リンクも消える）ので、
 * 読み込みが終わってから足す（描き直されたら足し直す・10 秒で見張りをやめる）。版のビルドに依存しない。
 */
export const FOOTER_LINK_TAG =
  '<script id="lp-privacy-link">(function(){try{var d=document;' +
  'function a(){var f=d.querySelector(".footer-bottom-inner");if(!f||f.querySelector("[data-lp-privacy-link]"))return;' +
  'var l=d.createElement("a");l.href="' + PRIVACY_PATH + '";l.className="footer-copy";l.setAttribute("data-lp-privacy-link","");' +
  'l.style.cssText="margin-left:1.5rem;color:inherit;text-decoration:underline";l.textContent="プライバシーポリシー";f.appendChild(l)}' +
  'function go(){setTimeout(a,0);if(window.MutationObserver){var m=new MutationObserver(a);m.observe(d.body,{childList:true,subtree:true});setTimeout(function(){m.disconnect()},10000)}}' +
  'if(d.readyState==="complete")go();else addEventListener("load",go)}catch(e){}})();</script>';
