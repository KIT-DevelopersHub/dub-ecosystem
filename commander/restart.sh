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
    mkdir -p "$LOG_DIR"
    exec >>"$LOG_DIR/restart.log" 2>&1
    DEV_UP="$(find_dev_up "$DAEMON_PID")" || { log "dev-up.sh not found above daemon $DAEMON_PID - abort"; exit 1; }
    sleep 1 # let the daemon finish answering the button's request
    log "stopping stack (dev-up $DEV_UP)"
    kill -TERM "$DEV_UP" 2>/dev/null || true
    for _ in $(seq 1 30); do
      kill -0 "$DEV_UP" 2>/dev/null || break
      sleep 1
    done
    for port in "$DAEMON_PORT" "$SERVICE_PORT" "$WEB_PORT"; do
      for pid in $(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null); do
        log "kill leftover $pid on :$port"
        kill "$pid" 2>/dev/null || true
      done
    done
    sleep 2
    log "starting stack at $(git -C "$REPO_ROOT" rev-parse --short HEAD)"
    cd "$REPO_ROOT"
    nohup bash commander/dev-up.sh >>"$LOG_DIR/restart.log" 2>&1 &
    log "dev-up started (pid $!)"
    ;;

  *)
    die "usage: restart.sh update|relaunch <daemon-pid>"
    ;;
esac
