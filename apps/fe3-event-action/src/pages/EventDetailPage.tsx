import { Button, Icon, SkeletonLoader } from "@dub/ui";
import { useNavigation, useRouteParams } from "../contracts/navigation";
import { EventContextProvider, useEventContext } from "../context/EventContext";
import { PhaseBadge } from "../components/PhaseBadge";
import { PhaseTransitionControl } from "../components/PhaseTransitionControl";
import { ActionBoard } from "../components/ActionBoard";
import { eventRoutes, chatHref } from "../lib/routes";
import styles from "../components/components.module.css";

function EventDetailInner({ eventId }: { eventId: string }) {
  const nav = useNavigation();
  const { event: ev, permissions } = useEventContext();

  return (
    <div className={styles.page} data-testid="fe3-detail">
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>{ev.title}</h1>
          <div className={styles.cardMeta}>
            <PhaseBadge phase={ev.phase} testId="fe3-detail-phase-badge" />
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Button
            iconLeft={<Icon name="check-square" />}
            variant="secondary"
            onClick={() => nav.navigate(eventRoutes.tasks(eventId))}
            testId="fe3-detail-open-tasks"
          >
            タスク・ガント
          </Button>
          <Button
            iconLeft={<Icon name="message-circle" />}
            variant="secondary"
            onClick={() => nav.navigate(chatHref(eventId))}
            testId="fe3-detail-open-chat"
          >
            チャットを開く
          </Button>
          {permissions.write ? (
            <Button
              iconLeft={<Icon name="settings" />}
              variant="ghost"
              onClick={() => nav.navigate(eventRoutes.settings(eventId))}
              testId="fe3-detail-settings"
            >
              設定
            </Button>
          ) : null}
        </div>
      </div>

      {ev.description ? <p>{ev.description}</p> : null}

      <h2 className={styles.sectionTitle}>フェーズ</h2>
      <PhaseTransitionControl event={ev} permissions={{ write: permissions.write, admin: permissions.admin }} />

      <h2 className={styles.sectionTitle}>アクション</h2>
      <ActionBoard
        eventId={eventId}
        canWrite={permissions.write}
        onOpenAction={(actionId) => nav.navigate(eventRoutes.action(eventId, actionId))}
      />
    </div>
  );
}

export function EventDetailPage() {
  const params = useRouteParams();
  const eventId = params.eventId ?? "";
  return (
    <EventContextProvider
      eventId={eventId}
      fallback={
        <div className={styles.page} data-testid="fe3-event-detail-loading">
          <SkeletonLoader lines={6} />
        </div>
      }
      notFound={
        <div className={styles.notFound} data-testid="fe3-detail-notfound">
          イベントが見つかりません。
        </div>
      }
    >
      <EventDetailInner eventId={eventId} />
    </EventContextProvider>
  );
}
