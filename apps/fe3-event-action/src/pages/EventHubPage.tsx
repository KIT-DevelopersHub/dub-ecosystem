// EventHubPage — the Event app's home. The current event is picked from the shell's
// always-visible global イベント switcher (GCP-style header widget); the body shows
// that event as the primary subject: EventHubOverview (4 facts / apps / actions, #879),
// then the free layout, the AI digest and the free-form detail store.
// NOTE: this page does NOT render its own event switcher — the shell header already
// carries the global one, so an in-body switcher would double the header (判断36⑤).
// The standalone dev harness (main.tsx) supplies EventAppHeader itself.
import { useMemo, useState } from "react";
import { EmptyState, SkeletonLoader } from "@dub/ui";
import { EventContextProvider, useEventContext } from "../context/EventContext";
import { EventDetailsPanel } from "../components/EventDetailsPanel";
import { EventEditForm } from "../components/EventEditForm";
import { sampleEventDoc } from "../blockeditor";
import { EventPageLayout } from "../components/EventPageLayout";
import { EventAiDigestPanel } from "../components/EventAiDigestPanel";
import { EventHubOverview } from "../components/EventHubOverview";
import { useCurrentEventId } from "../lib/currentEvent";
import styles from "../components/components.module.css";

function HubBody({ eventId }: { eventId: string }) {
  const { event: ev, permissions } = useEventContext();
  // Title / schedule / description edit happens IN PLACE here, same pattern as
  // EventDetailsPanel below (edit toggle, no route change) — a dedicated
  // settings-page round trip for these fields used to strand the user on a
  // separate screen with a "戻る" that didn't return to this hub (判断: fe3 nav fix).
  const [editing, setEditing] = useState(false);

  // "イベント編集" — the free block-editor page mode (しおり UI reused). Distinct
  // from the structured hero/detail edits above: this is a widget canvas the
  // organiser lays out freely. It coexists with the structured event data — the
  // free layout renders above the fixed イベント詳細 panel, never replacing it.
  const [pageEditing, setPageEditing] = useState(false);
  const seed = useMemo(
    () => sampleEventDoc(ev.title, ev.description ?? undefined),
    [ev.title, ev.description],
  );

  return (
    <div className={styles.page}>
      {editing ? (
        <div className={styles.hero} data-testid="fe3-hub-edit-form">
          <EventEditForm
            event={ev}
            canWrite={permissions.write}
            onCancel={() => setEditing(false)}
            onSaved={() => setEditing(false)}
          />
        </div>
      ) : (
        <EventHubOverview
          event={ev}
          canWrite={permissions.write}
          pageEditing={pageEditing}
          onEditInfo={() => setEditing(true)}
          onTogglePageEdit={setPageEditing}
        />
      )}

      {pageEditing ? (
        // Page-edit mode: the event screen becomes a widget canvas. The
        // structured イベント詳細 panel is hidden to give a clean editing surface;
        // it returns unchanged on 編集を終了 (the two layers never overwrite one
        // another — the block layout is a separate free layer).
        <section data-testid="fe3-hub-editor">
          <div className={styles.calloutInfo} data-testid="fe3-hub-edit-banner">
            イベント編集モード — 右のパレットからブロックを追加し、ダブルクリックで中身を編集、ドラッグで並べ替え・幅変更ができます。変更は自動保存されます（メンバー全員に共有）。
          </div>
          <EventPageLayout eventId={eventId} mode="edit" canWrite seed={seed} />
        </section>
      ) : (
        <>
          {/* View mode: the organiser's free block layout (saved to D1, shared across
              viewers) renders as page content above the structured detail panel. The
              wrapper self-hides when no layout has been saved yet. */}
          <section data-testid="fe3-hub-layout">
            <EventPageLayout eventId={eventId} mode="view" canWrite={false} />
          </section>
          <EventAiDigestPanel eventId={eventId} canRun={permissions.admin} />
          <EventDetailsPanel eventId={eventId} canWrite={permissions.write} />
        </>
      )}
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
