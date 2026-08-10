// Home / dashboard (design 2-1). FE2 owns the frame; BFF-data-driven cards
// (upcoming events, unread notifications) are rendered by the shell from the
// single /bff/home aggregate, and FE3–FE7 may each contribute one feature body
// via their FeatureModule.homeWidget (registry.homeWidgets). Partial upstream
// failure is surfaced per-frame via useBffHome().errorFor — no global toast.
import type { ApiClient } from "../../lib/api-client.tsx";
import type { HomeWidget } from "../../modules/types.tsx";
import { useBffHome } from "../../bff/useBffHome.tsx";
import { renderHomeWidget } from "./HomeWidgetFrame.tsx";

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

  return (
    <main data-testid="fe2-home">
      <h1>ホーム</h1>

      <section data-widget="upcoming-events">
        <h2>直近のイベント</h2>
        {isPending ? (
          <p>読み込み中…</p>
        ) : eventsError ? (
          <div role="alert" data-testid="fe2-home-events-error">
            <p>イベントを取得できませんでした。</p>
            <button type="button" onClick={() => refetch()}>
              再試行
            </button>
          </div>
        ) : (
          <ul>
            {(data?.upcomingEvents ?? []).map((ev) => (
              <li key={ev.id}>{ev.title}</li>
            ))}
          </ul>
        )}
      </section>

      <section data-widget="notifications">
        <h2>未読の通知</h2>
        {isPending ? (
          <p>読み込み中…</p>
        ) : notificationsError ? (
          <div role="alert" data-testid="fe2-home-notifications-error">
            <p>通知を取得できませんでした。</p>
            <button type="button" onClick={() => refetch()}>
              再試行
            </button>
          </div>
        ) : (data?.unreadCount ?? 0) > 0 ? (
          <p data-testid="fe2-home-unread-count">未読 {data?.unreadCount} 件</p>
        ) : (
          <p data-testid="fe2-home-unread-empty">未読の通知はありません。</p>
        )}
      </section>

      {homeWidgets.map((w) => renderHomeWidget(w.id, w.title, w.Body))}
    </main>
  );
}
