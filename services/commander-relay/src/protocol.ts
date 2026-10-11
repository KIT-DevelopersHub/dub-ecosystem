// Wire protocol between browser <-> CommanderRelay DO <-> local agent. Pure (no runtime
// bindings) so the routing rules are unit-testable without a Durable Object.
//
// The relay is an HTTP-over-WebSocket proxy with exactly two upstreams, both on the
// operator's loopback: the exec daemon and commander-service. The browser names an upstream
// and a path; the AGENT owns the base URLs and the operator token, so nothing the browser
// sends can point a request anywhere else or see the token.
//
//   browser -> DO   {t:"req",  id, target, method, path, body?}
//                   {t:"sub",  id, path}          SSE stream from the daemon
//                   {t:"unsub",id}
//   agent   -> DO   {t:"res",  id, status, body, more?}   (more=true: body continues)
//                   {t:"part", id, body, more?}
//                   {t:"ev",   id, data}  {t:"end", id}
//   DO -> browser   the agent frames with `id` unscoped, plus {t:"agent", online}
//   DO -> agent     browser frames with `id` scoped to the browser socket, plus {t:"gone", tag}

export type Target = "daemon" | "service";
export type Method = "GET" | "POST" | "PATCH" | "DELETE";

export type BrowserFrame =
  | { t: "req"; id: string; target: Target; method: Method; path: string; body?: string }
  | { t: "sub"; id: string; path: string }
  | { t: "unsub"; id: string };

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TARGETS = new Set<string>(["daemon", "service"]);
const METHODS = new Set<string>(["GET", "POST", "PATCH", "DELETE"]);
// Characters, not bytes: 256K chars of 3-byte UTF-8 still fits the 1 MiB WebSocket frame cap.
export const MAX_BODY_CHARS = 256 * 1024;
const MAX_PATH_CHARS = 2048;
/** Separator between a browser socket's tag and the browser's own request id. */
const SEP = "~";

/** A same-origin, single-line absolute path: "/x?y". Rejects "//host" and anything with a scheme. */
export function isSafePath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length <= MAX_PATH_CHARS &&
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !/[\s\\]/.test(path) &&
    !path.includes("://")
  );
}

/** Parse + validate one browser frame. null = drop it (and tell the browser). */
export function parseBrowserFrame(raw: string): BrowserFrame | null {
  let f: Record<string, unknown>;
  try {
    f = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!f || typeof f !== "object" || typeof f.id !== "string" || !ID_RE.test(f.id)) return null;
  switch (f.t) {
    case "req": {
      if (typeof f.target !== "string" || !TARGETS.has(f.target)) return null;
      if (typeof f.method !== "string" || !METHODS.has(f.method)) return null;
      if (!isSafePath(f.path)) return null;
      if (f.body !== undefined && (typeof f.body !== "string" || f.body.length > MAX_BODY_CHARS)) return null;
      const frame: BrowserFrame = { t: "req", id: f.id, target: f.target as Target, method: f.method as Method, path: f.path };
      if (typeof f.body === "string") frame.body = f.body;
      return frame;
    }
    case "sub":
      return isSafePath(f.path) ? { t: "sub", id: f.id, path: f.path } : null;
    case "unsub":
      return { t: "unsub", id: f.id };
    default:
      return null;
  }
}

export function scopeId(tag: string, id: string): string {
  return `${tag}${SEP}${id}`;
}

export function unscopeId(scoped: unknown): { tag: string; id: string } | null {
  if (typeof scoped !== "string") return null;
  const i = scoped.indexOf(SEP);
  if (i <= 0) return null;
  return { tag: scoped.slice(0, i), id: scoped.slice(i + 1) };
}

/** Agent frames the DO forwards to a browser. Anything else from the agent is dropped. */
const AGENT_TYPES = new Set(["res", "part", "ev", "end"]);

/**
 * Route one agent frame: which browser tag it belongs to and the frame to send it (id
 * unscoped). null = malformed or not addressed to a browser.
 */
export function routeAgentFrame(raw: string): { tag: string; out: string } | null {
  let f: Record<string, unknown>;
  try {
    f = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!f || typeof f !== "object" || typeof f.t !== "string" || !AGENT_TYPES.has(f.t)) return null;
  const scoped = unscopeId(f.id);
  if (!scoped) return null;
  return { tag: scoped.tag, out: JSON.stringify({ ...f, id: scoped.id }) };
}

/** Exact-match origin allow-list (comma-separated). */
export function originAllowed(origin: string | null, list: string | undefined): boolean {
  if (!origin) return false;
  return (list ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o !== "")
    .includes(origin);
}
