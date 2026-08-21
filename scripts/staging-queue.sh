#!/usr/bin/env bash
#
# staging-queue — the ledger + gate for batching demo-approved features into ONE staging
# reflection, instead of racing the single shared `-staging` slot once per feature.
#
# FLOW (per ~/.claude/rules/dub-development-flow.md):
#   per-feature demo (deploy-demo-feature.sh) --OK--> `staging-queue add`  ... accumulate ...
#   when a FLUSH CONDITION trips --> `staging-queue flush` prints the integration plan:
#   merge each approved feature branch into the staging integration branch, deploy ONCE,
#   then verify-live. staging then equals "all demo-approved features" (demo=staging parity).
#
# FLUSH CONDITIONS (any one):
#   1. queue length >= flushThreshold           (default 5)
#   2. oldest approval age >= maxAgeHours        (default 24h)
#   3. manual flag set                           (`staging-queue set-manual-flush on`)
#
# Commands:
#   staging-queue.sh add <slug> --branch <b> --markers "<m1>[,..]" [--note <t>] [--demo-url <u>]
#   staging-queue.sh remove <slug>
#   staging-queue.sh status [--json]
#   staging-queue.sh flush [--dry-run] [--force]        # prints the merge/deploy plan
#   staging-queue.sh set-manual-flush <on|off>
#   staging-queue.sh --self-test                        # offline; uses a temp ledger
#
# Ledger: deploy-state/staging-queue.json (override with $STAGING_QUEUE_FILE for tests).
# flush does NOT run git/deploy itself (destructive on a shared repo) — it computes
# readiness, mutates the ledger (queue -> flushHistory), and prints the exact commands.
#
# Exit codes: 0 ok / flushed · 2 usage · 10 flush requested but NOT ready (without --force).
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LEDGER="${STAGING_QUEUE_FILE:-$ROOT/deploy-state/staging-queue.json}"

