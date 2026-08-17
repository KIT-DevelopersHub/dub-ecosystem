// Local dev / demo seed for the FE4 gantt.
//
// Source of truth: the real 北陸ITカンファレンス (DevelopersHub) roadmap that lives
// in leaders-meetup-bot (LMB). LMB's gantt is data-driven from Cloudflare D1 and the
// authoritative structure is the `summaryGroups` config (41 work-package sections /
// 129 WBS leaves) across 7 teams and 6 phases (F1,F3–F7). See:
//   leaders-meetup-bot/scripts/data/2026-07-22-gantt-team-reassign.sql   (config + real deps)
//   leaders-meetup-bot/scripts/data/2026-07-22-gantt-honbu-process-labels.sql (real 本部 titles)
//   leaders-meetup-bot/migrations/0077_gantt_tracker.sql                 (team/phase/wbs schema)
//
// Fidelity notes:
//  - Each section below is a REAL work-package (title/team/phase/WBS verbatim from the
//    LMB config); under each we hang its REAL WBS leaves (the 129 leaf codes from the
//    same config) as collapsible child rows — so the tree matches LMB's GanttSummaryRow
//    view (41 work-packages) plus one level of drill-down (WBS leaves).
//  - Per-task start/end dates are NOT committed in the public LMB repo (they live only
//    in prod D1). We therefore derive each bar from its phase window (documented below)
//    so the demo shows a faithful, legible timeline. The two tasks that DO carry real
//    dates in-repo (WBS 3.4, 2026-08-16 → 2026-09-15) keep those exact dates.
//  - Dependencies encode the real phase spine + a handful of the real cross-section
//    edges; the critical path is the F1→F3→F4→F5→F6→F7 governance backbone.
import type { task, identity, gantt, common, team } from "@dub/types";
import { MockApiClient } from "./api/mock-client";

export const DEMO_EVENT_ID = "evt_hokuriku_conf_2027";
/** signed-in user for the standalone My Tasks demo (createdBy stamp + /me scope).
 *  Points at a real conference owner (高岡/本部) so the マイタスク tab is populated
 *  with real roadmap tasks rather than empty. Prod uses the real /me user, not this. */
export const DEMO_CURRENT_USER = "usr_takaoka";

const MS_DAY = 86_400_000;
const iso = (d: string): common.ISODateTime => `${d}T00:00:00.000Z`;

// ---- teams (LMB's 7 real conference teams; colours mirror the member-service roster) ----
const teams: team.Team[] = [
  { id: "team_honbu", key: "honbu", name: "本部", color: "#1e3a5f", description: "全体統括・意思決定・進行統制" },
  { id: "team_shinko", key: "shinko", name: "全体進行", color: "#2563eb", description: "進行管理・当日運営・定例運営" },
  { id: "team_dev", key: "dev", name: "開発", color: "#0d9488", description: "運営アプリ内製" },
  { id: "team_sponsor", key: "sponsor", name: "スポンサー", color: "#ea580c", description: "協賛打診・契約" },
  { id: "team_venue", key: "venue", name: "会場", color: "#16a34a", description: "会場・設営・ネットワーク／配信" },
  { id: "team_kaikei", key: "kaikei", name: "会計", color: "#7c3aed", description: "法人設立・予算・会計運用" },
  { id: "team_pr", key: "pr", name: "集客告知", color: "#db2777", description: "LP・SNS・広報／集客" },
];
const TEAM_ID: Record<string, common.TeamId> = Object.fromEntries(teams.map((t) => [t.name, t.id]));

// ---- users (real運営メンバー names from the member-service roster; one owner per team) ----
const users: identity.UserSummary[] = [
  { id: "usr_takaoka", displayName: "高岡 己太朗", avatarUrl: null },
  { id: "usr_kume", displayName: "久米", avatarUrl: null },
  { id: "usr_araki", displayName: "荒木", avatarUrl: null },
  { id: "usr_yoshioka", displayName: "吉岡", avatarUrl: null },
  { id: "usr_shimizu", displayName: "清水", avatarUrl: null },
  { id: "usr_kurokawa", displayName: "黒川", avatarUrl: null },
  { id: "usr_shiraki", displayName: "白木", avatarUrl: null },
];
const OWNER: Record<string, common.UserId | null> = {
  本部: "usr_takaoka",
  全体進行: "usr_kume",
  開発: "usr_araki",
  スポンサー: "usr_yoshioka",
  会場: "usr_shimizu",
  会計: "usr_kurokawa",
  集客告知: "usr_shiraki",
};

