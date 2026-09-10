// Home / dashboard (design 2-1, revamp → "ダッシュボード"). FE2 owns the frame.
//
// The screen opens with a KPI row so the whole operation reads at a glance: a live
// countdown to 本戦, task-completion and free-tier gauges, and the live unread /
// upcoming-event counts. Below it, two visualization cards (無料枠の使用状況・タスクの
// 内訳) make the percentages tangible, then the full app launchpad (every app kept —
// this is the daily workspace), and a right rail of live panels (直近のイベント・未読の
// 通知) unchanged from the launchpad.
//
// Data honesty: every figure is LIVE. The countdown comes from the wall clock; the
// unread count, upcoming events, task-completion breakdown, free-tier usage and
// member/team counts are all aggregated by /bff/home (from notification / event /
// task-service / usage-meter / member-service). Partial upstream failure is surfaced
// per-frame via useBffHome().errorFor — the affected tile/card shows "取得できませんでした"
// while the rest stay live; no global toast. FE3–FE7 may still contribute a
// homeWidget; each renders in its own boundary.
//
// Customization (P3-2/P3-3): each viewer can reorder / hide widgets and switch
// density, persisted per-viewer in UiStore. P3-3 replaced the separate カスタマイズ
// modal with an inline 編集モード — tap "編集" and the widgets on THIS screen become
// the draggable rows (iOS ホーム画面編集 style: dashed frame + light jiggle + a grip
// handle + a per-widget hide toggle); tap "完了" to exit. See HomeEditableRegion.tsx.
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Badge, Button, Card, Icon, PageHeader, SegmentedControl, SkeletonLoader } from "@dub/ui";
import { toCssVarName } from "@dub/tokens";
import type { ApiClient } from "../../lib/api-client.tsx";
import type { HomeWidget } from "../../modules/types.tsx";
import { useUiStore, type HomeDensity } from "../../store/uiStore.tsx";
import { useBffHome } from "../../bff/useBffHome.tsx";
import { renderHomeWidget } from "./HomeWidgetFrame.tsx";
import { KpiTile } from "./dashboard/KpiTile.tsx";
import { Meter, SegmentBar } from "./dashboard/DashboardCharts.tsx";
import { HomeEditableRegion } from "./dashboard/HomeEditableRegion.tsx";
import { sizeOf, spanStyle, type HomeWidgetMeta } from "./dashboard/homeLayout.ts";
import {
  CONFERENCE,
  daysUntil,
  freeTierFromMetrics,
  statusMeta,
  taskCompletionPct,
  taskSegmentsFromCounts,
  taskTotal,
  usageStatusFromPct,
  worstFreeTier,
  type MetricStatus,
} from "./dashboard/dashboardData.ts";

type IconName = Parameters<typeof Icon>[0]["name"];

interface AppTile {
  id: string;
  label: string;
  desc: string;
  icon: IconName;
  path: string;
}

// The primary app launchpad. Paths mirror the registered feature nav entries
// (see composition.test.tsx) so a tile always lands on a real, populated route.
// We never hide apps here — this is the full daily-workspace set.
const APP_TILES: AppTile[] = [
  { id: "events", label: "イベント", desc: "運営中のイベントと進行", icon: "calendar", path: "/events" },
  { id: "tasks", label: "マイタスク", desc: "自分の担当タスク", icon: "check-square", path: "/me/tasks" },
  { id: "gantt", label: "ガントチャート", desc: "全体スケジュール", icon: "clock", path: "/gantt" },
  { id: "notifications", label: "通知", desc: "お知らせ一覧", icon: "bell", path: "/notifications" },
  { id: "chat", label: "チャット", desc: "チームのやりとり", icon: "message-square", path: "/chat" },
  { id: "mail", label: "メール", desc: "運営メールの送受信", icon: "inbox", path: "/mail" },
  { id: "usage", label: "無料枠", desc: "利用状況と課金ガード", icon: "shield", path: "/usage" },
  { id: "members", label: "運営メンバー", desc: "メンバーとチーム", icon: "users", path: "/members" },
  { id: "driveshare", label: "Drive共有", desc: "共有ファイルと権限", icon: "file", path: "/driveshare" },
];

