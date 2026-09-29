import { describe, it, expect } from "vitest";
import { buildSpawnEnv, resolveClaudeConfigDir } from "../src/env.ts";

// A parent env that mimics an operator whose shell exports personal secrets and a
// personal CLAUDE_CONFIG_DIR pointing at ~/.claude.
const PERSONAL_BASE: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/Users/operator",
  LANG: "en_US.UTF-8",
  PERSONAL_SECRET: "leak-me-not",
  AWS_SECRET_ACCESS_KEY: "nope",
  CLAUDE_CONFIG_DIR: "/Users/operator/.claude", // personal — must be overridden
  COMMANDER_PASSTHROUGH: "keep-me",
  ANTHROPIC_BASE_URL: "https://api.anthropic.com",
};

describe("buildSpawnEnv — isolation (default)", () => {
  const env = buildSpawnEnv(
    { isolateEnv: true, claudeConfigDir: "/repo/commander/.claude-home" },
    PERSONAL_BASE,
  );

  it("forces CLAUDE_CONFIG_DIR to Commander's config home (severs personal ~/.claude)", () => {
    expect(env.CLAUDE_CONFIG_DIR).toBe("/repo/commander/.claude-home");
  });

  it("strips arbitrary personal/secret vars", () => {
    expect(env.PERSONAL_SECRET).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it("keeps essential vars and preserved prefixes (PATH/HOME, COMMANDER_*, ANTHROPIC_*)", () => {
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/Users/operator");
    expect(env.COMMANDER_PASSTHROUGH).toBe("keep-me");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
  });

  it("never returns the same object as the parent env", () => {
    expect(env).not.toBe(PERSONAL_BASE);
  });
});

describe("buildSpawnEnv — Cloudflare credential passthrough (isolation)", () => {
  it("forwards CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID when present on the parent env", () => {
    const env = buildSpawnEnv(
      { isolateEnv: true, claudeConfigDir: "/repo/commander/.claude-home" },
      {
        ...PERSONAL_BASE,
        CLOUDFLARE_API_TOKEN: "TESTVALUE-token",
        CLOUDFLARE_ACCOUNT_ID: "TESTVALUE-account",
      },
    );
    expect(env.CLOUDFLARE_API_TOKEN).toBe("TESTVALUE-token");
    expect(env.CLOUDFLARE_ACCOUNT_ID).toBe("TESTVALUE-account");
  });

  it("does NOT add the Cloudflare vars when they are absent from the parent env", () => {
    const env = buildSpawnEnv(
      { isolateEnv: true, claudeConfigDir: "/repo/commander/.claude-home" },
      PERSONAL_BASE, // no CLOUDFLARE_* keys
    );
    expect(env.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(env.CLOUDFLARE_ACCOUNT_ID).toBeUndefined();
  });
});

describe("buildSpawnEnv — disabled", () => {
  it("inherits the full parent env but still redirects CLAUDE_CONFIG_DIR", () => {
    const env = buildSpawnEnv(
      { isolateEnv: false, claudeConfigDir: "/repo/commander/.claude-home" },
      PERSONAL_BASE,
    );
    expect(env.PERSONAL_SECRET).toBe("leak-me-not"); // full inherit
    expect(env.CLAUDE_CONFIG_DIR).toBe("/repo/commander/.claude-home"); // still redirected
  });

  it("drops an inherited personal CLAUDE_CONFIG_DIR when no config dir is given", () => {
    const env = buildSpawnEnv({ isolateEnv: true, claudeConfigDir: undefined }, PERSONAL_BASE);
    // Personal /Users/operator/.claude must NOT leak through the CLAUDE_* passthrough.
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });
});

describe("resolveClaudeConfigDir — fail-safe redirect (no personal ~/.claude fallback)", () => {
  const HOME = "/repo/commander/.claude-home";

  it("keeps an explicit non-empty override", () => {
    expect(resolveClaudeConfigDir("/some/other/home", HOME)).toBe("/some/other/home");
  });

  it("falls back to Commander's home when the override is undefined", () => {
    expect(resolveClaudeConfigDir(undefined, HOME)).toBe(HOME);
  });

  it("falls back to Commander's home when the override is empty or whitespace", () => {
    // The dangerous case: an explicit "" would otherwise leave CLAUDE_CONFIG_DIR unset,
    // re-attaching the operator's personal ~/.claude (judgment-queue hook + CLAUDE.md).
    expect(resolveClaudeConfigDir("", HOME)).toBe(HOME);
    expect(resolveClaudeConfigDir("   ", HOME)).toBe(HOME);
  });
});
