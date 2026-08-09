// Home / dashboard skeleton (design 2-1). FE2 owns the frame only; widget bodies
// are supplied by FE3-FE7. Partial upstream failure is surfaced per-frame via
// useBffHome().errorFor — the shell shows no toast for partials.
import type { ApiClient } from "../../lib/api-client.tsx";
import { useBffHome } from "../../bff/useBffHome.tsx";

export function HomeScreen({ api }: { api: ApiClient }): JSX.Element {
  const { data, isPending, errorFor, refetch } = useBffHome(api);
  const eventsError = errorFor("event-service");

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
    </main>
  );
}
