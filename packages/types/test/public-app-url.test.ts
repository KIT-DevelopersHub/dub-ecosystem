// CI invariant: common.PUBLIC_APP_BASE_URL is the one public app URL. The prod (free.toml)
// Worker configs must agree with it, so user-visible links never point at a dead host
// (app.developershub.jp has no DNS — account mails used to link there).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { common } from "../src/index";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const tomlVar = (file: string, key: string): string => {
  const m = readFileSync(repo(file), "utf8").match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"));
  if (!m) throw new Error(`${key} not found in ${file}`);
  return m[1] as string;
};

describe("PUBLIC_APP_BASE_URL — single source of the public app URL", () => {
  it("is a bare https origin and heads the allowed-origin list", () => {
    expect(new URL(common.PUBLIC_APP_BASE_URL).origin).toBe(common.PUBLIC_APP_BASE_URL);
    expect(common.PUBLIC_APP_BASE_URL.startsWith("https://")).toBe(true);
    expect(common.PUBLIC_APP_ORIGINS[0]).toBe(common.PUBLIC_APP_BASE_URL);
  });

  it("matches the prod gateway APP_BASE_URL (account-mail link) and deploy-state", () => {
    expect(tomlVar("services/api-gateway/wrangler.free.toml", "APP_BASE_URL")).toBe(common.PUBLIC_APP_BASE_URL);
    const prod = JSON.parse(readFileSync(repo("deploy-state/prod.json"), "utf8")) as { url: string };
    expect(prod.url).toBe(common.PUBLIC_APP_BASE_URL);
  });

  it("is allowed by every prod (free.toml) origin allow-list", () => {
    const lists: [string, string][] = [
      ["services/api-gateway/wrangler.free.toml", "ALLOWED_ORIGINS"],
      ["services/chat-service/wrangler.free.toml", "CHAT_RT_ALLOWED_ORIGINS"],
      ["services/gantt-service/wrangler.free.toml", "GANTT_RT_ALLOWED_ORIGINS"],
      ["services/notification/wrangler.free.toml", "NOTIF_RT_ALLOWED_ORIGINS"],
      ["services/commander-relay/wrangler.free.toml", "RELAY_ALLOWED_ORIGINS"],
    ];
    for (const [file, key] of lists) {
      expect(tomlVar(file, key).split(",").map((s) => s.trim()), `${file} ${key}`).toContain(common.PUBLIC_APP_BASE_URL);
    }
  });

  it("is the prod passkey RP (WebAuthn rpId must be the host users actually open)", () => {
    expect(tomlVar("services/auth-service/wrangler.free.toml", "WEBAUTHN_RP_ID")).toBe(new URL(common.PUBLIC_APP_BASE_URL).hostname);
    expect(tomlVar("services/auth-service/wrangler.free.toml", "WEBAUTHN_ORIGINS").split(",")).toContain(common.PUBLIC_APP_BASE_URL);
  });
});
