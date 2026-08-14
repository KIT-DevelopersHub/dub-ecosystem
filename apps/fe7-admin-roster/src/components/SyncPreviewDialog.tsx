// #5: Email Routing sync diff preview. Shows what a sync WOULD change (read-only diff
// from identity), then requires an explicit「適用」to run the actual upsert. Nothing is
// written until the admin confirms here.
import { Modal, Button, Badge } from "@dub/ui";
import type { EmailRoutingSyncPreview, EmailRoutingDiffRow } from "../contracts/pending";

function Section({ title, tone, rows, testId }: { title: string; tone: "success" | "warning" | "danger" | "neutral"; rows: EmailRoutingDiffRow[]; testId: string }) {
  if (rows.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }} data-testid={testId}>
      <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600 }}>
        <Badge tone={tone}>{rows.length}</Badge>
        {title}
      </span>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "var(--dub-color-fg-muted, #57606a)" }}>
        {rows.map((r) => (
          <li key={r.email}>{r.email}</li>
        ))}
      </ul>
    </div>
  );
}

export function SyncPreviewDialog({
  open,
  preview,
  applying,
  onApply,
  onCancel,
}: {
  open: boolean;
  preview: EmailRoutingSyncPreview | null;
  applying: boolean;
  onApply: () => void;
  onCancel: () => void;
}) {
  const p = preview;
  const nothingToDo =
    !!p && p.toAdd.length === 0 && p.toReactivate.length === 0 && p.toRelink.length === 0 && p.toDeactivate.length === 0;

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="Email Routing 同期プレビュー"
      testId="fe7-sync-preview"
      footer={
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="secondary" onClick={onCancel} disabled={applying}>キャンセル</Button>
          <Button variant="primary" onClick={onApply} loading={applying} disabled={nothingToDo} testId="fe7-sync-apply">
            適用する
          </Button>
        </div>
      }
    >
      {!p ? (
        <p>プレビューを取得しています…</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <p style={{ margin: 0, fontSize: 13, color: "var(--dub-color-fg-muted, #57606a)" }} data-testid="fe7-sync-preview-summary">
            追加 {p.projected.added}・更新 {p.projected.updated}・停止 {p.projected.deactivated}（対象 {p.projected.total} 件）。適用するまで名簿は変更されません。
          </p>
          {nothingToDo ? <p style={{ margin: 0, fontSize: 13 }}>変更はありません。名簿は Email Routing と一致しています。</p> : null}
          <Section title="新規追加（名簿に無いアドレス）" tone="success" rows={p.toAdd} testId="fe7-sync-add" />
          <Section title="再有効化（停止中の同期ユーザーが再出現）" tone="success" rows={p.toReactivate} testId="fe7-sync-reactivate" />
          <Section title="種別変更（手動→Email Routing）" tone="neutral" rows={p.toRelink} testId="fe7-sync-relink" />
          <Section title="停止（Email Routing から消えた同期ユーザー）" tone="danger" rows={p.toDeactivate} testId="fe7-sync-deactivate" />
          <Section title="保護（管理者のため停止しません）" tone="warning" rows={p.adminKept} testId="fe7-sync-adminkept" />
        </div>
      )}
    </Modal>
  );
}