// ---- phase windows (UTC). Real dates aren't public; these bracket each phase so bars
//      spread legibly. Today (2026-08) lands between F1 (done) and F3 (in progress). ----
type Phase = "F1" | "F3" | "F4" | "F5" | "F6" | "F7";
const PHASE_WINDOW: Record<Phase, [string, string]> = {
  F1: ["2026-06-01", "2026-08-10"], // 法人設立
  F3: ["2026-08-11", "2026-10-20"], // Phase1 立ち上げ (10人)
  F4: ["2026-10-15", "2027-01-20"], // Phase2 6チーム稼働 (30人)
  F5: ["2027-01-15", "2027-02-28"], // 6→8チーム移行 (会場3分割)
  F6: ["2027-02-20", "2027-05-25"], // Phase3 コア完成 (50人)
  F7: ["2027-05-20", "2027-07-15"], // Phase4 本番 (300人)
};

interface Sec {
  wbs: string;
  title: string;
  team: string;
  phase: Phase;
  status?: task.TaskStatus; // default derived from phase
  priority?: task.TaskPriority;
}

// The 41 real section work-packages (verbatim from LMB's summaryGroups config).
const SECTIONS: Sec[] = [
  // F1 法人設立
  { wbs: "1.1", title: "会計: 法人設立（発起人〜定款〜登記〜証明取得）", team: "会計", phase: "F1" },
  { wbs: "1.2", title: "会計: 設立後の届出（税務署/自治体/社保/インボイス）", team: "会計", phase: "F1" },
  { wbs: "1.3", title: "会計: 銀行・会計基盤（口座/会計ソフト）", team: "会計", phase: "F1" },
  { wbs: "1.4", title: "会計: 会計規程・経費ルール", team: "会計", phase: "F1" },
  // F3 Phase1 立ち上げ
  { wbs: "3.1", title: "本部: リーダー打診・キックオフ", team: "本部", phase: "F3", status: "done", priority: "high" },
  { wbs: "3.2", title: "全体進行: 進行管理立ち上げ・定例運営", team: "全体進行", phase: "F3", status: "in_progress" },
  { wbs: "3.3", title: "開発: アプリ開発（要件定義から）", team: "開発", phase: "F3", status: "in_progress", priority: "high" },
  { wbs: "3.4", title: "本部: 会議体・意思決定設計", team: "本部", phase: "F3" }, // real dates below
  { wbs: "3.5", title: "本部: 組織設計・役割分担(RACI)", team: "本部", phase: "F3" },
  { wbs: "3.6", title: "本部: ドキュメント/ナレッジ基盤", team: "本部", phase: "F3" },
  { wbs: "3.7", title: "本部: 運営規約・行動規範（ドラフト）", team: "本部", phase: "F3" },
  // F4 Phase2 6チーム稼働
  { wbs: "4.1", title: "スポンサー: 打診・契約", team: "スポンサー", phase: "F4" },
  { wbs: "4.2", title: "集客告知: 公式LP 開設・運用", team: "集客告知", phase: "F4" },
  { wbs: "4.5", title: "集客告知: SNS発信", team: "集客告知", phase: "F4" },
  { wbs: "4.6", title: "集客告知: 学内告知", team: "集客告知", phase: "F4" },
  { wbs: "4.7", title: "集客告知: 各団体周知", team: "集客告知", phase: "F4" },
  { wbs: "4.8", title: "集客告知: 地方団体交流", team: "集客告知", phase: "F4" },
  { wbs: "4.9", title: "会計: カンファ会計運用（予算/協賛金/支出/精算）", team: "会計", phase: "F4" },
  { wbs: "4.10", title: "会計: 全体予算計画（テンプレ〜集約〜承認）", team: "会計", phase: "F4" },
  { wbs: "4.3", title: "会場: 会場KIT 仮予約", team: "会場", phase: "F4" },
  { wbs: "4.4", title: "本部: コア30体制確立", team: "本部", phase: "F4", priority: "high" },
  { wbs: "4.11", title: "本部: マスタースケジュール・進捗統括", team: "本部", phase: "F4" },
  { wbs: "4.12", title: "本部: リスク管理・危機対応", team: "本部", phase: "F4" },
  { wbs: "4.13", title: "本部: 予備費・緊急支出 承認フロー", team: "本部", phase: "F4" },
  { wbs: "4.14", title: "本部: 外部折衝・渉外統括", team: "本部", phase: "F4" },
  // F5 6→8チーム移行
  { wbs: "5.1", title: "会場3チームへ分割・8チーム移行", team: "会場", phase: "F5" },
  { wbs: "5.2", title: "本部: 体制移行ガバナンス（8チーム化）", team: "本部", phase: "F5", priority: "high" },
  // F6 Phase3 コア完成
  { wbs: "6.1", title: "本部: コア50・班長任命", team: "本部", phase: "F6", priority: "high" },
  { wbs: "6.2", title: "本部: 新入生勧誘・当日ボランティア募集", team: "本部", phase: "F6" },
  { wbs: "6.3", title: "会計: チケット設計・早割", team: "会計", phase: "F6" },
  { wbs: "6.4", title: "集客告知: イベントページ（Connpass等 複数PF）", team: "集客告知", phase: "F6" },
  { wbs: "6.5", title: "全体進行: 参加者向けドキュメント（CoC/FAQ/当日ガイド）", team: "全体進行", phase: "F6" },
  { wbs: "6.6", title: "本部: 各種規約 確定（CoC/個人情報/肖像権）", team: "本部", phase: "F6" },
  { wbs: "6.7", title: "全体進行: 保険・安全・防災・救護", team: "全体進行", phase: "F6" },
  { wbs: "6.8", title: "全体進行: 当日運営体制 設計", team: "全体進行", phase: "F6" },
  { wbs: "6.9", title: "本部: 参加者/来場者対応方針", team: "本部", phase: "F6" },
  // F7 Phase4 本番
  { wbs: "7.1", title: "全体進行: 研修・シフト・合流", team: "全体進行", phase: "F7" },
  { wbs: "7.2", title: "会場: 前日設営", team: "会場", phase: "F7" },
  { wbs: "7.3", title: "全体進行: カンファ本番（当日統括）", team: "全体進行", phase: "F7", priority: "urgent" },
  { wbs: "7.4", title: "会計: 当日会計・決算・税務申告", team: "会計", phase: "F7" },
  { wbs: "7.5", title: "本部: 事後処理・振り返り・引き継ぎ", team: "本部", phase: "F7" },
];

