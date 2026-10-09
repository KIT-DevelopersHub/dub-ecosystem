// Artifact-URL extraction (P1-2). A commander run's output (the daemon's stream-json /
// stdout, mirrored here as run events) contains the URLs the operator needs to confirm
// the work: a demo/staging Cloudflare deploy (*.workers.dev / *.pages.dev) and the PR
// (github.com/.../pull/NN). These pure helpers scan that text and classify each URL so
// the board can surface a click-through link per task. Kept pure + separately tested so
// the parsing can't silently drift.

export interface ExtractedUrls {
  demoUrl?: string;
  stagingUrl?: string;
  prUrl?: string;
}

// A PR link: github.com/<owner>/<repo>/pull/<n>. Stop at whitespace or common wrappers.
const PR_RE = /https?:\/\/github\.com\/[^\s)"'<>\]]+\/pull\/\d+/gi;
// A Cloudflare deploy URL: any host ending in workers.dev or pages.dev, with optional path.
const DEPLOY_RE = /https?:\/\/[^\s)"'<>\]]*\.(?:workers|pages)\.dev(?:\/[^\s)"'<>\]]*)?/gi;

/** Trim trailing sentence punctuation a URL often gets glued to in prose/logs. */
function clean(url: string): string {
  return url.replace(/[.,;:!?)\]]+$/, "");
}

/** demo vs staging from the URL text: an explicit "staging"/"stg" marks staging;
 *  "demo" (or anything else) is treated as a demo artifact — demo is the first thing a
 *  commander-driven Dub task produces, so an unlabelled deploy defaults to demo. */
function classifyDeploy(url: string): "staging" | "demo" {
  return /stag(e|ing)|(^|[^a-z])stg([^a-z]|$)/i.test(url) ? "staging" : "demo";
}

/**
 * Extract artifact URLs from a chunk of run output. Latest-wins: when several deploy
 * URLs of the same kind appear (e.g. a re-deploy), the last one is returned, so the
 * task always points at the freshest artifact. Returns only the fields it found.
 */
export function extractArtifactUrls(text: string): ExtractedUrls {
  if (!text) return {};
  const out: ExtractedUrls = {};

  for (const m of text.matchAll(PR_RE)) out.prUrl = clean(m[0]);
  for (const m of text.matchAll(DEPLOY_RE)) {
    const url = clean(m[0]);
    if (classifyDeploy(url) === "staging") out.stagingUrl = url;
    else out.demoUrl = url;
  }
  return out;
}

/** Merge newly-found URLs over prior ones (latest non-empty wins; nothing is cleared). */
export function mergeUrls(prior: ExtractedUrls, next: ExtractedUrls): ExtractedUrls {
  return {
    demoUrl: next.demoUrl ?? prior.demoUrl,
    stagingUrl: next.stagingUrl ?? prior.stagingUrl,
    prUrl: next.prUrl ?? prior.prUrl,
  };
}

/** Every distinct PR URL in `text`, in first-seen order. */
export function extractPrUrls(text: string): string[] {
  if (!text) return [];
  return [...new Set(Array.from(text.matchAll(PR_RE), (m) => clean(m[0])))];
}

/** Append unseen PR URLs to a prior list (order kept, nothing dropped). */
export function mergePrUrls(prior: string[], next: string[]): string[] {
  return [...new Set([...prior, ...next])];
}

/** Parse the stored pr_urls JSON column; anything malformed reads as empty. */
export function parsePrUrls(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Only what the agent itself said: assistant text blocks + the final result. Tool output
 * (`gh pr list`, grep of test fixtures, ...) is excluded so unrelated PRs mentioned in
 * passing don't get attached to the task.
 */
export function authoredText(payload: unknown): string {
  if (payload == null || typeof payload !== "object") return "";
  const data = (payload as { data?: unknown }).data as
    | { type?: unknown; result?: unknown; message?: { content?: unknown } }
    | undefined;
  if (!data) return "";
  if (data.type === "result" && typeof data.result === "string") return data.result;
  if (data.type !== "assistant" || !Array.isArray(data.message?.content)) return "";
  return data.message.content
    .filter((b): b is { type: "text"; text: string } => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

/** Flatten a run event's payload to the text we scan for URLs (line/message/result/raw). */
export function eventText(payload: unknown): string {
  if (payload == null) return "";
  if (typeof payload === "string") return payload;
  const p = payload as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof p.line === "string") parts.push(p.line);
  if (typeof p.message === "string") parts.push(p.message);
  const data = p.data as { result?: unknown } | undefined;
  if (data && typeof data.result === "string") parts.push(data.result);
  // Fallback: stringify the whole payload so URLs nested anywhere are still caught.
  try {
    parts.push(JSON.stringify(payload));
  } catch {
    /* ignore non-serialisable payloads */
  }
  return parts.join("\n");
}
