import { useEffect, useRef, useState } from "react";
import {
  Modal,
  Button,
  Badge,
  SkeletonList,
  ErrorState,
  EmptyState,
  ConfirmDialog,
} from "@dub/ui";
import { useEmailAddresses, useDeleteEmailAddress } from "../hooks/useRosterApi";
import { useToast } from "../hooks/useToast";
import { displayError, presentError } from "../lib/errorDisplay";
import type { EmailRoutingAddress } from "../contracts/pending";

// The counterpart to NewEmailAddressDialog: lists the issued @developershub.jp addresses
// and lets an admin DELETE one (drops its Cloudflare Email Routing rule). Guardrails:
//  1) 誤削除防止: a ConfirmDialog names the exact address before anything happens.
//  2) 楽観的UI: on confirm the row disappears immediately (deferred-commit) …
//  3) 元に戻す: … and a 5s countdown banner lets the admin undo before the DELETE fires.
//     The real API call only runs after the window elapses; an undo cancels it entirely.
//  On API failure the row is restored (cache re-fetch) and an error toast is shown.

const UNDO_SECONDS = 5;

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 16,
  padding: "12px 4px",
  borderBottom: "1px solid var(--dub-color-border, #d0d7de)",
};
const addrColStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 };
const addrStyle: React.CSSProperties = { fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const metaStyle: React.CSSProperties = { color: "var(--dub-color-text-muted)", fontSize: "0.85em" };
const hintStyle: React.CSSProperties = { margin: "0 0 12px", color: "var(--dub-color-text-muted)", fontSize: "0.85em" };
const undoBarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "10px 12px",
  marginTop: 12,
  borderRadius: 8,
  background: "var(--dub-color-surface-muted, #f6f8fa)",
  border: "1px solid var(--dub-color-border, #d0d7de)",
};

interface PendingRemoval {
  address: EmailRoutingAddress;
  secondsLeft: number;
}

export function IssuedAddressesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const query = useEmailAddresses();
  const del = useDeleteEmailAddress();
  const { toast } = useToast();

  // Address the admin picked but has not yet confirmed (drives the ConfirmDialog).
  const [pendingConfirm, setPendingConfirm] = useState<EmailRoutingAddress | null>(null);
  // Address confirmed and now in the undo window (hidden from the list, DELETE deferred).
  const [pending, setPending] = useState<PendingRemoval | null>(null);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  function clearTimers() {
    if (commitTimer.current) clearTimeout(commitTimer.current);
    if (tickTimer.current) clearInterval(tickTimer.current);
    commitTimer.current = null;
    tickTimer.current = null;
  }

  // Fire the real DELETE for the address currently in the undo window.
  function commitRemoval(address: EmailRoutingAddress) {
    clearTimers();
    setPending(null);
    del.mutate(address.id, {
      onSuccess: () => toast({ kind: "success", title: "アドレスを削除しました", description: address.address }),
      onError: (err) => {
        const p = presentError(err);
        toast({
          kind: "error",
          title: "削除に失敗しました",
          description: "message" in p ? p.message : address.address,
        });
      },
    });
  }

  function startRemoval(address: EmailRoutingAddress) {
    // Only one pending removal at a time: commit any in-flight one immediately first.
    if (pending) commitRemoval(pending.address);
    clearTimers();
    setPendingConfirm(null);
    setPending({ address, secondsLeft: UNDO_SECONDS });
    tickTimer.current = setInterval(() => {
      setPending((p) => (p ? { ...p, secondsLeft: Math.max(0, p.secondsLeft - 1) } : p));
    }, 1000);
    commitTimer.current = setTimeout(() => commitRemoval(address), UNDO_SECONDS * 1000);
  }

  function undoRemoval() {
    clearTimers();
    setPending(null);
  }

  // Clean up timers on unmount. Closing the dialog commits any pending removal so the
  // deferred DELETE is never silently dropped.
  useEffect(() => () => clearTimers(), []);

  function handleClose() {
    if (pending) commitRemoval(pending.address);
    setPendingConfirm(null);
    onClose();
  }

  const allItems = query.data?.items ?? [];
  // 楽観的UI: hide the address currently in the undo window.
  const items = pending ? allItems.filter((a) => a.id !== pending.address.id) : allItems;

  return (
    <Modal title="発行済みアドレス" open={open} onClose={handleClose} size="lg" testId="fe7-issued-addresses-dialog">
      <p style={hintStyle} data-testid="fe7-issued-addresses-hint">
        発行済みの @developershub.jp アドレスの一覧です。不要になったアドレスは削除できます（Cloudflare Email
        Routing のルールを削除します）。
      </p>

      {query.isLoading ? (
        <SkeletonList rows={4} testId="fe7-issued-addresses-loading" />
      ) : query.isError ? (
        <ErrorState error={displayError(query.error)} onRetry={() => query.refetch()} testId="fe7-issued-addresses-error" />
      ) : items.length === 0 && !pending ? (
        <EmptyState title="発行済みのアドレスはありません" testId="fe7-issued-addresses-empty" />
      ) : (
        <div data-testid="fe7-issued-addresses-list">
          {items.map((a) => (
            <div key={a.id} style={rowStyle} data-testid={`fe7-issued-address-row-${a.id}`}>
              <span style={addrColStyle}>
                <span style={addrStyle}>{a.address}</span>
                <span style={metaStyle}>
                  {a.enabled ? (
                    <Badge tone="success">有効</Badge>
                  ) : (
                    <Badge tone="neutral">停止中</Badge>
                  )}
                </span>
              </span>
              <Button
                variant="danger"
                size="sm"
                onClick={() => setPendingConfirm(a)}
                testId={`fe7-issued-address-delete-${a.id}`}
              >
                削除
              </Button>
            </div>
          ))}
        </div>
      )}

      {pending ? (
        <div style={undoBarStyle} data-testid="fe7-issued-address-undo">
          <span>
            <strong>{pending.address.address}</strong> を削除します（{pending.secondsLeft}秒）
          </span>
          <Button variant="secondary" size="sm" onClick={undoRemoval} testId="fe7-issued-address-undo-button">
            元に戻す
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        title="アドレスを削除"
        message={
          <span>
            <strong>{pendingConfirm?.address}</strong> を削除します。
            <br />
            このアドレス宛の受信ができなくなります。よろしいですか？
          </span>
        }
        open={pendingConfirm !== null}
        danger
        confirmLabel="削除する"
        cancelLabel="キャンセル"
        onConfirm={() => {
          if (pendingConfirm) startRemoval(pendingConfirm);
        }}
        onCancel={() => setPendingConfirm(null)}
        testId="fe7-issued-address-delete-confirm"
      />
    </Modal>
  );
}
