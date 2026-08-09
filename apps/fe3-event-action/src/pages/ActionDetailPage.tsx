import { useCallback } from "react";
import { Button, Icon } from "../contracts/fe1";
import { useNavigation, useRouteParams } from "../contracts/navigation";
import { EventContextProvider, useEventContext } from "../context/EventContext";
import { useActionRegistry } from "../context/ApiContext";
import { useActionQuery } from "../hooks/useEventQueries";
import { useUpdateAction } from "../hooks/useEventMutations";
import { eventRoutes } from "../lib/routes";
import styles from "../components/components.module.css";

function ActionDetailInner({ eventId, actionId }: { eventId: string; actionId: string }) {
  const nav = useNavigation();
  const { event: ev, permissions } = useEventContext();
  const registry = useActionRegistry();
  const { data: action, isLoading, isError } = useActionQuery(actionId);
  const update = useUpdateAction(eventId);

  const onPayloadChange = useCallback(
    async (patch: Record<string, unknown>) => {
      if (!action) return;
      await update.mutateAsync({ actionId: action.id, req: { version: action.version, payload: patch } });
    },
    [action, update],
  );

  if (isLoading) return <div className={styles.emptyState}>読み込み中…</div>;
  if (isError || !action) {
    return (
      <div className={styles.notFound} data-testid="fe3-action-notfound">
        アクションが見つかりません。
        <div>
          <Button variant="ghost" onClick={() => nav.navigate(eventRoutes.detail(eventId))}>
            イベントへ戻る
          </Button>
        </div>
      </div>
    );
  }

  const plugin = registry.resolve(action.kind);
  const Panel = plugin.Panel;

  return (
    <div className={styles.page} data-testid="fe3-action-detail">
      <div className={styles.pageHeader}>
        <div>
          <button
            type="button"
            className={styles.link}
            style={{ background: "none", border: "none", cursor: "pointer" }}
            onClick={() => nav.navigate(eventRoutes.detail(eventId))}
          >
            ← {ev.title}
          </button>
          <h1 className={styles.pageTitle}>
            <Icon name={registry.has(action.kind) ? plugin.icon : "list"} /> {action.title}
          </h1>
          <span className={styles.badge}>{action.kind}</span>
        </div>
      </div>

      <Panel event={ev} action={action} canWrite={permissions.write} onPayloadChange={onPayloadChange} />
    </div>
  );
}

export function ActionDetailPage() {
  const params = useRouteParams();
  const eventId = params.eventId ?? "";
  const actionId = params.actionId ?? "";
  return (
    <EventContextProvider
      eventId={eventId}
      fallback={<div className={styles.emptyState}>読み込み中…</div>}
      notFound={
        <div className={styles.notFound} data-testid="fe3-action-notfound">
          イベントが見つかりません。
        </div>
      }
    >
      <ActionDetailInner eventId={eventId} actionId={actionId} />
    </EventContextProvider>
  );
}