// The 129 real WBS leaves (verbatim codes from LMB's summaryGroups config), keyed
// by their parent section work-package. Each leaf becomes a child row that hangs
// under its work-package and shows/hides via the parent's toggle. Leaf *titles* and
// per-leaf dates are not committed in the public LMB repo (they live in prod D1),
// so — like the section bars above — each leaf renders its real WBS code under its
// process name, and its bar is sliced from the parent's phase window.
const SECTION_LEAVES: Record<string, string[]> = {
  "1.1": ["1.1.0", "1.1.1", "1.1.2", "1.1.3", "1.1.4", "1.1.5", "1.1.6", "1.1.7", "1.1.8", "1.1.9"],
  "1.2": ["1.2.1", "1.2.2", "1.2.3", "1.2.4", "1.2.5"],
  "1.3": ["1.3.1", "1.3.2", "1.3.3", "1.3.4"],
  "1.4": ["1.4.1", "1.4.2"],
  "3.1": ["3.1.1", "3.1.2", "3.1.4", "3.1.5"],
  "3.2": ["3.2.1", "3.1.3"],
  "3.3": ["3.3"],
  "3.4": ["3.4.1", "3.4.2", "3.4.3", "3.4.4", "3.4.5"],
  "3.5": ["3.5.1", "3.5.2", "3.5.3"],
  "3.6": ["3.6.1", "3.6.2", "3.6.3"],
  "3.7": ["3.7.1", "3.7.2"],
  "4.1": ["4.1.1"],
  "4.2": ["4.2.1", "4.2.2", "4.2.3", "4.2.4", "4.2.5"],
  "4.5": ["4.5.1", "4.5.2", "4.5.3", "4.5.4"],
  "4.6": ["4.6.1", "4.6.2", "4.6.3"],
  "4.7": ["4.7.1", "4.7.2"],
  "4.8": ["4.8.1", "4.8.2"],
  "4.9": ["4.9.1", "4.9.2", "4.9.3", "4.9.4", "4.9.5", "4.9.6", "4.9.7", "4.9.8"],
  "4.10": ["4.10.1", "4.10.2", "4.10.3", "4.10.4", "4.10.5"],
  "4.3": ["4.3.1"],
  "4.4": ["4.4.1", "4.4.2", "4.4.3"],
  "4.11": ["4.11.1", "4.11.2", "4.11.3"],
  "4.12": ["4.12.1", "4.12.2", "4.12.3"],
  "4.13": ["4.13.1"],
  "4.14": ["1.5.2", "4.14.1", "4.14.2"],
  "5.1": ["5.1.1"],
  "5.2": ["5.2.1", "5.2.2"],
  "6.1": ["6.1.1", "6.1.2"],
  "6.2": ["6.2.1", "6.2.2"],
  "6.3": ["6.3.1"],
  "6.4": ["6.4.1", "6.4.2", "6.4.3"],
  "6.5": ["6.5.1", "6.5.2", "6.5.3"],
  "6.6": ["6.6.1", "6.6.2", "6.6.3", "6.6.4"],
  "6.7": ["6.7.1", "6.7.2", "6.7.3"],
  "6.8": ["6.8.1", "6.8.2", "6.8.3", "6.8.4"],
  "6.9": ["6.9.1", "6.9.2"],
  "7.1": ["7.1.1", "7.1.2"],
  "7.2": ["7.2.1"],
  "7.3": ["7.3.1", "7.3.6", "7.3.2", "7.3.3", "7.3.4", "7.3.5"],
  "7.4": ["7.4.1", "7.4.2", "7.4.3", "7.4.4"],
  "7.5": ["7.5.1", "7.5.2", "7.5.3", "7.5.4"],
};

