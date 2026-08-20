// ガントチャート landing (reached from the 9-dot AppLauncher). The task Gantt is
// event-scoped (`/events/:eventId/tasks/gantt`), so a top-level launcher tile
// can't point at one Gantt directly; this screen lists the user's events (from the
// same /bff/home aggregate the Home screen uses) and opens the chosen event's
// Gantt. No new backend — reuses useBffHome + @dub/ui.
import { useEffect, useRef } from "react";
import { Button, Card, Icon, PageHeader, SkeletonLoader } from "@dub/ui";
import { useNavigate } from "@tanstack/react-router";
import { useBffHome } from "../../bff/useBffHome.tsx";
import { useGanttApi } from "./GanttProvider.tsx";
import { loadSelectedEvent } from "./selectedEventStore.ts";

export function GanttLandingScreen(): JSX.Element {
  const api = useGanttApi();
  const navigate = useNavigate();
  const { data, isPending, errorFor, refetch } = useBffHome(api);
  const eventsError = errorFor("event-service");
  const events = data?.upcomingEvents ?? [];

  // Resume the last-selected event once (first visit / no pick still shows the
  // picker below). Guarded so it only redirects a single time per mount. From the
  // resumed gantt the global header イベント switcher handles further switching.
  const redirected = useRef(false);
  useEffect(() => {
    if (redirected.current) return;
    const last = loadSelectedEvent();
    if (last) {
      redirected.current = true;
      void navigate({ to: `/events/${last}/tasks/gantt`, replace: true });
    }
  }, [navigate]);

  return (
    <main data-testid="fe2-gantt-landing" className="fe2-page">
      <PageHeader
        testId="fe2-gantt-header"
        title="ガントチャート"
        description="イベントを選ぶと、そのタスク・ガントを開きます"
      />

      <Card
        testId="fe2-gantt-events"
        header={
          <span className="fe2-stat-label">
            <Icon name="clock" />
            イベントのガント
          </span>
        }
      >
        {isPending ? (
          <SkeletonLoader lines={3} />
        ) : eventsError ? (
          <div role="alert" data-testid="fe2-gantt-error" className="fe2-inline-error">
            <p>イベントを取得できませんでした。</p>
            <Button variant="secondary" size="sm" onClick={() => refetch()}>
              再試行
            </Button>
          </div>
        ) : events.length === 0 ? (
          <div className="fe2-notice-row">
            <p className="fe2-stat-hint">表示できるイベントがありません。</p>
            <Button
              variant="secondary"
              size="sm"
              testId="fe2-gantt-goto-events"
              onClick={() => void navigate({ to: "/events" })}
            >
              イベント一覧へ
            </Button>
          </div>
        ) : (
          <ul className="fe2-list">
            {events.map((ev) => (
              <li key={ev.id} className="fe2-list-row">
                <Button
                  variant="ghost"
                  iconLeft={<Icon name="clock" />}
                  testId={`fe2-gantt-open-${ev.id}`}
                  onClick={() => void navigate({ to: `/events/${ev.id}/tasks/gantt` })}
                >
                  {ev.title} のガントを開く
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}

export default GanttLandingScreen;
