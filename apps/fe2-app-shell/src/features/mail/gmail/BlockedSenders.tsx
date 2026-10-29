// Sender block list UI: the reading-pane menu + confirm (この送信者をブロック /
// ドメインごとブロック), the banner on a blocked conversation (ブロックを解除), the
// ブロック中のアドレス management panel shown in the ブロック済み folder, and the
// bottom-left notice. Data/mutations come from the store + useSenderBlocks (optimistic).
import { useEffect, useState } from "react";
import { Button, ConfirmDialog, EmptyState, Menu, SkeletonList, type MenuItem } from "@dub/ui";
import { MailIcon } from "./icons.tsx";
import { ORG_MAIL_DOMAIN, blockTarget, displayName, domainOf, fullDate, matchingBlock, type BlockKind, type MailThreadModel } from "./mailModel.ts";
import { useMailStore } from "./useMailStore.tsx";
import { useSenderBlocks } from "./useSenderBlocks.tsx";
import styles from "./blocks.module.css";

interface PendingBlock {
  email: string;
  name: string;
  kind: BlockKind;
}

/** Kebab menu in the reading-pane header. Offers block (address / whole domain) for the
 *  conversation's external sender, or unblock when it is already blocked. Renders nothing
 *  for a sent-only conversation (there is no sender to block). */
export function BlockSenderMenu({ thread }: { thread: MailThreadModel }): JSX.Element | null {
  const { state } = useMailStore();
  const { block, unblock } = useSenderBlocks();
  const [pending, setPending] = useState<PendingBlock | null>(null);
  const sender = blockTarget(thread);
  if (!sender) return null;
  const email = sender.email.trim().toLowerCase();
  const domain = domainOf(email);
  const active = matchingBlock(email, state.blocks);
  const isOrg = domain === ORG_MAIL_DOMAIN || domain.endsWith(`.${ORG_MAIL_DOMAIN}`);
  const isSelf = email === state.me.email.trim().toLowerCase();

  const items: MenuItem[] = active
    ? [{ id: "unblock", label: "ブロックを解除", icon: "ban", onSelect: () => unblock(active.value), testId: "fe2-mail-unblock-sender" }]
    : [
        {
          id: "block",
          label: "この送信者をブロック",
          icon: "ban",
          disabled: isSelf,
          onSelect: () => setPending({ email, name: displayName(sender), kind: "address" }),
          testId: "fe2-mail-block-sender",
        },
        {
          id: "block-domain",
          label: isOrg ? "ドメインごとブロック（組織ドメインは不可）" : `ドメインごとブロック（${domain}）`,
          icon: "ban",
          disabled: isOrg || domain === "",
          tone: "danger",
          onSelect: () => setPending({ email, name: displayName(sender), kind: "domain" }),
          testId: "fe2-mail-block-domain",
        },
      ];

  return (
    <>
      <Menu label="その他の操作" iconOnly icon="more-vertical" align="end" items={items} testId="fe2-mail-more" />
      <ConfirmDialog
        open={pending !== null}
        title={pending?.kind === "domain" ? `${domain} をドメインごとブロックしますか？` : `${pending?.email ?? ""} をブロックしますか？`}
        message={
          pending?.kind === "domain"
            ? `今後 ${domain} のすべてのアドレスから届くメールは受信トレイに表示されず、「ブロック済み」に振り分けられます。既存のメールも受信トレイから非表示になります。メールは削除されず、いつでも解除できます。`
            : `今後 ${pending?.name ?? ""}（${pending?.email ?? ""}）から届くメールは受信トレイに表示されず、「ブロック済み」に振り分けられます。既存のメールも受信トレイから非表示になります。メールは削除されず、いつでも解除できます。`
        }
        confirmLabel="ブロックする"
        danger
        onConfirm={() => {
          if (pending) block(pending.email, pending.kind);
          setPending(null);
        }}
        onCancel={() => setPending(null)}
        testId="fe2-mail-block-confirm"
      />
    </>
  );
}

/** Banner on an open conversation whose sender is blocked: says why it is not in the inbox
 *  and offers ブロックを解除 (which puts the conversation straight back). */