# Node does the JSON read-modify-write (node is a hard monorepo dependency; keeps the ledger
# valid instead of hand-rolling JSON in bash). op is argv[2], payload as JSON in argv[3].
node_op() {  # <op> <json-payload>
  LEDGER="$LEDGER" node -e '
    const fs = require("fs");
    const path = process.env.LEDGER;
    const op = process.argv[1];
    const arg = process.argv[2] ? JSON.parse(process.argv[2]) : {};
    const DEFAULTS = { schemaVersion: 1, flushThreshold: 5, maxAgeHours: 24,
      integrationBranch: "staging/demo-parity-integ", manualFlush: false,
      queue: [], lastFlushedAt: null, flushHistory: [] };
    let L;
    try { L = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path, "utf8")) }; }
    catch { L = { ...DEFAULTS }; }
    const now = new Date();
    const save = () => fs.writeFileSync(path, JSON.stringify(L, null, 2) + "\n");
    const ageH = (iso) => (now - new Date(iso)) / 3600000;
    const oldest = () => L.queue.length ? L.queue.reduce((a,b)=> new Date(a.approvedAt)<=new Date(b.approvedAt)?a:b) : null;
    function readiness() {
      const n = L.queue.length;
      const o = oldest();
      const oldestAge = o ? ageH(o.approvedAt) : 0;
      const reasons = [];
      if (n >= L.flushThreshold) reasons.push(`count ${n} >= threshold ${L.flushThreshold}`);
      if (o && oldestAge >= L.maxAgeHours) reasons.push(`oldest approval ${oldestAge.toFixed(1)}h >= maxAge ${L.maxAgeHours}h`);
      if (L.manualFlush) reasons.push("manual flag set");
      return { ready: reasons.length>0, reasons, n, oldestAge, oldestSlug: o?o.slug:null };
    }
    if (op === "add") {
      const e = { slug: arg.slug, branch: arg.branch, markers: arg.markers||[],
        note: arg.note||"", demoUrl: arg.demoUrl||"", actor: arg.actor||"", sha: arg.sha||"",
        approvedAt: now.toISOString() };
      const i = L.queue.findIndex(x=>x.slug===e.slug);
      if (i>=0) { L.queue[i] = { ...L.queue[i], ...e }; console.log(`updated queued feature: ${e.slug}`); }
      else { L.queue.push(e); console.log(`queued feature: ${e.slug} (branch ${e.branch})`); }
      save();
      const r = readiness();
      console.log(`queue now ${r.n} item(s). ${r.ready ? "FLUSH-READY: "+r.reasons.join("; ") : "not yet flush-ready."}`);
    } else if (op === "remove") {
      const before = L.queue.length;
      L.queue = L.queue.filter(x=>x.slug!==arg.slug);
      save();
      console.log(before===L.queue.length ? `no such queued slug: ${arg.slug}` : `removed queued feature: ${arg.slug}`);
    } else if (op === "manual") {
      L.manualFlush = !!arg.on; save();
      console.log(`manualFlush = ${L.manualFlush}`);
    } else if (op === "status" || op === "status-json") {
      const r = readiness();
      if (op === "status-json") {
        console.log(JSON.stringify({ ready:r.ready, reasons:r.reasons, count:r.n,
          oldestAgeHours:Number(r.oldestAge.toFixed(2)), threshold:L.flushThreshold,
          maxAgeHours:L.maxAgeHours, manualFlush:L.manualFlush,
          integrationBranch:L.integrationBranch, lastFlushedAt:L.lastFlushedAt,
          queue:L.queue }, null, 2));
      } else {
        console.log(`staging queue: ${r.n} feature(s)  [threshold ${L.flushThreshold}, maxAge ${L.maxAgeHours}h, integ ${L.integrationBranch}]`);
        for (const e of L.queue)
          console.log(`  - ${e.slug}  branch=${e.branch}  age=${ageH(e.approvedAt).toFixed(1)}h  markers=${(e.markers||[]).join("|")}`);
        console.log(r.ready ? `STATUS: FLUSH-READY — ${r.reasons.join("; ")}` : "STATUS: accumulating (no flush condition met).");
        if (L.lastFlushedAt) console.log(`last flushed: ${L.lastFlushedAt}`);
      }
    } else if (op === "flush" || op === "flush-dry" || op === "flush-force" || op === "flush-force-dry") {
      const force = op.includes("force");
      const dry = op.includes("dry");
      const r = readiness();
      if (!r.ready && !force) {
        console.error(`NOT READY to flush: no flush condition met (${r.n}/${L.flushThreshold} items, oldest ${r.oldestAge.toFixed(1)}h/${L.maxAgeHours}h, manual=${L.manualFlush}).`);
        console.error("Wait, add more approved features, or override with --force.");
        process.exit(10);
      }
      if (L.queue.length === 0) { console.error("queue is empty — nothing to flush."); process.exit(10); }
      const reason = r.ready ? r.reasons.join("; ") : "forced";
      console.log(`FLUSH ${dry?"(dry-run) ":""}— reason: ${reason}`);
      console.log(`\nIntegration plan → ${L.integrationBranch} (one deploy, one review):`);
      console.log(`  git fetch origin`);
      console.log(`  git switch -C ${L.integrationBranch} origin/main`);
      for (const e of L.queue) console.log(`  git merge --no-ff origin/${e.branch}   # ${e.slug}`);
      console.log(`  git push -u origin ${L.integrationBranch}`);
      console.log(`  # then reflect to staging (label gate) and verify-live once:`);
      const allMarkers = [...new Set(L.queue.flatMap(e=>e.markers||[]))];
      const q = String.fromCharCode(39);  // single quote, kept out of the bash-single-quoted source
      console.log(`  #   apply the \`stagingへ\` label to the integration PR (staging.yml deploys)`);
      console.log(`  bash scripts/verify-live.sh staging ${allMarkers.map(m=>q+m+q).join(" ")}`);
      console.log(`\nFeatures in this flush: ${L.queue.map(e=>e.slug).join(", ")}`);
      if (dry) { console.log("\n[dry-run] ledger unchanged."); process.exit(0); }
      L.flushHistory.push({ flushedAt: now.toISOString(), reason,
        integrationBranch: L.integrationBranch, slugs: L.queue.map(e=>e.slug),
        markers: allMarkers });
      L.lastFlushedAt = now.toISOString();
      L.queue = [];
      L.manualFlush = false;
      save();
      console.log("\nledger flushed: queue cleared, recorded in flushHistory. Commit deploy-state/staging-queue.json.");
    } else { console.error("unknown op "+op); process.exit(2); }
  ' "$@"
}