const DENSITY_OPTIONS: { value: HomeDensity; label: string }[] = [
  { value: "comfortable", label: "通常" },
  { value: "compact", label: "コンパクト" },
];

/** One clickable app tile. Renders as an anchor (real href for accessibility /
 *  hover-URL / cmd-click) but performs SPA navigation via onNavigate when wired;
 *  in unit tests (no onNavigate) it is an inert, present anchor. */
function NavTile({
  tile,
  badge,
  onNavigate,
}: {
  tile: AppTile;
  badge?: number;
  onNavigate?: (path: string) => void;
}): JSX.Element {
  const hasBadge = typeof badge === "number" && badge > 0;
  return (
    <a
      href={tile.path}
      className="fe2-home-tile"
      data-testid={`fe2-home-tile-${tile.id}`}
      title={tile.desc}
      aria-label={hasBadge ? `${tile.label}（${badge}）へ移動` : `${tile.label}へ移動`}
      onClick={(e) => {
        if (onNavigate) {
          e.preventDefault();
          onNavigate(tile.path);
        }
      }}
    >
      <span className="fe2-home-tile-icon" aria-hidden="true">
        <Icon name={tile.icon} />
      </span>
      <span className="fe2-home-tile-label">{tile.label}</span>
      {hasBadge ? (
        <span className="fe2-home-tile-badge" data-testid={`fe2-home-tile-${tile.id}-badge`}>
          {badge}
        </span>
      ) : null}
    </a>
  );
}

/** Higher completion is better (opposite of usage): good ≥60, warn ≥30, else critical. */
function completionStatus(pct: number): MetricStatus {
  if (pct >= 60) return "good";
  if (pct >= 30) return "warn";
  return "critical";
}

/** Countdown urgency: ≤3d 逼迫, ≤7d 注意, else 情報. */
function countdownStatus(days: number): MetricStatus {
  if (days <= 3) return "critical";
  if (days <= 7) return "warn";
  return "info";
}

// Shell content bottom padding (@dub/ui `.shellContent` uses --dub-space-6 = 24px).
// Left over below the clamped dashboard so the shell总高 lands on exactly 100vh.
const SHELL_CONTENT_PAD_BOTTOM = 24;
const MIN_DASHBOARD_H = 360;

/** Locks the dashboard to a single viewport (hard requirement: Home never scrolls
 *  the page). Measures the element's offset from the top of the window — the shell
 *  header + content padding stacked above it — and sets its height to fill the rest,
 *  minus the shell's bottom padding. With `overflow: hidden` on the dashboard, any
 *  surplus content is absorbed by the internal scroll regions (event list / app
 *  grid) rather than the page. Recomputes on resize (the header can re-wrap narrow). */
function useViewportFit<T extends HTMLElement>(): RefObject<T> {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof window === "undefined") return;
    const apply = (): void => {
      const top = el.getBoundingClientRect().top;
      const h = Math.max(MIN_DASHBOARD_H, window.innerHeight - top - SHELL_CONTENT_PAD_BOTTOM);
      el.style.height = `${h}px`;
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, []);
  return ref;
}

