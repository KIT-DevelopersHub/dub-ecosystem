// Home / dashboard (design 2-1). FE2 owns the frame; BFF-data-driven cards
// (upcoming events, unread notifications) are rendered by the shell from the
// single /bff/home aggregate, and FE3–FE7 may each contribute one feature body
// via their FeatureModule.homeWidget (registry.homeWidgets). Partial upstream
// failure is surfaced per-frame via useBffHome().errorFor — no global toast.
import { Badge, Button, Card, Icon, PageHeader, SkeletonLoader } from "@dub/ui";
import type { ApiClient } from "../../lib/api-client.tsx";
import type { HomeWidget } from "../../modules/types.tsx";
import { useBffHome } from "../../bff/useBffHome.tsx";
import { renderHomeWidget } from "./HomeWidgetFrame.tsx";

function Stat({
  label,
  icon,
  value,
  hint,
  testId,
}: {
  label: string;
  icon: Parameters<typeof Icon>[0]["name"];
  value: string;
  hint: string;
  testId?: string;
}): JSX.Element {
  return (
    <div className="fe2-stat" {...(testId ? { "data-testid": testId } : {})}>
      <span className="fe2-stat-label">
        <Icon name={icon} />
        {label}
      </span>
      <span className="fe2-stat-value">{value}</span>
      <span className="fe2-stat-hint">{hint}</span>
    </div>
  );
}

export function HomeScreen({
  api,
  homeWidgets = [],
}: {
  api: ApiClient;
  homeWidgets?: HomeWidget[];
}): JSX.Element {
  const { data, isPending, errorFor, refetch } = useBffHome(api);
  const eventsError = errorFor("event-service");
  // FE5's upstream reports as "notification" in the BFF aggregate (matches the
  // useBffHome contract test fixture).
  const notificationsError = errorFor("notification");

  const events = data?.upcomingEvents ?? [];
  const unread = data?.unreadCount ?? 0;

  return (
    <main data-testid="fe2-home" className="fe2-page">
      <PageHeader
        testId="fe2-home-header"
        title="ホーム"
        description="DevHub 運営コンソールの概要"
      />

      <div className="fe2-stat-grid">
        {isPending ? (
          <>
            <div className="fe2-stat">
              <SkeletonLoader lines={2} />
            </div>
            <div className="fe2-stat">
              <SkeletonLoader lines={2} />
            </div>
          </>
        ) : (
          <>
            <Stat
              label="直近のイベント"
              icon="calendar"
              value={eventsError ? "—" : String(events.length)}
              hint={eventsError ? "取得できませんでした" : "予定されているイベント"}
            />
            <Stat
              label="未読の通知"
              icon="bell"
              value={notificationsError ? "—" : String(unread)}
              hint={notificationsError ? "取得できませんでした" : unread > 0 ? "確認が必要です" : "すべて既読です"}
            />
          </>
        )}
      </div>

      <div className="fe2-grid-2">
        <Card
          testId="fe2-home-events"
          header={
            <span className="fe2-stat-label">
              <Icon name="calendar" />
              直近のイベント
            </span>
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
            <ul className="fe2-list">
              {events.map((ev) => (
                <li key={ev.id} className="fe2-list-row">
                  <span className="fe2-list-dot" />
                  <span className="fe2-list-main">
                    <span className="fe2-list-title">{ev.title}</span>
                  </span>
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
          ) : notificationsError ? (
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
      </div>

      {homeWidgets.length > 0 ? (
        <div className="fe2-grid-2">{homeWidgets.map((w) => renderHomeWidget(w.id, w.title, w.Body))}</div>
      ) : null}
    </main>
  );
}
