#!/usr/bin/env bash
# Commander - "更新して再起動" helper, driven by the daemon's POST /admin/restart.
#
#   bash commander/restart.sh update   <daemon-pid>   # sync: pull latest origin/main into this worktree
#   bash commander/restart.sh relaunch <daemon-pid>   # detached: stop this dev-up stack, start it again
#
# `update` runs while the stack is still up, so any failure (dirty tree, diverged branch,
# not started by dev-up.sh) is reported back to the button and nothing is stopped.
# `relaunch` must run outside the daemon's process tree (the daemon spawns it detached),
# because stopping dev-up kills the daemon and every child it has.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$SCRIPT_DIR/.dev/logs"
MODE="${1:-}"
DAEMON_PID="${2:-}"

DAEMON_PORT="${COMMANDER_DAEMON_PORT:-4319}"
SERVICE_PORT="${COMMANDER_SERVICE_PORT:-8798}"
WEB_PORT="${COMMANDER_WEB_PORT:-5609}"

die() { echo "$*" >&2; exit 1; }
log() { echo "[$(date '+%F %T')] $*"; }

# Outermost dev-up.sh above the daemon. The daemon's direct parent is a `( ... )`
# subshell that also shows as dev-up.sh; only the top one owns the cleanup trap.
find_dev_up() {
  local pid="$1" cmd found=""
  while [[ -n "$pid" && "$pid" -gt 1 ]]; do
    cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    [[ "$cmd" == *"commander/dev-up.sh"* ]] && found="$pid"
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
  done
  [[ -n "$found" ]] && echo "$found"
}

[[ "$DAEMON_PID" =~ ^[0-9]+$ ]] || die "usage: restart.sh update|relaunch <daemon-pid>"

case "$MODE" in
  update)
    find_dev_up "$DAEMON_PID" >/dev/null || die "dev-up.sh から起動されていないため再起動できません"
    cd "$REPO_ROOT"
    [[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "作業ツリーに未コミットの変更があるため更新できません ($REPO_ROOT)"
    git fetch --quiet origin main || die "git fetch origin main に失敗しました"
    FROM="$(git rev-parse --short HEAD)"
    if git symbolic-ref -q HEAD >/dev/null; then
      git merge --quiet --ff-only origin/main >/dev/null 2>&1 \
        || die "ブランチ $(git branch --show-current) が origin/main から分岐しているため更新できません"
    else
      git checkout --quiet --detach origin/main
    fi
    TO="$(git rev-parse --short HEAD)"
    if [[ "$FROM" != "$TO" ]] && ! git diff --quiet "$FROM" "$TO" -- pnpm-lock.yaml; then
      pnpm install --frozen-lockfile >/dev/null 2>&1 || die "pnpm install に失敗しました"
    fi
    echo "$FROM $TO"
    ;;

  relaunch)
    # Re-exec once in a BRAND-NEW SESSION so this process is neither a child nor a
    # process-group member of the daemon. dev-up's cleanup kills the daemon's whole
    # child tree (kill_tree = a pgrep -P walk) and a plain `nohup ... &` relauncher
    # stayed close enough to that tree/group to be taken down with it mid-stop: the
    # stack stopped but never restarted (seen 3x). A new session detaches us from
    # the daemon's PPID chain, process group, and controlling terminal, so the stop
    # can never reach us before we start the stack again. macOS ships no setsid(1);
    # perl's POSIX::setsid() is always present at /usr/bin/perl. We detach FIRST,
    # then stop the old stack below, so "stop" is always followed by "start".
    if [[ -z "${COMMANDER_RESTART_DETACHED:-}" ]]; then
      COMMANDER_RESTART_DETACHED=1 /usr/bin/perl -MPOSIX -e '
        POSIX::setsid();
        open(STDIN,  "<", "/dev/null");
        open(STDOUT, ">", "/dev/null");
        open(STDERR, ">&", STDOUT);
        exec(@ARGV) or die "exec failed: $!";
      ' bash "$0" relaunch "$DAEMON_PID" &
      exit 0
    fi
    mkdir -p "$LOG_DIR"
    exec >>"$LOG_DIR/restart.log" 2>&1
    # setsid severs our SESSION, but kill_tree walks by PPID (`pgrep -P`), not session:
    # until our spawner (the detached outer shell) exits we are still a transient child
    # of the daemon, so dev-up's stop could reach us before our detach completed. That
    # race made the stop kill us between "stop" and "start" on ~every other restart.
    # Block until we are reparented to init (PPID==1): then no `pgrep -P` walk rooted at
    # the daemon can ever include us, so the stop below can never take us down.
    for _ in $(seq 1 100); do
      [[ "$(ps -o ppid= -p "$$" 2>/dev/null | tr -d ' ')" == "1" ]] && break
      sleep 0.1
    done
    DEV_UP="$(find_dev_up "$DAEMON_PID")" || { log "dev-up.sh not found above daemon $DAEMON_PID - abort"; exit 1; }
    STACK_PGID="$(ps -o pgid= -p "$DEV_UP" 2>/dev/null | tr -d ' ')"
    sleep 1 # let the daemon finish answering the button's request
    log "stopping stack (dev-up $DEV_UP, pgid ${STACK_PGID:-?})"
    # Deterministic teardown by PROCESS GROUP. The whole stack (dev-up -> subshells ->
    # wrangler -> workerd, pnpm -> vite, relay) shares dev-up's process group, so one
    # group signal reaps every grandchild at once. The old per-pid pgrep walk raced
    # wrangler's re-forking and left orphaned wrangler/workerd holding on. Our own group
    # differs (setsid), so a group signal to the stack can never hit us. Guarded against
    # the degenerate case where the pgid could not be read or equals ours.
    if [[ -n "$STACK_PGID" && "$STACK_PGID" =~ ^[0-9]+$ && "$STACK_PGID" != "$$" ]]; then
      kill -TERM "-$STACK_PGID" 2>/dev/null || true
    else
      kill -TERM "$DEV_UP" 2>/dev/null || true
    fi
    for _ in $(seq 1 30); do
      kill -0 "$DEV_UP" 2>/dev/null || break
      sleep 1
    done
    if [[ -n "$STACK_PGID" && "$STACK_PGID" =~ ^[0-9]+$ && "$STACK_PGID" != "$$" ]]; then
      kill -KILL "-$STACK_PGID" 2>/dev/null || true
    fi
    # Backstop: anything still listening on our ports (e.g. an escaped grandchild).
    for sig in TERM KILL; do
      for port in "$DAEMON_PORT" "$SERVICE_PORT" "$WEB_PORT"; do
        for pid in $(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null); do
          log "kill -$sig leftover $pid on :$port"
          kill "-$sig" "$pid" 2>/dev/null || true
        done
      done
      sleep 2
    done
    # Do not re-bind until every port is actually free, or dev-up's vite --strictPort /
    # wrangler would abort with EADDRINUSE and the restart would "stop but not start".
    for _ in $(seq 1 30); do
      busy=""
      for port in "$DAEMON_PORT" "$SERVICE_PORT" "$WEB_PORT"; do
        lsof -ti "tcp:$port" -sTCP:LISTEN >/dev/null 2>&1 && busy=1
      done
      [[ -z "$busy" ]] && break
      sleep 1
    done
    log "starting stack at $(git -C "$REPO_ROOT" rev-parse --short HEAD)"
    cd "$REPO_ROOT"
    nohup bash commander/dev-up.sh >>"$LOG_DIR/restart.log" 2>&1 &
    log "dev-up started (pid $!)"
    ;;

  *)
    die "usage: restart.sh update|relaunch <daemon-pid>"
    ;;
esac