const secId = (wbs: string): common.TaskId => `task_${wbs.replace(/\./g, "_")}`;

/** Short process label for a leaf row: the section title without its team prefix
 *  and trailing parenthetical, e.g. "会計: 法人設立（…）" -> "法人設立". */
function shortProcess(title: string): string {
  const afterTeam = title.includes(": ") ? title.slice(title.indexOf(": ") + 2) : title;
  const paren = afterTeam.search(/[（(]/);
  return (paren >= 0 ? afterTeam.slice(0, paren) : afterTeam).trim();
}

/** Row-hierarchy overlay the mock projects onto each GanttRow. */
type MockSeedHierarchy = Record<
  common.TaskId,
  { parentTaskId: common.TaskId | null; depth: number; wbs?: string }
>;

// Real dependency edges we can represent at section level: the phase spine (critical)
// plus real cross-section handoffs. from = predecessor (先行), to = successor (後続).
const DEP_PAIRS: Array<[string, string]> = [
  // ---- critical governance spine F1→F3→F4→F5→F6→F7 ----
  ["1.1", "3.1"],
  ["3.1", "4.4"],
  ["4.4", "5.2"],
  ["5.2", "6.1"],
  ["6.1", "7.3"],
  ["7.3", "7.5"],
  // ---- real / logical cross-section handoffs ----
  ["3.1", "3.4"], // 会議体設計 は キックオフ後
  ["3.1", "3.5"], // 組織設計(RACI) は リーダー打診後
  ["4.4", "4.11"], // マスタースケジュール は コア30体制後
  ["4.2", "6.4"], // イベントページ は 公式LP後
  ["6.1", "6.6"], // 各種規約確定 は コア50後
  ["6.8", "7.3"], // 本番 は 当日運営体制設計後
  ["5.1", "5.2"], // 体制移行ガバナンス は 会場8チーム分割後
];
const CRITICAL_WBS = ["1.1", "3.1", "4.4", "5.2", "6.1", "7.3", "7.5"];

const TODAY = Date.parse(iso("2026-08-13"));

function defaultStatus(phase: Phase, end: number): task.TaskStatus {
  if (phase === "F1") return "done";
  if (end < TODAY) return "done";
  return "todo";
}

/** Build the work-package (parent) + WBS-leaf (child) tasks and their derived
 *  bars. Parents are staggered within each phase; each parent's leaves are then
 *  sliced across the parent's own bar so a waterfall reads under it when opened. */
function build(): {
  tasks: task.Task[];
  rowDates: MockSeedRowDates;
  deps: gantt.GanttDependencyLine[];
  hierarchy: MockSeedHierarchy;
} {
  const now = "2026-06-01T00:00:00.000Z";
  const byPhase = new Map<Phase, Sec[]>();
  for (const s of SECTIONS) (byPhase.get(s.phase) ?? byPhase.set(s.phase, []).get(s.phase)!).push(s);

  const tasks: task.Task[] = [];
  const rowDates: MockSeedRowDates = {};
  const hierarchy: MockSeedHierarchy = {};

  const pushTask = (t: task.Task) => tasks.push(t);

  for (const [phase, secs] of byPhase) {
    const win = PHASE_WINDOW[phase];
    const ws = Date.parse(iso(win[0]));
    const we = Date.parse(iso(win[1]));
    const span = we - ws;
    const n = secs.length;
    const slot = span / n;
    secs.forEach((s, i) => {
      const id = secId(s.wbs);
      // real in-repo dates for WBS 3.4 (see header); everything else phase-derived.
      let startMs = ws + i * slot;
      let endMs = Math.min(we, startMs + slot * 1.4);
      if (s.wbs === "3.4") {
        startMs = Date.parse(iso("2026-08-16"));
        endMs = Date.parse(iso("2026-09-15"));
      }
      const status = s.status ?? defaultStatus(phase, endMs);
      const dueAt = new Date(endMs).toISOString();
      // ---- parent (work-package) row ----
      pushTask({
        id,
        eventId: DEMO_EVENT_ID,
        title: s.title,
        description: `WBS ${s.wbs} ・ ${phase} ・ ${s.team}`,
        status,
        priority: s.priority ?? "medium",
        assigneeId: OWNER[s.team] ?? null,
        teamId: TEAM_ID[s.team] ?? null,
        dueAt,
        origin: "internal",
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
        version: 1,
      });
      rowDates[id] = { startsAt: new Date(startMs).toISOString(), endsAt: dueAt };
      hierarchy[id] = { parentTaskId: null, depth: 0, wbs: s.wbs };

      // ---- children (WBS leaves), sliced across the parent's bar ----
      const leaves = (SECTION_LEAVES[s.wbs] ?? []).filter((w) => w !== s.wbs);
      const proc = shortProcess(s.title);
      const k = leaves.length;
      const cSlot = k > 0 ? (endMs - startMs) / k : 0;
      leaves.forEach((w, j) => {
        const cid = secId(w);
        const cStart = startMs + j * cSlot;
        const cEnd = j === k - 1 ? endMs : startMs + (j + 1) * cSlot;
        const cStatus = defaultStatus(phase, cEnd);
        const cDue = new Date(cEnd).toISOString();
        pushTask({
          id: cid,
          eventId: DEMO_EVENT_ID,
          title: `${proc} ${w}`,
          description: `WBS ${w} ・ ${phase} ・ ${s.team}`,
          status: cStatus,
          priority: "medium",
          assigneeId: OWNER[s.team] ?? null,
          teamId: TEAM_ID[s.team] ?? null,
          dueAt: cDue,
          origin: "internal",
          archivedAt: null,
          createdAt: now,
          updatedAt: now,
          version: 1,
        });
        rowDates[cid] = { startsAt: new Date(cStart).toISOString(), endsAt: cDue };
        hierarchy[cid] = { parentTaskId: id, depth: 1, wbs: w };
      });
    });
  }
  const deps = DEP_PAIRS.map(([from, to]): gantt.GanttDependencyLine => {
    const f = secId(from);
    const t = secId(to);
    return { id: `${f}->${t}`, fromTaskId: f, toTaskId: t, type: "FS", lagDays: 0 };
  });
  return { tasks, rowDates, deps, hierarchy };
}

type MockSeedRowDates = Record<
  common.TaskId,
  { startsAt: common.ISODateTime | null; endsAt: common.ISODateTime | null }
>;

export function createDevClient(opts: { padTo?: number } = {}): MockApiClient {
  const { tasks, rowDates, deps, hierarchy } = build();
  // Dev/E2E only: pad the event with extra top-level tasks so the timeline can be
  // exercised past the 200-per-page ceiling (F3 — verify all rows load & render).
  if (opts.padTo && opts.padTo > tasks.length) {
    const base = Date.parse("2027-03-01T00:00:00.000Z");
    for (let i = tasks.length; i < opts.padTo; i++) {
      const due = new Date(base + (i % 30) * 86_400_000).toISOString();
      tasks.push({
        id: `task_pad_${i}`,
        eventId: DEMO_EVENT_ID,
        title: `追加タスク #${i}`,
        description: null,
        status: "todo",
        priority: "medium",
        assigneeId: null,
        teamId: null,
        createdBy: DEMO_CURRENT_USER,
        dueAt: due,
        origin: "internal",
        version: 1,
        archivedAt: null,
        createdAt: due,
        updatedAt: due,
      } as task.Task);
    }
  }
  return new MockApiClient({
    currentUserId: DEMO_CURRENT_USER,
    users,
    teams,
    tasks,
    dependencies: deps,
    rowDates,
    hierarchy,
    criticalTaskIds: CRITICAL_WBS.map(secId),
  });
}

export const DEMO_PERMISSIONS: identity.PermissionKey[] = ["task:read", "task:write", "task:delete"];
