// Home / dashboard (design 2-1, revamp). FE2 owns the frame. The screen is a
// single, no-scroll launchpad: a grid of clickable app tiles (each navigates to
// a feature route) on the left, and the two BFF-data-driven live panels
// (upcoming events, unread notifications) on the right. The tiles for イベント /
// 通知 carry live counts from the same /bff/home aggregate, so the numbers that
// used to sit in a separate KPI row now live on the very tile that navigates
// there — no duplicated element. Partial upstream failure is surfaced per-frame
// via useBffHome().errorFor — no global toast. FE3–FE7 may still contribute a
// homeWidget via registry.homeWidgets; each renders in its own error boundary.
import { Badge, Button, Card, Icon, PageHeader, SkeletonLoader } from "@dub/ui";
import type { ApiClient } from "../../lib/api-client.tsx";
import type { HomeWidget } from "../../modules/types.tsx";
import { useBffHome } from "../../bff/useBffHome.tsx";
import { renderHomeWidget } from "./HomeWidgetFrame.tsx";

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
      <span className="fe2-home-tile-main">
        <span className="fe2-home-tile-label">{tile.label}</span>
        <span className="fe2-home-tile-desc">{tile.desc}</span>
      </span>
      {hasBadge ? (
        <span className="fe2-home-tile-badge" data-testid={`fe2-home-tile-${tile.id}-badge`}>
          {badge}
        </span>
      ) : null}
      <span className="fe2-home-tile-arrow" aria-hidden="true">
        <Icon name="chevron-right" />
      </span>
    </a>
  );
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
  // FE5's upstream reports as "notification" in the BFF aggregate (matches the
  // useBffHome contract test fixture).
  const notificationsError = errorFor("notification");

  const events = data?.upcomingEvents ?? [];
  const unread = data?.unreadCount ?? 0;

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

  return (
    <main data-testid="fe2-home" className="fe2-page fe2-home">
      <PageHeader
        testId="fe2-home-header"
        title="ホーム"
        description="DevHub 運営コンソール — 各機能へのショートカットと最新の状況"
      />

      <div className="fe2-home-body">
        <section className="fe2-home-apps" aria-label="機能へ移動">
          <div className="fe2-home-apps-grid">
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

        <aside className="fe2-home-side">
          <Card
            testId="fe2-home-events"
            header={
              <div className="fe2-home-card-head">
                <span className="fe2-stat-label">
                  <Icon name="calendar" />
                  直近のイベント
                </span>
                <a
                  href="/events"
                  className="fe2-home-cardlink"
                  data-testid="fe2-home-events-all"
                  onClick={go("/events")}
                >
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

          <Card
            testId="fe2-home-notifications"
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

          {homeWidgets.length > 0
            ? homeWidgets.map((w) => renderHomeWidget(w.id, w.title, w.Body))
            : null}
        </aside>
      </div>
    </main>
  );
}
