// Where the UI reaches the operator's Commander. Default is loopback (daemon :4319 /
// service :8798 on this machine). A remote connection points at the Cloudflare Tunnel
// hostnames that front the same local daemon/service (commander/tunnel-up.sh), so the
// Dub-hosted /commander page works from any device while the operator's PC is up.
// Stored per device in localStorage only — the token is never baked into a bundle.
import { HttpCommanderClient, type CommanderClient } from "./client.ts";
import { HttpCommanderApi, type CommanderApi } from "./commanderApi.ts";

export interface CommanderConnection {
  daemonUrl: string;
  apiUrl: string;
  token: string;
}

export const CONNECTION_KEY = "commander.connection.v1";

/** Trims and drops a trailing slash so `${base}/runs` never doubles it. */
export function normalizeUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/** Remote targets must be https: the token travels in every request. Loopback may be http. */
export function isAllowedUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(normalizeUrl(raw));
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
}

export function isValidConnection(c: CommanderConnection): boolean {
  return isAllowedUrl(c.daemonUrl) && isAllowedUrl(c.apiUrl) && c.token.trim() !== "";
}

export function loadConnection(storage: Storage = localStorage): CommanderConnection | null {
  try {
    const raw = storage.getItem(CONNECTION_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Partial<CommanderConnection>;
    if (typeof c.daemonUrl !== "string" || typeof c.apiUrl !== "string" || typeof c.token !== "string") {
      return null;
    }
    const conn = { daemonUrl: c.daemonUrl, apiUrl: c.apiUrl, token: c.token };
    return isValidConnection(conn) ? conn : null;
  } catch {
    return null;
  }
}

export function saveConnection(c: CommanderConnection | null, storage: Storage = localStorage): void {
  if (!c) {
    storage.removeItem(CONNECTION_KEY);
    return;
  }
  storage.setItem(
    CONNECTION_KEY,
    JSON.stringify({ daemonUrl: normalizeUrl(c.daemonUrl), apiUrl: normalizeUrl(c.apiUrl), token: c.token.trim() }),
  );
}

/** Clients for a saved connection; `null` keeps the build-time loopback defaults. */
export function clientsFor(c: CommanderConnection | null): { client?: CommanderClient; api?: CommanderApi } {
  if (!c) return {};
  return {
    client: new HttpCommanderClient(normalizeUrl(c.daemonUrl), c.token.trim()),
    api: new HttpCommanderApi(normalizeUrl(c.apiUrl), c.token.trim()),
  };
}
