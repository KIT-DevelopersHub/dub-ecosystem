import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The Commander agent's PreToolUse guard (commander/.claude-home/hooks/prod-gate-guard.mjs).
// exit 2 = blocked before the command runs. `gh` is faked on PATH so no network is used.
const HOOK = join(import.meta.dirname, "..", "..", ".claude-home", "hooks", "prod-gate-guard.mjs");

// Fake gh: `pr view <n>` answers from a fixed table; `api .../pulls/<n>/files` lists files.
const FAKE_GH = `#!/usr/bin/env bash
case "$*" in
  "pr view 1 "*) echo '{"number":1,"baseRefName":"main","labels":[]}' ;;
  "pr view 2 "*) echo '{"number":2,"baseRefName":"main","labels":[{"name":"確認した"}]}' ;;
  "pr view 3 "*) echo '{"number":3,"baseRefName":"staging/integ","labels":[]}' ;;
  "pr view 4 "*) echo '{"number":4,"baseRefName":"main","labels":[]}' ;;
  "pr view 5 "*) echo '{"number":5,"baseRefName":"main","labels":[]}' ;;
  "api --paginate repos/"*"/pulls/1/files"*) echo services/chat-service/src/app.ts ;;
  "api --paginate repos/"*"/pulls/4/files"*) printf 'commander/web/src/Board.tsx\\nservices/commander-service/src/app.ts\\n' ;;
  "api --paginate repos/"*"/pulls/5/files"*) printf 'commander/web/src/Board.tsx\\ncommander/.claude-home/settings.json\\n' ;;
  *) exit 1 ;;
esac
`;

let pathEnv = "";
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
  writeFileSync(join(dir, "gh"), FAKE_GH);
  chmodSync(join(dir, "gh"), 0o755);
  pathEnv = `${dir}:${process.env.PATH}`;
});

function run(command: string): number {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    env: { ...process.env, PATH: pathEnv },
    encoding: "utf8",
  });
  return r.status ?? -1;
}

describe("prod-gate-guard — blocks", () => {
  it.each([
    'gh pr edit 1 --add-label "確認した"',
    "cd /x && gh pr edit 1 --add-label 確認した",
    'bash -c "gh pr edit 1 --add-label 確認した"',
    'gh api repos/o/r/issues/1/labels -f "labels[]=確認した"',
    "gh label edit 確認した --name ok",
    "gh api graphql -f query='mutation{addLabelsToLabelable(input:{}){clientMutationId}}'",
    "gh pr merge 1 --merge", // no label, not commander-only
    "gh pr merge 2 --admin --merge",
    "gh pr merge 5 --merge", // touches .claude-home: not exempt
    "gh pr merge 9 --merge", // unknown PR: fail-close
    "git push origin main",
    "git push origin HEAD:main",
    "gh workflow run deploy.yml",
    "npx wrangler deploy",
    "pnpm deploy",
    "bash scripts/deploy-prod.sh",
  ])("%s", (cmd) => {
    expect(run(cmd)).toBe(2);
  });
});

describe("prod-gate-guard — allows", () => {
  it.each([
    'gh pr edit 1 --add-label "stagingへ"',
    'gh pr view 1 --json labels --jq "[.labels[].name] | index(\\"確認した\\")"',
    "gh pr merge 2 --merge", // owner applied 確認した
    "gh pr merge 3 --merge", // into an integration branch
    "gh pr merge 4 --merge", // Commander-only
    "git push -u origin fix/main-menu",
    'pnpm deploy:demo --markers "x"',
    "git status",
  ])("%s", (cmd) => {
    expect(run(cmd)).toBe(0);
  });
});
