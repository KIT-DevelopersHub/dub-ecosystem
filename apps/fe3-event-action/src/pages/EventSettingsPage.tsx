import { useState } from "react";
import { Button, SkeletonLoader } from "@dub/ui";
import { useNavigation, useRouteParams } from "../contracts/navigation";
import { EventContextProvider, useEventContext } from "../context/EventContext";
import { EventEditForm } from "../components/EventEditForm";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useArchiveEvent } from "../hooks/useEventMutations";
import { eventRoutes } from "../lib/routes";
import styles from "../components/components.module.css";

function EventSettingsInner({ eventId }: { eventId: string }) {
  const nav = useNavigation();
  const { event: ev, permissions } = useEventContext();
  const archive = useArchiveEvent(eventId);
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <div className={styles.page} data-testid="fe3-settings">
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>イベント設定</h1>
        <Button variant="ghost" onClick={() => nav.navigate(eventRoutes.detail(eventId))}>
          ← 詳細へ戻る
        </Button>
      </div>

      <EventEditForm event={ev} canWrite={permissions.write} />

      <h2 className={styles.sectionTitle}>危険な操作</h2>
      <p className={styles.kvLabel}>アーカイブすると一覧から隠れ、編集できなくなります（論理削除）。</p>
      <Button
        variant="danger"
        disabled={!permissions.admin || ev.archivedAt !== null}
        onClick={() => setConfirmOpen(true)}
        testId="fe3-settings-archive"
      >
        イベントをアーカイブ
      </Button>

      <ConfirmDialog
        open={confirmOpen}
        title="イベントをアーカイブしますか？"
        message="この操作は一覧から隠し、編集を不可にします。"
        confirmLabel="アーカイブする"
        onConfirm={() => {
          archive.mutate(undefined, { onSuccess: () => nav.navigate(eventRoutes.list()) });
          setConfirmOpen(false);
        }}
        onCancel={() => setConfirmOpen(false)}
        testId="fe3-settings-archive-confirm"
      />
    </div>
  );
}

export function EventSettingsPage() {
  const params = useRouteParams();
  const eventId = params.eventId ?? "";
  return (
    <EventContextProvider
      eventId={eventId}
      fallback={
        <div className={styles.page} data-testid="fe3-event-settings-loading">
          <SkeletonLoader lines={6} />
        </div>
      }
      notFound={
        <div className={styles.notFound} data-testid="fe3-settings-notfound">
          イベントが見つかりません。
        </div>
      }
    >
      <EventSettingsInner eventId={eventId} />
    </EventContextProvider>
  );
}