export function BlockedBanner({ thread }: { thread: MailThreadModel }): JSX.Element | null {
  const { state } = useMailStore();
  const { unblock } = useSenderBlocks();
  const sender = blockTarget(thread);
  if (!thread.blocked || !sender) return null;
  const entry = matchingBlock(sender.email, state.blocks);
  const what = entry?.kind === "domain" ? `ドメイン「${entry.value}」` : sender.email;
  return (
    <div className={styles.banner} role="status" data-testid="fe2-mail-blocked-banner">
      <MailIcon name="block" size={18} style={{ color: "var(--dub-color-danger-500)" }} />
      <span className={styles.bannerText}>{what} をブロック中です。このスレッドは受信トレイに表示されません。</span>
      {entry ? (
        <Button variant="secondary" size="sm" onClick={() => unblock(entry.value)} testId="fe2-mail-blocked-banner-unblock">
          ブロックを解除
        </Button>
      ) : null}
    </div>
  );
}

/** ブロック中のアドレス: the viewer's block list with per-row unblock. Skeleton while the
 *  first load is pending, EmptyState when the list is empty (never conflated). */
export function BlockedSendersPanel(): JSX.Element {
  const { state } = useMailStore();
  const { unblock } = useSenderBlocks();
  const { blocks, blocksStatus } = state;
  return (
    <section className={styles.panel} data-testid="fe2-mail-blocked-senders" aria-label="ブロック中のアドレス">
      <header className={styles.panelHeader}>
        <MailIcon name="block" size={20} style={{ color: "var(--dub-color-danger-500)" }} />
        <h2 className={styles.panelTitle}>ブロック中のアドレス</h2>
        {blocksStatus === "ready" ? <span className={styles.panelCount}>{blocks.length}件</span> : null}
      </header>
      <div className={styles.panelBody}>
        {blocksStatus === "loading" ? (
          <SkeletonList rows={3} testId="fe2-mail-blocked-senders-loading" />
        ) : blocksStatus === "failed" && blocks.length === 0 ? (
          <EmptyState title="ブロックリストを読み込めませんでした" description="時間をおいてもう一度お試しください。" testId="fe2-mail-blocked-senders-error" />
        ) : blocks.length === 0 ? (
          <EmptyState
            title="ブロック中のアドレスはありません"
            description="メールを開き、右上のメニューから「この送信者をブロック」を選ぶと追加できます。"
            testId="fe2-mail-blocked-senders-empty"
          />
        ) : (
          <ul className={styles.list}>
            {blocks.map((b) => (
              <li key={b.value} className={styles.row} data-testid="fe2-mail-blocked-sender-row" data-value={b.value}>
                <MailIcon name={b.kind === "domain" ? "people" : "person"} size={16} style={{ color: "var(--dub-color-text-muted)" }} />
                <span className={styles.rowValue}>{b.kind === "domain" ? `@${b.value}（ドメイン全体）` : b.value}</span>
                <span className={styles.rowMeta}>{fullDate(b.createdAt)}</span>
                <Button variant="ghost" size="sm" onClick={() => unblock(b.value)} testId="fe2-mail-blocked-sender-unblock">
                  ブロックを解除
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** Bottom-left block/unblock notice: success offers 元に戻す, a rolled-back failure stays
 *  until closed (role=alert). */
export function BlockNoticeBar(): JSX.Element | null {
  const { state, dispatch } = useMailStore();
  const { block, unblock } = useSenderBlocks();
  const notice = state.blockNotice;
  useEffect(() => {
    if (!notice || notice.status === "failed") return;
    const t = setTimeout(() => dispatch({ type: "BLOCK_NOTICE", notice: null }), 6000);
    return () => clearTimeout(t);
  }, [notice, dispatch]);
  if (!notice) return null;
  const failed = notice.status === "failed";
  const undo = (): void => {
    const b = notice.block;
    if (!b) return;
    if (notice.status === "blocked") unblock(b.value);
    else block(b.value, b.kind);
    dispatch({ type: "BLOCK_NOTICE", notice: null });
  };
  const raised = state.undo !== null || state.sendNotice !== null;
  return (
    <div
      className={`${styles.notice} ${raised ? styles.noticeRaised : ""}`}
      role={failed ? "alert" : "status"}
      data-testid="fe2-mail-block-notice"
      data-status={notice.status}
    >
      <span>{notice.text}</span>
      {!failed && notice.block ? (
        <button type="button" className={styles.noticeAction} onClick={undo} data-testid="fe2-mail-block-notice-undo">
          元に戻す
        </button>
      ) : null}
      <button type="button" aria-label="閉じる" className={styles.noticeClose} onClick={() => dispatch({ type: "BLOCK_NOTICE", notice: null })}>
        <MailIcon name="x" size={16} />
      </button>
    </div>
  );
}
