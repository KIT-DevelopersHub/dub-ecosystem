// EventHubPage — the Event app's home. The current event is picked from the shell's
// always-visible global イベント switcher (GCP-style header widget); the body shows
// that event as the primary subject: a hero (title / phase / schedule / description)
// plus the free-form detail store where anything about the event can be kept.
// NOTE: this page does NOT render its own event switcher — the shell header already
// carries the global one, so an in-body switcher would double the header (判断36⑤).
// The standalone dev harness (main.tsx) supplies EventAppHeader itself.
import { useMemo, useState } from "react";
import { Button, Icon, EmptyState, SkeletonLoader } from "@dub/ui";
import { EventContextProvider, useEventContext } from "../context/EventContext";
import { EventDetailsPanel } from "../components/EventDetailsPanel";
import { EventEditForm } from "../components/EventEditForm";
import { PhaseBadge } from "../components/PhaseBadge";
import { BlockEditor, hasDoc, sampleEventDoc } from "../blockeditor";
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
  const hasLayout = useMemo(() => hasDoc(eventId), [eventId, pageEditing]);
  const seed = useMemo(
    () => sampleEventDoc(ev.title, ev.description ?? undefined),
    [ev.title, ev.description],
  );

  return (
    <div className={styles.page}>
      <div className={styles.hero} data-testid="fe3-hub-hero">
        {editing ? (
          <div data-testid="fe3-hub-edit-form">
            <EventEditForm
              event={ev}
              canWrite={permissions.write}
              onCancel={() => setEditing(false)}
              onSaved={() => setEditing(false)}
            />
          </div>
        ) : (
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
              {permissions.write ? (
                pageEditing ? (
                  <Button
                    iconLeft={<Icon name="check" />}
                    variant="primary"
                    onClick={() => setPageEditing(false)}
                    testId="fe3-hub-edit-page-done"
                  >
                    編集を終了
                  </Button>
                ) : (
                  <Button
                    iconLeft={<Icon name="edit" />}
                    variant="primary"
                    onClick={() => setPageEditing(true)}
                    testId="fe3-hub-edit-page"
                  >
                    イベント編集
                  </Button>
                )
              ) : null}
              {permissions.write && !pageEditing ? (
                <Button
                  iconLeft={<Icon name="edit" />}
                  variant="secondary"
                  onClick={() => setEditing(true)}
                  testId="fe3-hub-edit-event"
                >
                  基本情報
                </Button>
              ) : null}
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
        )}
        {!editing && ev.description ? <p className={styles.heroDesc}>{ev.description}</p> : null}
      </div>

      {pageEditing ? (
        // Page-edit mode: the event screen becomes a widget canvas. The
        // structured イベント詳細 panel is hidden to give a clean editing surface;
        // it returns unchanged on 編集を終了 (the two layers never overwrite one
        // another — the block layout is a separate free layer).
        <section data-testid="fe3-hub-editor">
          <div className={styles.calloutInfo} data-testid="fe3-hub-edit-banner">
            イベント編集モード — 右のパレットからブロックを追加し、ダブルクリックで中身を編集、ドラッグで並べ替え・幅変更ができます。変更は自動保存されます。
          </div>
          <BlockEditor storageKey={eventId} canWrite seed={seed} />
        </section>
      ) : (
        <>
          {hasLayout ? (
            // View mode: the organiser's free block layout renders as page content
            // above the structured detail panel.
            <section data-testid="fe3-hub-layout">
              <BlockEditor storageKey={eventId} canWrite={false} />
            </section>
          ) : null}
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
