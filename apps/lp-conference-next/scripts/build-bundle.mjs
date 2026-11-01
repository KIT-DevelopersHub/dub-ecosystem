#!/usr/bin/env node
// Builds every LP version listed in versions.json into ONE assets directory
// (dist-bundle/) served by worker/index.ts:
//
//   dist-bundle/versions/<id>/...      HTML + public files of each version
//   dist-bundle/_v/<id>/_next/...      Next chunks (built with assetPrefix /_v/<id>),
//                                      served straight from assets (no Worker run)
//
// ref "HEAD" = the working tree. Any other ref is `git archive`d into a temp dir and
// built there; results are cached in .bundle-cache/<id>-<sha>/ so re-runs are fast.
// Builds run sequentially (low-power PC). Any failed build aborts the whole bundle.
//
// Usage: node scripts/build-bundle.mjs [--no-cache]
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const BUNDLE = join(APP, "dist-bundle");
const CACHE = join(APP, ".bundle-cache");
const APP_REL = "apps/lp-conference-next";
const noCache = process.argv.includes("--no-cache");

const manifest = JSON.parse(readFileSync(join(APP, "versions.json"), "utf8"));
// Copy fixes re-applied to every archived version (e.g. wording that must change on
// all versions at once). Part of the cache key so editing it forces a rebuild.
const fixesRaw = readFileSync(join(APP, "content-fixes.json"), "utf8");
const fixes = JSON.parse(fixesRaw).fixes;
const fixesHash = createHash("sha256").update(fixesRaw).digest("hex").slice(0, 8);

function applyFixes(src, id) {
  for (const f of fixes) {
    const p = join(src, f.file);
    const text = readFileSync(p, "utf8");
    if (!text.includes(f.from)) throw new Error(`${id}: content fix not applicable in ${f.file}: ${f.from}`);
    writeFileSync(p, text.split(f.from).join(f.to));
  }
}
const repo = run("git", ["rev-parse", "--show-toplevel"], { cwd: APP, capture: true }).trim();

function run(cmd, args, { cwd, env, capture } = {}) {
  return execFileSync(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
}

function nextBuild(dir, id, extraEnv = {}) {
  run(join(dir, "node_modules", ".bin", "next"), ["build"], {
    cwd: dir,
    env: { NEXT_TELEMETRY_DISABLED: "1", LP_ASSET_PREFIX: `/_v/${id}`, ...extraEnv },
  });
}

// Working tree build. A custom distDir makes `output: export` write there instead of
// ./out, so a normal `pnpm build` output is never clobbered.
function buildHead(id) {
  const outName = ".bundle-out";
  rmSync(join(APP, outName), { recursive: true, force: true });
  nextBuild(APP, id, { NEXT_DIST_DIR: outName });
  return join(APP, outName);
}

function depsAvailable(pkg) {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return Object.keys(deps).every((d) => existsSync(join(APP, "node_modules", d)));
}

function buildArchived(id, ref) {
  const sha = run("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: repo, capture: true }).trim();
  const cached = join(CACHE, `${id}-${sha}-${fixesHash}`);
  if (!noCache && existsSync(join(cached, ".complete"))) {
    console.log(`[bundle] ${id}: cache hit (${sha.slice(0, 12)})`);
    return cached;
  }
  const tmp = mkdtempSync(join(tmpdir(), `lp-bundle-${id}-`));
  try {
    const tar = execFileSync("git", ["archive", sha, APP_REL], { cwd: repo, maxBuffer: 1 << 30 });
    execFileSync("tar", ["-x", "-C", tmp], { input: tar });
    const src = join(tmp, APP_REL);
    applyFixes(src, id);
    const pkg = JSON.parse(readFileSync(join(src, "package.json"), "utf8"));
    if (depsAvailable(pkg)) {
      symlinkSync(join(APP, "node_modules"), join(src, "node_modules"), "dir");
    } else {
      // Older versions used deps the current app dropped (e.g. framer-motion in v2.x):
      // install that version's own deps in isolation (outside the workspace).
      console.log(`[bundle] ${id}: installing its own deps (differs from current app)`);
      rmSync(join(src, "pnpm-lock.yaml"), { force: true });
      run("pnpm", ["install", "--ignore-workspace", "--no-frozen-lockfile", "--reporter=append-only"], { cwd: src });
    }
    // Wrap the version's own next.config to add the asset prefix.
    renameSync(join(src, "next.config.mjs"), join(src, "next.config.orig.mjs"));
    writeFileSync(
      join(src, "next.config.mjs"),
      'import base from "./next.config.orig.mjs";\n' +
        "export default { ...base, assetPrefix: process.env.LP_ASSET_PREFIX };\n",
    );
    nextBuild(src, id);
    rmSync(cached, { recursive: true, force: true });
    mkdirSync(CACHE, { recursive: true });
    cpSync(join(src, "out"), cached, { recursive: true });
    writeFileSync(join(cached, ".complete"), `${ref} ${sha}\n`);
    return cached;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const ids = new Set();
rmSync(BUNDLE, { recursive: true, force: true });
mkdirSync(BUNDLE, { recursive: true });
for (const v of manifest.versions) {
  if (!/^v\d+\.\d+$/.test(v.id) || ids.has(v.id)) throw new Error(`bad/duplicate version id: ${v.id}`);
  ids.add(v.id);
  console.log(`\n[bundle] ===== ${v.id} (${v.ref}) =====`);
  const out = v.ref === "HEAD" ? buildHead(v.id) : buildArchived(v.id, v.ref);
  cpSync(join(out, "_next"), join(BUNDLE, "_v", v.id, "_next"), { recursive: true });
  cpSync(out, join(BUNDLE, "versions", v.id), {
    recursive: true,
    filter: (p) => p !== join(out, "_next") && !p.endsWith("/.complete"),
  });
}
if (!ids.has(manifest.default)) throw new Error(`default ${manifest.default} is not bundled`);
console.log(`\n[bundle] done -> ${BUNDLE} (${[...ids].join(", ")})`);