export function HomeScreen({
  api,
  homeWidgets = [],
  onOpenNotifications,
  onNavigate,
}: {
  api: ApiClient;
  homeWidgets?: HomeWidget[];
  // When provided, the "未読の通知" card becomes a button that opens the shared
  // notification dialog — the SAME modal the header bell opens.
  onOpenNotifications?: () => void;
  // SPA navigation for the app tiles / event rows / "すべて見る" links. Threaded
  // from the shell router (main.tsx wires router.navigate). Absent in unit tests.
  onNavigate?: (path: string) => void;
}): JSX.Element {
  const { data, isPending, errorFor, refetch } = useBffHome(api);
  const eventsError = errorFor("event-service");
  // The gateway BFF (bff-home) reports the notification upstream as "notification-service"
  // (same "<svc>-service" convention as "event-service"). Matching it here restores the
  // "取得できませんでした" card when notification-service degrades — previously the mismatched
  // "notification" key silently left the card at 未読 0 件 (bugfix).
  const notificationsError = errorFor("notification-service");
  const taskError = errorFor("task-service");
  const usageError = errorFor("usage-meter");
  const membersError = errorFor("member-service");

  const events = data?.upcomingEvents ?? [];
  const unread = data?.unreadCount ?? 0;

  // Live dashboard aggregates from /bff/home. A source in partialErrors leaves its
  // field undefined → we show "—"/an in-frame error rather than a misleading 0.
  const segments = taskSegmentsFromCounts(data?.taskSummary?.byStatus ?? {});
  const hasTasks = data?.taskSummary !== undefined && !taskError;
  const freeTier = usageError ? [] : freeTierFromMetrics(data?.usageSummary?.metrics ?? []);
  const worst = worstFreeTier(freeTier);
  const orgMembers = membersError ? undefined : data?.orgStats?.members;
  const orgTeams = membersError ? undefined : data?.orgStats?.teams;

  // Live counts injected onto the matching tile (only when that aggregate is
  // healthy — a partial error hides the number rather than showing a wrong 0).
  const badgeFor = (id: string): number | undefined => {
    if (isPending) return undefined;
    if (id === "events") return eventsError ? undefined : events.length;
    if (id === "notifications") return notificationsError ? undefined : unread;
    return undefined;
  };

  const go = (path: string) => (e: { preventDefault(): void }) => {
    if (onNavigate) {
      e.preventDefault();
      onNavigate(path);
    }
  };

  // ── derived KPI values ────────────────────────────────────────────────────────
  const days = daysUntil(CONFERENCE.dateISO);
  const cdStatus = days === null ? "info" : countdownStatus(days);
  const completion = taskCompletionPct(segments);
  const compStatus = completionStatus(completion);
  const worstStatus = worst ? usageStatusFromPct(worst.pct) : "info";
  const unreadStatus: MetricStatus = notificationsError ? "info" : unread > 0 ? "warn" : "good";

  const rootRef = useViewportFit<HTMLElement>();

  // ── per-viewer dashboard preferences (P3-2, edit UX reworked in P3-3) ───────────
  // Density + widget order + hidden set live in UiStore (persisted). Each viewer/role
  // shapes their own dashboard; changes apply immediately (a live preview) and survive
  // reload. The catalog below is the single list of reorderable / hideable units.
  const density = useUiStore((s) => s.homeDensity);
  const setHomeDensity = useUiStore((s) => s.setHomeDensity);
  const sizes = useUiStore((s) => s.homeLayout.sizes);
  const resetHomeLayout = useUiStore((s) => s.resetHomeLayout);
  const [isEditing, setIsEditing] = useState(false);

  // P3-4: each widget can be small/medium/large (iOS 風グリッド). The full-width app
  // launchpad and the two fixed visualization cards opt out (`resizable: false`) —
  // their content doesn't read well shrunk to a small tile. Side-rail panels default
  // to "medium" (= full width, spanning both grid columns) so the dashboard looks
  // IDENTICAL to before P3-4 until a viewer deliberately shrinks one to "small".
  const catalog: HomeWidgetMeta[] = [
    { id: "kpi-countdown", label: "本戦まで", region: "kpi" },
    { id: "kpi-tasks", label: "タスク完了率", region: "kpi" },
    { id: "kpi-freetier", label: "無料枠 最逼迫", region: "kpi" },
    { id: "kpi-unread", label: "未読の通知（指標）", region: "kpi" },
    { id: "kpi-events", label: "直近のイベント（指標）", region: "kpi" },
    { id: "kpi-members", label: "運営メンバー", region: "kpi" },
    { id: "card-usage", label: "無料枠の使用状況", region: "cards", resizable: false },
    { id: "card-tasks", label: "タスクの内訳", region: "cards", resizable: false },
    { id: "section-apps", label: "アプリランチャー", region: "apps", resizable: false },
    { id: "panel-events", label: "直近のイベント", region: "side", defaultSize: "medium" },
    { id: "panel-notifications", label: "未読の通知", region: "side", defaultSize: "medium" },
    ...homeWidgets.map((w) => ({ id: `widget-${w.id}`, label: w.title, region: "side" as const, defaultSize: "medium" as const })),
  ];
  // A widget's own root-node style — a CSS Grid span from its effective size. Inert
  // unless that node is actually a direct child of a CSS Grid container (the resting
  // dashboard regions); harmlessly ignored during 編集モード, where HomeEditableRegion
  // sizes the SortableList row itself instead. Non-resizable widgets get no style (they
  // keep their region's own fixed layout, unchanged).
  const widgetStyle = (id: string) => {
    const meta = catalog.find((w) => w.id === id);
    return meta?.resizable === false ? undefined : spanStyle(sizeOf(catalog, sizes, id));
  };

  // Rendered node per widget id. KPI nodes are placed only in the loaded branch below
  // (during load the KPI strip shows one skeleton per tile instead, and edit mode is
  // unavailable while pending — there is nothing stable to reorder yet).
  const kpiNodes: Record<string, JSX.Element> = {
    "kpi-countdown": (
      <KpiTile
        testId="fe2-kpi-countdown"
        style={widgetStyle("kpi-countdown")}
        icon="clock"
        label="本戦まで"
        value={days === null ? "—" : String(days)}
        unit="日"
        status={cdStatus}
        hint={`${CONFERENCE.name}・${CONFERENCE.dateLabel}`}
      />
    ),
    "kpi-tasks": (
      <KpiTile
        testId="fe2-kpi-tasks"
        style={widgetStyle("kpi-tasks")}
        icon="check-square"
        label="タスク完了率"
        value={hasTasks ? `${Math.round(completion)}%` : "—"}
        status={hasTasks ? compStatus : "info"}
        {...(hasTasks ? { ring: { pct: completion, status: compStatus, ariaLabel: "タスク完了率" } } : {})}
        hint={taskError ? "取得できませんでした" : hasTasks ? `自分の担当 全 ${taskTotal(segments)} 件` : "—"}
      />
    ),
    "kpi-freetier": (
      <KpiTile
        testId="fe2-kpi-freetier"
        style={widgetStyle("kpi-freetier")}
        icon="shield"
        label="無料枠 最逼迫"
        value={worst ? `${Math.round(worst.pct)}%` : "—"}
        status={worstStatus}
        {...(worst ? { meter: { pct: worst.pct, status: worstStatus, ariaLabel: "無料枠の最逼迫指標" } } : {})}
        hint={usageError ? "取得できませんでした" : worst ? worst.label : "データがありません"}
      />
    ),
    "kpi-unread": (
      <KpiTile
        testId="fe2-kpi-unread"
        style={widgetStyle("kpi-unread")}
        icon="bell"
        label="未読の通知"
        value={notificationsError ? "—" : String(unread)}
        unit={notificationsError ? undefined : "件"}
        status={unreadStatus}
        hint={notificationsError ? "一部取得できませんでした" : unread > 0 ? "要確認" : "未読はありません"}
      />
    ),
    "kpi-events": (
      <KpiTile
        testId="fe2-kpi-events"
        style={widgetStyle("kpi-events")}
        icon="calendar"
        label="直近のイベント"
        value={eventsError ? "—" : String(events.length)}
        unit={eventsError ? undefined : "件"}
        status="info"
        hint={eventsError ? "取得できませんでした" : "進行中・予定"}
      />
    ),
    "kpi-members": (
      <KpiTile
        testId="fe2-kpi-members"
        style={widgetStyle("kpi-members")}
        icon="users"
        label="運営メンバー"
        value={orgMembers !== undefined ? String(orgMembers) : "—"}
        {...(orgMembers !== undefined ? { unit: "名" } : {})}
        status="info"
        hint={membersError ? "取得できませんでした" : orgTeams !== undefined ? `${orgTeams} チーム` : "—"}
      />
    ),
  };

  const cardNodes: Record<string, JSX.Element> = {
    "card-usage": (
      <Card
        testId="fe2-home-usage"
        header={
          <div className="fe2-home-card-head">
            <span className="fe2-stat-label">
              <Icon name="shield" />
              無料枠の使用状況
            </span>
            <a href="/usage" className="fe2-home-cardlink" data-testid="fe2-home-usage-all" onClick={go("/usage")}>
              詳細
              <Icon name="chevron-right" />
            </a>
          </div>
        }
      >
        {isPending ? (
          <SkeletonLoader lines={4} />
        ) : usageError ? (
          <div role="alert" data-testid="fe2-home-usage-error" className="fe2-inline-error">
            <p>使用状況を取得できませんでした。</p>
            <Button variant="secondary" size="sm" onClick={() => refetch()}>
              再試行
            </Button>
          </div>
        ) : freeTier.length === 0 ? (
          <p className="fe2-stat-hint">使用状況のデータがありません。</p>
        ) : (
          <ul className="fe2-usage-list">
            {freeTier.map((m) => {
              const st = usageStatusFromPct(m.pct);
              const meta = statusMeta(st);
              return (
                <li key={m.key} className="fe2-usage-row" data-testid={`fe2-usage-${m.key}`}>
                  <div className="fe2-usage-top">
                    <span className="fe2-usage-label">{m.label}</span>
                    <span className="fe2-usage-pct" style={{ color: toCssVarName(meta.colorPath) }}>
                      {m.pct.toFixed(1)}%
                    </span>
                  </div>
                  <Meter pct={m.pct} status={st} ariaLabel={m.label} />
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    ),
    "card-tasks": (
      <Card
        testId="fe2-home-tasks"
        header={
          <div className="fe2-home-card-head">
            <span className="fe2-stat-label">
              <Icon name="check-square" />
              タスクの内訳
            </span>
            <a href="/me/tasks" className="fe2-home-cardlink" data-testid="fe2-home-tasks-all" onClick={go("/me/tasks")}>
              詳細
              <Icon name="chevron-right" />
            </a>
          </div>
        }
      >
        {isPending ? (
          <SkeletonLoader lines={3} />
        ) : taskError ? (
          <div role="alert" data-testid="fe2-home-tasks-error" className="fe2-inline-error">
            <p>タスクを取得できませんでした。</p>
            <Button variant="secondary" size="sm" onClick={() => refetch()}>
              再試行
            </Button>
          </div>
        ) : !hasTasks || taskTotal(segments) === 0 ? (
          <p className="fe2-stat-hint">担当しているタスクはありません。</p>
        ) : (
          <SegmentBar segments={segments} testId="fe2-home-task-segbar" />
        )}
      </Card>
    ),
  };

  const appsNode = (
    <section className="fe2-home-apps" aria-label="機能へ移動">
      <h2 className="fe2-dash-section-title">アプリ</h2>
      <div className="fe2-home-apps-grid" data-testid="fe2-home-apps-grid">
        {APP_TILES.map((tile) => (
          <NavTile
            key={tile.id}
            tile={tile}
            {...(badgeFor(tile.id) !== undefined ? { badge: badgeFor(tile.id) } : {})}
            {...(onNavigate ? { onNavigate } : {})}
          />
        ))}
      </div>
    </section>
  );

  const sideNodes: Record<string, JSX.Element> = {
    "panel-events": (
      <Card
        testId="fe2-home-events"
        style={widgetStyle("panel-events")}
        header={
          <div className="fe2-home-card-head">
            <span className="fe2-stat-label">
              <Icon name="calendar" />
              直近のイベント
            </span>
            <a href="/events" className="fe2-home-cardlink" data-testid="fe2-home-events-all" onClick={go("/events")}>
              すべて見る
              <Icon name="chevron-right" />
            </a>
          </div>
        }
      >
        {isPending ? (
          <SkeletonLoader lines={3} />
        ) : eventsError ? (
          <div role="alert" data-testid="fe2-home-events-error" className="fe2-inline-error">
            <p>イベントを取得できませんでした。</p>
            <Button variant="secondary" size="sm" onClick={() => refetch()}>
              再試行
            </Button>
          </div>
        ) : events.length === 0 ? (
          <p className="fe2-stat-hint">予定されているイベントはありません。</p>
        ) : (
          <ul className="fe2-list fe2-home-events-scroll">
            {events.map((ev) => (
              <li key={ev.id} className="fe2-list-row">
                <a
                  href={`/events/${ev.id}`}
                  className="fe2-list-link"
                  data-testid={`fe2-home-event-${ev.id}`}
                  onClick={go(`/events/${ev.id}`)}
                >
                  <span className="fe2-list-dot" />
                  <span className="fe2-list-main">
                    <span className="fe2-list-title">{ev.title}</span>
                  </span>
                  <Icon name="chevron-right" />
                </a>
              </li>
            ))}
          </ul>
        )}
      </Card>
    ),
    "panel-notifications": (
      <Card
        testId="fe2-home-notifications"
        style={widgetStyle("panel-notifications")}
        header={
          <span className="fe2-stat-label">
            <Icon name="bell" />
            未読の通知
          </span>
        }
      >
        {isPending ? (
          <SkeletonLoader lines={2} />
        ) : onOpenNotifications ? (
          // Clickable "通知部分": ALWAYS opens the shared notification dialog —
          // the same modal the header bell opens. A /bff/home *partial* error on
          // the notification aggregate must NOT remove this entry point: it used
          // to fall through to an inline error card, leaving the dialog
          // unreachable from Home (bug: "未読の通知カードを押しても開かない").
          // The dialog fetches the inbox itself via useInbox, so opening it also
          // serves as the retry when the home aggregate is degraded.
          <button
            type="button"
            className="fe2-notif-open"
            data-testid="fe2-home-open-notifications"
            onClick={onOpenNotifications}
            aria-label={
              notificationsError
                ? "通知を開く（一部の通知情報を取得できませんでした）"
                : unread > 0
                  ? `通知を開く（未読 ${unread} 件）`
                  : "通知を開く"
            }
          >
            {notificationsError ? (
              <span data-testid="fe2-home-notifications-error" className="fe2-stat-hint">
                通知情報の一部を取得できませんでした。開いて再読み込みできます。
              </span>
            ) : unread > 0 ? (
              <span className="fe2-notice-row">
                <Badge tone="info">未読</Badge>
                <span data-testid="fe2-home-unread-count">未読 {unread} 件</span>
              </span>
            ) : (
              <span data-testid="fe2-home-unread-empty" className="fe2-stat-hint">
                未読の通知はありません。
              </span>
            )}
          </button>
        ) : notificationsError ? (
          // Fallback only when there is NO dialog entry point wired (e.g. a
          // context that does not pass onOpenNotifications): inline retry card.
          <div role="alert" data-testid="fe2-home-notifications-error" className="fe2-inline-error">
            <p>通知を取得できませんでした。</p>
            <Button variant="secondary" size="sm" onClick={() => refetch()}>
              再試行
            </Button>
          </div>
        ) : unread > 0 ? (
          <div className="fe2-notice-row">
            <Badge tone="info">未読</Badge>
            <span data-testid="fe2-home-unread-count">未読 {unread} 件</span>
          </div>
        ) : (
          <p data-testid="fe2-home-unread-empty" className="fe2-stat-hint">
            未読の通知はありません。
          </p>
        )}
      </Card>
    ),
    ...Object.fromEntries(
      homeWidgets.map((w) => [`widget-${w.id}`, renderHomeWidget(w.id, w.title, w.Body, widgetStyle(`widget-${w.id}`))]),
    ),
  };

  const editingDisabled = isPending;

  return (
    <main ref={rootRef} data-testid="fe2-home" className="fe2-home fe2-dashboard" data-density={density} data-editing={isEditing}>
      <PageHeader
        testId="fe2-home-header"
        title="ダッシュボード"
        description="DevHub 運営の概況 — 主要指標と各機能へのショートカット"
        actions={
          <div className="fe2-home-edit-toolbar">
            {isEditing ? (
              <>
                <SegmentedControl<HomeDensity>
                  caption="表示密度"
                  captionTestId="fe2-home-density-caption"
                  options={DENSITY_OPTIONS.map((o) => ({ value: o.value, label: o.label, testId: `fe2-home-density-${o.value}` }))}
                  value={density}
                  onChange={setHomeDensity}
                  aria-label="表示密度"
                />
                <Button variant="ghost" size="sm" onClick={resetHomeLayout} testId="fe2-home-edit-reset">
                  <Icon name="refresh" />
                  既定に戻す
                </Button>
              </>
            ) : null}
            <Button
              variant={isEditing ? "primary" : "secondary"}
              size="sm"
              onClick={() => setIsEditing((v) => !v)}
              disabled={editingDisabled}
              testId="fe2-home-edit-toggle"
            >
              <Icon name={isEditing ? "check" : "edit"} />
              {isEditing ? "完了" : "編集"}
            </Button>
          </div>
        }
      />

      {isEditing ? (
        <p className="fe2-home-edit-hint" data-testid="fe2-home-edit-hint">
          ウィジェットをドラッグ（またはハンドルを選んで矢印キー）で並べ替えられます。「非表示」で自分のダッシュボードに合わせられます。
        </p>
      ) : null}

      {/* ── KPI row: at-a-glance overview ─────────────────────────────────────── */}
      {isPending ? (
        <section className="fe2-kpi-row" aria-label="概況の主要指標" data-testid="fe2-home-kpis">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="fe2-kpi fe2-kpi-skeleton" data-testid="fe2-home-kpi-skeleton">
              <SkeletonLoader lines={3} />
            </div>
          ))}
        </section>
      ) : (
        <HomeEditableRegion
          region="kpi"
          catalog={catalog}
          nodes={kpiNodes}
          isEditing={isEditing}
          className="fe2-kpi-row"
          regionLabel="主要指標（KPI）"
          testId="fe2-home-kpis"
          containerAriaLabel="概況の主要指標"
        />
      )}

      <div className="fe2-dash-body">
        {/* left column: graph cards + app launchpad — each orderable / hideable */}
        <div className="fe2-dash-main">
          <HomeEditableRegion
            region="cards"
            catalog={catalog}
            nodes={cardNodes}
            isEditing={isEditing}
            className="fe2-dash-cards"
            regionLabel="グラフカード"
          />

          <HomeEditableRegion
            region="apps"
            catalog={catalog}
            nodes={{ "section-apps": appsNode }}
            isEditing={isEditing}
            className="fe2-dash-apps-region"
            regionLabel="アプリランチャー"
          />
        </div>

        {/* right rail: live BFF panels + feature widgets — orderable / hideable */}
        <HomeEditableRegion
          region="side"
          catalog={catalog}
          nodes={sideNodes}
          isEditing={isEditing}
          className="fe2-home-side"
          regionLabel="サイドパネル"
        />
      </div>
    </main>
  );
}
