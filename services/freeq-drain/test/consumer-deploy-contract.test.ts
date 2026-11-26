// #836 contract: every topic freeq-drain DELIVERS must reach a Worker that production actually
// deploys. evt.mail-automation was routed to SVC_MAIL_AUTOMATION -> "dub-mail-automation", but
// that Worker was never in infra/deploy/deploy-prod.sh, so prod kept an Aug-2026 build without
// /internal/events-async and 400'd every row for a month. Reads the real config files, so a
// new route whose consumer is not deployed fails here instead of silently in prod.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROUTES } from "../src/routing";

const ROOT = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** binding -> service name from freeq-drain's wrangler.toml [[services]] blocks. */
function drainBindings(): Map<string, string> {
  const out = new Map<string, string>();
  const re = /\[\[services\]\]\s*\nbinding\s*=\s*"([^"]+)"\s*\nservice\s*=\s*"([^"]+)"/g;
  for (const m of read("services/freeq-drain/wrangler.toml").matchAll(re)) out.set(m[1]!, m[2]!);
  return out;
}

/** Worker names deploy-prod.sh deploys (the `name` of each `deploy <x> <config>` config). */
function prodWorkerNames(): Set<string> {
  const names = new Set<string>();
  for (const m of read("infra/deploy/deploy-prod.sh").matchAll(/^deploy\s+\S+\s+([\w./-]+\.toml)\s*$/gm)) {
    const name = /^name\s*=\s*"([^"]+)"/m.exec(read(m[1]!))?.[1];
    if (name) names.add(name);
  }
  return names;
}

describe("freeq-drain deliver routes -> deployed consumers (#836)", () => {
  const bindings = drainBindings();
  const deployed = prodWorkerNames();
  const delivering = Object.entries(ROUTES).filter(([, r]) => r.kind === "deliver") as [string, { binding: string }][];

  it.each(delivering)("%s: its binding targets a Worker deploy-prod.sh deploys", (_topic, route) => {
    const service = bindings.get(route.binding);
    expect(service, `${route.binding} missing from freeq-drain/wrangler.toml`).toBeDefined();
    expect(deployed.has(service!), `${service} is not deployed by deploy-prod.sh`).toBe(true);
  });
});
