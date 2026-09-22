import { useMemo, useState } from "react";
import { Button, Icon } from "@dub/ui";
import { useNavigation, useRouteParams } from "../contracts/navigation";
import { EventContextProvider, useEventContext } from "../context/EventContext";
import { PhaseBadge } from "../components/PhaseBadge";
import { PhaseTransitionControl } from "../components/PhaseTransitionControl";
import { ActionBoard } from "../components/ActionBoard";
import { BlockEditor, hasDoc, sampleEventDoc } from "../blockeditor";
import { eventRoutes, chatHref } from "../lib/routes";
import styles from "../components/components.module.css";

function EventDetailInner({ eventId }: { eventId: string }) {
  const nav = useNavigation();
  const { event: ev, permissions } = useEventContext();

  // Inline page-edit mode. The free block layer coexists with the structured
  // event data (title / phase / actions) — it never replaces it. Editing is a
  // separate mode toggled by "イベント編集" so the normal read view stays clean.
  const [editing, setEditing] = useState(false);
  // Whether a saved block layout already exists for this event (view mode only
  // renders the read-only layer when there is something to show).
  const hasLayout = useMemo(() => hasDoc(eventId), [eventId, editing]);
  const seed = useMemo(
    () => sampleEventDoc(ev.title, ev.description ?? undefined),
    [ev.title, ev.description],
  );

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
          {permissions.write ? (
            editing ? (
              <Button
                iconLeft={<Icon name="check" />}
                variant="primary"
                onClick={() => setEditing(false)}
                testId="fe3-detail-edit-done"
              >
                編集を終了
              </Button>
            ) : (
              <Button
                iconLeft={<Icon name="edit" />}
                variant="primary"
                onClick={() => setEditing(true)}
                testId="fe3-detail-edit-page"
              >
                イベント編集
              </Button>
            )
          ) : null}
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

      {editing ? (
        // Edit mode: the whole page content becomes a widget canvas. Structured
        // event data above stays intact; only this free layer is being edited.
        <section data-testid="fe3-detail-editor">
          <div className={styles.calloutInfo} data-testid="fe3-detail-edit-banner">
            イベント編集モード — 右のパレットからブロックを追加し、ダブルクリックで中身を編集、ドラッグで並べ替え・幅変更ができます。変更は自動保存されます。
          </div>
          <BlockEditor storageKey={eventId} canWrite seed={seed} />
        </section>
      ) : (
        <>
          {hasLayout ? (
            // View mode: render the saved block layout read-only as page content.
            <section data-testid="fe3-detail-layout">
              <BlockEditor storageKey={eventId} canWrite={false} />
            </section>
          ) : null}

          <h2 className={styles.sectionTitle}>フェーズ</h2>
          <PhaseTransitionControl
            event={ev}
            permissions={{ write: permissions.write, admin: permissions.admin }}
          />

          <h2 className={styles.sectionTitle}>アクション</h2>
          <ActionBoard
            eventId={eventId}
            canWrite={permissions.write}
            onOpenAction={(actionId) => nav.navigate(eventRoutes.action(eventId, actionId))}
          />
        </>
      )}
    </div>
  );
}

export function EventDetailPage() {
  const params = useRouteParams();
  const eventId = params.eventId ?? "";
  return (
    <EventContextProvider
      eventId={eventId}
      fallback={<div className={styles.emptyState}>読み込み中…</div>}
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