# ---- self-test (offline; temp ledger) ----------------------------------------------
if [ "${1:-}" = "--self-test" ]; then
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  export STAGING_QUEUE_FILE="$tmp/q.json"
  LEDGER="$STAGING_QUEUE_FILE"
  fail=0
  for i in 1 2 3 4; do node_op add "{\"slug\":\"f$i\",\"branch\":\"feat/f$i\",\"markers\":[\"m$i\"]}" >/dev/null; done
  # 4 items: not ready
  if node_op status-json '{}' | grep -q '"ready": false'; then echo "  ok  4 items not ready"; else echo "  FAIL should be not-ready at 4"; fail=1; fi
  # flush at 4 without force -> exit 10
  if node_op flush '{}' >/dev/null 2>&1; then echo "  FAIL flush should refuse at 4"; fail=1; else echo "  ok  flush refused (<threshold)"; fi
  node_op add '{"slug":"f5","branch":"feat/f5","markers":["m5"]}' >/dev/null
  # 5 items: ready by count
  if node_op status-json '{}' | grep -q '"ready": true'; then echo "  ok  5 items ready-by-count"; else echo "  FAIL should be ready at 5"; fail=1; fi
  # dry-run flush must NOT mutate (still 5 after)
  node_op flush-dry '{}' >/dev/null
  if [ "$(node_op status-json '{}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).count))')" = 5 ]; then echo "  ok  dry-run kept 5"; else echo "  FAIL dry-run mutated"; fail=1; fi
  # real flush clears queue
  node_op flush '{}' >/dev/null
  if node_op status-json '{}' | grep -q '"count": 0'; then echo "  ok  flush cleared queue"; else echo "  FAIL flush did not clear"; fail=1; fi
  # age-based readiness: inject an old approvedAt
  node_op add '{"slug":"old","branch":"feat/old","markers":["mo"]}' >/dev/null
  node -e 'const f=process.env.STAGING_QUEUE_FILE,L=JSON.parse(require("fs").readFileSync(f));L.queue[0].approvedAt=new Date(Date.now()-99*3600000).toISOString();require("fs").writeFileSync(f,JSON.stringify(L))'
  if node_op status-json '{}' | grep -q 'oldest approval'; then echo "  ok  age-based readiness"; else echo "  FAIL age readiness"; fail=1; fi
  # manual flag readiness
  node_op remove '{"slug":"old"}' >/dev/null
  node_op manual '{"on":true}' >/dev/null
  node_op add '{"slug":"one","branch":"feat/one","markers":["m"]}' >/dev/null
  if node_op status-json '{}' | grep -q 'manual flag set'; then echo "  ok  manual-flag readiness"; else echo "  FAIL manual readiness"; fail=1; fi
  if [ "$fail" = 0 ]; then echo "staging-queue self-test: PASS"; exit 0
  else echo "staging-queue self-test: FAIL"; exit 1; fi
fi

# ---- CLI ---------------------------------------------------------------------------
CMD="${1:-}"; shift || true
case "$CMD" in
  add)
    SLUG="${1:?slug required: staging-queue.sh add <slug> --branch <b> --markers <m>}"; shift
    BRANCH=""; MARKERS_CSV=""; NOTE=""; DEMO_URL=""
    while [ $# -gt 0 ]; do case "$1" in
      --branch)   BRANCH="${2:?}"; shift 2 ;;
      --markers)  MARKERS_CSV="${2:?}"; shift 2 ;;
      --note)     NOTE="${2:-}"; shift 2 ;;
      --demo-url) DEMO_URL="${2:-}"; shift 2 ;;
      *) echo "::error::unknown arg '$1'" >&2; exit 2 ;;
    esac; done
    [ -n "$BRANCH" ] || { echo "::error::--branch required (the clean feature branch to merge at flush)." >&2; exit 2; }
    [ -n "$MARKERS_CSV" ] || { echo "::error::--markers required (carried into the staging liveness check)." >&2; exit 2; }
    ACTOR="${GITHUB_ACTOR:-$(git -C "$ROOT" config user.name 2>/dev/null || echo "${USER:-unknown}")}"
    SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
    # markers CSV -> JSON array via node (safe quoting)
    PAYLOAD="$(SLUG="$SLUG" BRANCH="$BRANCH" MARKERS_CSV="$MARKERS_CSV" NOTE="$NOTE" DEMO_URL="$DEMO_URL" ACTOR="$ACTOR" SHA="$SHA" node -e '
      const m = (process.env.MARKERS_CSV||"").split(",").map(s=>s.trim()).filter(Boolean);
      process.stdout.write(JSON.stringify({slug:process.env.SLUG,branch:process.env.BRANCH,
        markers:m,note:process.env.NOTE,demoUrl:process.env.DEMO_URL,actor:process.env.ACTOR,sha:process.env.SHA}));')"
    node_op add "$PAYLOAD"
    ;;
  remove)
    SLUG="${1:?slug required: staging-queue.sh remove <slug>}"
    node_op remove "$(SLUG="$SLUG" node -e 'process.stdout.write(JSON.stringify({slug:process.env.SLUG}))')"
    ;;
  status)
    if [ "${1:-}" = "--json" ]; then node_op status-json '{}'; else node_op status '{}'; fi
    ;;
  flush)
    DRY=0; FORCE=0
    while [ $# -gt 0 ]; do case "$1" in
      --dry-run) DRY=1; shift ;;
      --force)   FORCE=1; shift ;;
      *) echo "::error::unknown arg '$1'" >&2; exit 2 ;;
    esac; done
    op="flush"
    if   [ "$FORCE" = 1 ] && [ "$DRY" = 1 ]; then op="flush-force-dry"
    elif [ "$FORCE" = 1 ];                   then op="flush-force"
    elif [ "$DRY" = 1 ];                      then op="flush-dry"
    fi
    node_op "$op" '{}'
    ;;
  set-manual-flush)
    case "${1:-}" in
      on)  node_op manual '{"on":true}' ;;
      off) node_op manual '{"on":false}' ;;
      *) echo "::error::usage: staging-queue.sh set-manual-flush <on|off>" >&2; exit 2 ;;
    esac
    ;;
  -h|--help|"")
    sed -n '2,40p' "${BASH_SOURCE[0]}"; ;;
  *) echo "::error::unknown command '$CMD' (add|remove|status|flush|set-manual-flush)" >&2; exit 2 ;;
esac
