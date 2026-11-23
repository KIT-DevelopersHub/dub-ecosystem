// 本番デプロイ（deploy.yml → infra/deploy/deploy-prod.sh）が、本番ドメインを持つ Worker を全部載せるか。
// WHY: 公開 LP (lp-conference-next) だけ手動デプロイのまま取り残され、#821 の新セクション（お知らせ等）が
// main マージ・本番デプロイ後も hokuriku-it-conf.com に出なかった。
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const script = read("infra/deploy/deploy-prod.sh");
const LP = "apps/lp-conference-next";

/** `deploy <name> <config>` の行（コメントを除く）→ 出てくる順の config パス。 */
function deployedConfigs(): string[] {
  return script
    .split("\n")
    .map((l) => l.replace(/#.*$/, "").trim())
    .map((l) => /^deploy\s+\S+\s+"?([^"\s]+)"?/.exec(l)?.[1])
    .filter((c): c is string => !!c)
    .map((c) => c.replace("${LP_APP}", LP));
}

/** apps/* と services/* の wrangler*.toml のうち、コメントでない custom_domain = true を持つもの。 */
function customDomainConfigs(): string[] {
  const out: string[] = [];
  for (const top of ["apps", "services"]) {
    for (const dir of readdirSync(join(ROOT, top))) {
      const abs = join(ROOT, top, dir);
      if (!existsSync(abs)) continue;
      let files: string[];
      try {
        files = readdirSync(abs).filter((f) => /^wrangler.*\.toml$/.test(f));
      } catch {
        continue;
      }
      for (const f of files) {
        const live = readFileSync(join(abs, f), "utf8")
          .split("\n")
          .some((l) => !l.trim().startsWith("#") && /custom_domain\s*=\s*true/.test(l));
        if (live) out.push(`${top}/${dir}/${f}`);
      }
    }
  }
  return out;
}

describe("production deploy coverage", () => {
  it("deploys every Worker that owns a production custom domain", () => {
    const deployed = deployedConfigs();
    const domains = customDomainConfigs();
    expect(domains).toContain(`${LP}/wrangler.toml`);
    for (const c of domains) expect(deployed, `${c} is never deployed by deploy-prod.sh`).toContain(c);
  });

  it("builds the LP bundle before deploying anything, and the LP after the Workers it binds", () => {
    const lines = script.split("\n").map((l) => l.replace(/#.*$/, "").trim());
    const build = lines.findIndex((l) => l.includes("@dub/lp-conference-next build:bundle"));
    const firstDeploy = lines.findIndex((l) => /^deploy\s/.test(l));
    expect(build).toBeGreaterThan(-1);
    expect(build).toBeLessThan(firstDeploy);

    const order = deployedConfigs();
    const lp = order.indexOf(`${LP}/wrangler.toml`);
    expect(lp).toBeGreaterThan(order.indexOf("services/lp-analytics/wrangler.free.toml")); // LP_FLAG
    expect(lp).toBeGreaterThan(order.indexOf("services/lp-tickets/wrangler.free.toml")); // LP_TICKETS
  });

  it("checks out full history so pinned LP versions can be git-archived", () => {
    const wf = read(".github/workflows/deploy.yml");
    expect(wf).toMatch(/uses: actions\/checkout@v\d+\s+with:[\s\S]*?fetch-depth:\s*0/);
  });

  it("ships the working tree as an LP version (ref HEAD), so merged LP changes reach production", () => {
    const manifest = JSON.parse(read(`${LP}/versions.json`)) as { versions: { id: string; ref: string }[] };
    expect(manifest.versions.some((v) => v.ref === "HEAD")).toBe(true);
  });
});
