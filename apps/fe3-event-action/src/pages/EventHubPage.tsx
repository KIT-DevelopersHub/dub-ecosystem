// EventHubPage — the Event app's home. The current event is picked from the shell's
// always-visible global イベント switcher (GCP-style header widget); the body shows
// that event as the primary subject: a hero (title / phase / schedule / description)
// plus the free-form detail store where anything about the event can be kept.
// NOTE: this page does NOT render its own event switcher — the shell header already
// carries the global one, so an in-body switcher would double the header (判断36⑤).
// The standalone dev harness (main.tsx) supplies EventAppHeader itself.
import { Button, Icon, EmptyState, SkeletonLoader } from "@dub/ui";
import { EventContextProvider, useEventContext } from "../context/EventContext";
import { EventDetailsPanel } from "../components/EventDetailsPanel";
import { PhaseBadge } from "../components/PhaseBadge";
import { useCurrentEventId } from "../lib/currentEvent";
import { useNavigation } from "../contracts/navigation";
import { eventRoutes, chatHref } from "../lib/routes";
import styles from "../components/components.module.css";

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" });
}

function scheduleText(startsAt: string | null, endsAt: string | null): string | null {
  const s = formatDate(startsAt);
  const e = formatDate(endsAt);
  if (s && e && s !== e) return `${s} 〜 ${e}`;
  return s ?? e;
}

function HubBody({ eventId }: { eventId: string }) {
  const { event: ev, permissions } = useEventContext();
  const nav = useNavigation();
  const schedule = scheduleText(ev.startsAt, ev.endsAt);

  return (
    <div className={styles.page}>
      <div className={styles.hero} data-testid="fe3-hub-hero">
        <div className={styles.heroTop}>
          <div>
            <div className={styles.heroTitle}>{ev.title}</div>
            <div className={styles.heroMeta}>
              <span className={styles.heroMetaItem}>
                <PhaseBadge phase={ev.phase} testId="fe3-hub-phase" />
              </span>
              {schedule ? (
                <span className={styles.heroMetaItem}>
                  <Icon name="calendar" /> {schedule}
                </span>
              ) : null}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button
              iconLeft={<Icon name="list" />}
              variant="secondary"
              onClick={() => nav.navigate(eventRoutes.detail(eventId))}
              testId="fe3-hub-open-actions"
            >
              アクション
            </Button>
            <Button
              iconLeft={<Icon name="check-square" />}
              variant="secondary"
              onClick={() => nav.navigate(eventRoutes.tasks(eventId))}
              testId="fe3-hub-open-tasks"
            >
              タスク・ガント
            </Button>
            <Button
              iconLeft={<Icon name="message-circle" />}
              variant="secondary"
              onClick={() => nav.navigate(chatHref(eventId))}
              testId="fe3-hub-open-chat"
            >
              チャット
            </Button>
          </div>
        </div>
        {ev.description ? <p className={styles.heroDesc}>{ev.description}</p> : null}
      </div>

      <EventDetailsPanel eventId={eventId} canWrite={permissions.write} />
    </div>
  );
}

export function EventHubPage() {
  const eventId = useCurrentEventId();

  return (
    <div data-testid="fe3-hub">
      {eventId ? (
        <EventContextProvider
          eventId={eventId}
          fallback={
            <div className={styles.page}>
              <SkeletonLoader lines={6} />
            </div>
          }
          notFound={
            <div className={styles.page}>
              <div className={styles.notFound} data-testid="fe3-hub-notfound">
                選択中のイベントが見つかりません。ヘッダーから別のイベントを選んでください。
              </div>
            </div>
          }
        >
          <HubBody eventId={eventId} />
        </EventContextProvider>
      ) : (
        <div className={styles.page}>
          <EmptyState
            icon="calendar"
            title="イベントを選択してください"
            description="ヘッダーのプルダウンからイベントを選ぶと、詳細情報がここに表示されます。"
            testId="fe3-hub-empty"
          />
        </div>
      )}
    </div>
  );
}
