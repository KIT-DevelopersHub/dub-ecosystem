// dev.mjs — start ONE local Worker with `wrangler dev`, wired for local development:
// a shared miniflare persist dir (so every service reads the same seeded local D1/KV),
// a fixed port, and the per-service local var overrides. One process per terminal —
// start only the services the feature you are working on needs (weak-PC friendly).
//
//   node scripts/local/dev.mjs <service>   (exposed as pnpm dev:<service>)
//   node scripts/local/dev.mjs --list
//
// Services and the feature sets they belong to are documented in LOCAL_DEV.md.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const PERSIST_DIR = join(REPO_ROOT, ".wrangler-local");
const WRANGLER = join(REPO_ROOT, "node_modules", ".bin", "wrangler");

// binding topology is in each service's wrangler.toml; here we only add the local-run
// overrides. `--local` uses miniflare (no network / no Cloudflare account needed).
const SERVICES = {
  identity: { dir: "services/identity-roster", port: 8790, vars: {} },
  // ENVIRONMENT=local turns off the production guard so test-login is enabled.
  // COOKIE_DOMAIN="" forces a host-only session cookie: the toml default
  // (.developershub.jp) is rejected by the browser on localhost, so the SPA could never
  // hold a session. Empty => no Domain attribute => cookie sticks to localhost.
  auth: { dir: "services/auth-service", port: 8788, vars: { ENVIRONMENT: "local", DUB_TEST_LOGIN: "1", COOKIE_DOMAIN: "" } },
  // mock provider = in-memory send (NO real email leaves the machine).
  mail: { dir: "services/mail-gateway", port: 8791, vars: { MAIL_OUTBOUND_PROVIDER: "mock" } },
  // the single external entrypoint the SPA (fe2) talks to.
  gateway: { dir: "services/api-gateway", port: 8787, vars: {} },
};

// Named feature sets (documentation only — printed by `--list`).
const SETS = {
  core: ["identity", "auth", "gateway", "mail"],
};

function usage() {
  console.log("Usage: node scripts/local/dev.mjs <service>");
  console.log("");
  console.log("Services (one `wrangler dev` per terminal, shared local D1/KV):");
  for (const [name, s] of Object.entries(SERVICES)) {
    const vars = Object.keys(s.vars).length ? `  [${Object.entries(s.vars).map(([k, v]) => `${k}=${v}`).join(", ")}]` : "";
    console.log(`  ${name.padEnd(9)} -> ${s.dir}  :${s.port}${vars}`);
  }
  console.log("");
  console.log("Feature sets (start these services, each in its own terminal):");
  for (const [name, list] of Object.entries(SETS)) console.log(`  ${name.padEnd(9)} -> ${list.join(" + ")}`);
  console.log("");
  console.log("Seed the local DB first:  pnpm dev:seed");
  console.log("Point the SPA at the gateway:  copy apps/fe2-app-shell/.env.local.example -> .env.local, then pnpm dev:fe2");
}

const arg = process.argv[2];
if (!arg || arg === "--list" || arg === "-h" || arg === "--help" || arg === "core") {
  usage();
  process.exit(0);
}

const svc = SERVICES[arg];
if (!svc) {
  console.error(`Unknown service "${arg}".`);
  usage();
  process.exit(1);
}

const args = ["dev", "--local", `--persist-to=${PERSIST_DIR}`, "--ip=127.0.0.1", `--port=${svc.port}`];
for (const [k, v] of Object.entries(svc.vars)) args.push("--var", `${k}:${v}`);

console.log(`[dev:${arg}] wrangler ${args.join(" ")}  (cwd: ${svc.dir})`);
const child = spawn(WRANGLER, args, { cwd: join(REPO_ROOT, svc.dir), stdio: "inherit", env: process.env });
child.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
