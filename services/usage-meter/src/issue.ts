// GitHub Issue text for a free-tier escalation (#902). Pure: the workflow script fetches the
// numbers and posts; this only renders. One open Issue per metric (title prefix
// `[usage:<metricKey>]`); later escalations become comments on it. Each post carries a
// hidden marker so a re-run on the same day at the same (or lower) level posts nothing.
import { LEVEL_LABEL, levelRank, levelReason, type EscalationLevel } from "./escalation";
import type { ConsumerResult } from "./consumers";
import { playbookFor, RUNBOOK_DIR } from "./playbook";
import { issueTitlePrefix } from "./summary";
import type { UsageServiceSummary } from "./types";

export const AREA_LABEL = "area:usage";

export function priorityLabel(level: EscalationLevel): "P0" | "P1" {
  return level === "critical" ? "P0" : "P1";
}

export function marker(metricKey: string, day: string, level: EscalationLevel): string {
  return `<!-- usage-escalation metric=${metricKey} day=${day} level=${level} -->`;
}

const MARKER_RE = /<!-- usage-escalation metric=(\S+) day=(\d{4}-\d{2}-\d{2}) level=(\w+) -->/g;

/** Highest level already posted for this metric on `day` (null = nothing posted today). */
export function postedLevelOn(texts: readonly string[], metricKey: string, day: string): EscalationLevel | null {
  let best: EscalationLevel | null = null;
  for (const t of texts) {
    for (const m of t.matchAll(MARKER_RE)) {
      if (m[1] !== metricKey || m[2] !== day) continue;
      const lv = m[3] as EscalationLevel;
      if (best === null || levelRank(lv) > levelRank(best)) best = lv;
    }
  }
  return best;
}

function fmtNum(v: number): string {
  return Math.round(v).toLocaleString("en-US");
}

function fmtJst(iso: string): string {
  const d = new Date(Date.parse(iso) + 9 * 3600_000);
  return `${d.toISOString().slice(0, 16).replace("T", " ")} JST`;
}

function statusLines(s: UsageServiceSummary, capturedAt: string | null): string[] {
  const lines = [
    `| 項目 | 値 |`,
    `|---|---|`,
    `| 段階 | **${LEVEL_LABEL[s.level]}** (${s.level}) |`,
    `| 使用量 | ${s.used === null ? "?" : fmtNum(s.used)} / ${fmtNum(s.limit)} ${s.unit} (**${s.pct ?? "?"}%**) |`,
  ];
  const p = s.projection;
  if (p) {
    const when = p.exhaustsAt ? fmtJst(p.exhaustsAt) : "リセットまで / 1 年以内には届かない";
    lines.push(`| 上限に届く見込み | ${when} |`);
    if (p.pctAtReset !== null) lines.push(`| リセット時の見込み | ${p.pctAtReset}% |`);
    lines.push(`| ペース | ${fmtNum(p.perDay)} ${s.unit.split("/")[0]}/日 |`);
  }
  lines.push(`| リセット | ${s.resetsAt ? fmtJst(s.resetsAt) : "なし（累積）"} |`);
  lines.push(`| 上限を超えると | ${s.overflowBehavior === "halt" ? "**止まる**（429 / 送信不可。勝手に課金はされない）" : "課金される"} |`);
  if (capturedAt) lines.push(`| 取得時刻 | ${fmtJst(capturedAt)} |`);
  return lines;
}

function consumerLines(s: UsageServiceSummary, consumers: ConsumerResult): string[] {
  if ("error" in consumers) {
    return [
      `自動では取得できませんでした（${consumers.error}）。`,
      `手順書の「使っている所の調べ方」のクエリで確認してください。`,
    ];
  }
  if (consumers.lines.length === 0) return [consumers.note ?? "内訳はありませんでした。"];
  const out = [`| # | 使っている所 | 量 | 割合 |`, `|---|---|---|---|`];
  consumers.lines.forEach((c, i) => {
    const share = s.used && s.used > 0 ? Math.round((c.value / s.used) * 1000) / 10 : c.share;
    out.push(`| ${i + 1} | ${c.name.replace(/\|/g, "\\|")} | ${fmtNum(c.value)} | ${share}% |`);
  });
  out.push("", "割合はこの項目の使用量に対する目安（集計の時刻がずれるため合計は 100% になりません）。");
  if (consumers.note) out.push(consumers.note);
  return out;
}

export interface EscalationPost {
  title: string;
  body: string;
  labels: string[];
}

/** New Issue for a metric that has no open escalation Issue. */
export function buildIssue(
  s: UsageServiceSummary,
  day: string,
  capturedAt: string | null,
  consumers: ConsumerResult,
): EscalationPost {
  const pb = playbookFor(s.metricKey);
  const body = [
    `無料枠の **${s.label}** が上限に近づいています。対策で乗り切るか、課金するかを決めてください。`,
    `理由: ${levelReason(s.pct, s.projection)}`,
    "",
    "## 状況",
    ...statusLines(s, capturedAt),
    "",
    "## 何が使っているか",
    ...consumerLines(s, consumers),
    "",
    "## 対策（手順書から）",
    ...pb.mitigations.map((m) => `- [ ] ${m}`),
    "",
    `詳しくは手順書: [${pb.title}](${s.playbookUrl})`,
    "",
    "## 課金するか",
    `- 課金する場合: **${pb.paid.name}** — ${pb.paid.price}`,
    ...(pb.paid.note ? [`- ${pb.paid.note}`] : []),
    "- 決めたらどれか 1 つにチェックを付けて、理由をコメントに残してください（課金は人が決めます。自動では上げません）",
    "  - [ ] 対策で乗り切る（上の対策を PR にする）",
    "  - [ ] 課金する（契約したらこの Issue に日付と金額を書く）",
    "  - [ ] 一時的な増加なので様子を見る",
    "",
    "## この Issue について",
    `- usage-escalation ワークフローが自動で作りました。段階: 注意 70% / 対策 85% / 危険 95%（危険は P0）。リセット前に上限に届く見込みのときも注意以上になります。`,
    `- 同じ項目は 1 日 1 回まで。段階が上がった時だけ追記します。落ち着いたら閉じてください（再び上がれば新しく作ります）。`,
    `- 一覧: \`${RUNBOOK_DIR}/README.md\``,
    "",
    marker(s.metricKey, day, s.level),
  ];
  return {
    title: `${issueTitlePrefix(s.metricKey)} ${s.label} が無料枠の ${s.pct ?? "?"}%（${LEVEL_LABEL[s.level]}）`,
    body: body.join("\n"),
    labels: [AREA_LABEL, priorityLabel(s.level)],
  };
}

/** Follow-up comment on the metric's existing open Issue. */
export function buildComment(
  s: UsageServiceSummary,
  day: string,
  capturedAt: string | null,
  consumers: ConsumerResult,
): string {
  return [
    `### ${day}: ${LEVEL_LABEL[s.level]}（${s.pct ?? "?"}%）`,
    `理由: ${levelReason(s.pct, s.projection)}`,
    "",
    ...statusLines(s, capturedAt),
    "",
    "**何が使っているか**",
    "",
    ...consumerLines(s, consumers),
    "",
    `手順書: ${s.playbookUrl}`,
    "",
    marker(s.metricKey, day, s.level),
  ].join("\n");
}
