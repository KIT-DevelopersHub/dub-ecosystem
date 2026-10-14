/// <reference lib="dom" />
// Channel details (Slack "チャンネル詳細"): 概要 / メンバー / 設定 tabs inside one modal.
// Everyone who can read the channel can open it; each action is shown per right:
//   canEdit   (chat:moderate or channel admin) -> name / topic / archive / add+remove members
//   onDelete  (chat:delete_channel, non-DM)     -> irreversible delete (typed-checkbox gate)
//   onLeave   (a member of a non-DM channel)    -> leave
// Edits are optimistic in the caller (ChannelPage); this component only drives the UI.
import { useEffect, useMemo, useState } from "react";
import { Avatar, Button, ConfirmDialog, Modal, SkeletonList, Tabs } from "@dub/ui";
import type { common, identity } from "@dub/types";
import type { Channel, ChannelMember, ChatSection } from "../api/contract";
import { normalizeChannelName } from "./CreateChannelModal";
import styles from "../styles/chat.module.css";

export type ChannelDetailsTab = "about" | "members" | "settings";

export interface ChannelDetailsSections {
  items: ChatSection[];
  currentSectionId: string | null;
  onMove: (sectionId: string | null) => void;
}

export interface ChannelDetailsProps {
  open: boolean;
  onClose: () => void;
  channel: Channel;
  currentUserId: common.UserId;
  members: ChannelMember[];
  membersLoaded: boolean;
  resolveUser: (id: common.UserId) => identity.UserSummary | undefined;
  canEdit: boolean;
  initialTab?: ChannelDetailsTab;
  onUpdate: (patch: { name?: string; topic?: string | null; archived?: boolean }) => Promise<void>;
  searchUsers: (q: string) => Promise<identity.UserSummary[]>;
  onAddMember: (user: identity.UserSummary) => void;
  onRemoveMember: (userId: common.UserId) => void;
  onLeave?: () => Promise<void>;
  onDelete?: () => Promise<void>;
  sections?: ChannelDetailsSections;
}

const TOPIC_MAX = 250;

const formatDate = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
};

export function ChannelDetails(props: ChannelDetailsProps) {
  const { open, onClose, channel, members, initialTab = "about" } = props;
  const [tab, setTab] = useState<ChannelDetailsTab>(initialTab);
  const prefix = channel.visibility === "private" ? "🔒 " : "# ";

  return (
    <Modal open={open} onClose={onClose} title={`${prefix}${channel.name}`} size="md" testId="fe6-channel-details">
      <div className={styles.detailsBody}>
        <Tabs
          items={[
            { id: "about", label: "概要" },
            { id: "members", label: `メンバー ${members.length || channel.memberCount}` },
            { id: "settings", label: "設定" },
          ]}
          activeId={tab}
          onChange={(id) => setTab(id as ChannelDetailsTab)}
          testId="fe6-details-tabs"
        />
        <div className={styles.detailsPanel} role="tabpanel">
          {tab === "about" && <AboutTab {...props} />}
          {tab === "members" && <MembersTab {...props} />}
          {tab === "settings" && <SettingsTab {...props} />}
        </div>
      </div>
    </Modal>
  );
}

/* ── 概要 ─────────────────────────────────────────────────────────────────── */

function AboutTab({ channel, canEdit, onUpdate, onLeave }: ChannelDetailsProps) {
  const [leaveOpen, setLeaveOpen] = useState(false);
  const kind = channel.type === "event" ? "イベントチャンネル" : channel.visibility === "private" ? "プライベートチャンネル" : "パブリックチャンネル";
  return (
    <div className={styles.detailsStack}>
      <div className={styles.detailsCard}>
        <EditableRow
          label="チャンネル名"
          value={channel.name}
          display={`# ${channel.name}`}
          canEdit={canEdit && !channel.archived}
          testId="fe6-details-name"
          normalize={normalizeChannelName}
          hint="小文字に揃え、スペースはハイフンになります。"
          maxLength={80}
          required
          onSave={(name) => onUpdate({ name })}
        />
        <EditableRow
          label="トピック"
          value={channel.topic ?? ""}
          display={channel.topic || undefined}
          placeholder="トピックを追加"
          canEdit={canEdit && !channel.archived}
          testId="fe6-details-topic"
          multiline
          hint="チャンネルヘッダーの名前の横に表示されます。"
          maxLength={TOPIC_MAX}
          onSave={(topic) => onUpdate({ topic: topic.trim() || null })}
        />
      </div>
      <div className={styles.detailsCard}>
        <InfoRow label="種類" value={kind} />
        <InfoRow label="作成日" value={`${formatDate(channel.createdAt)}に作成`} />
        {channel.archived && <InfoRow label="状態" value="アーカイブ済み (閲覧のみ)" />}
      </div>
      {!canEdit && (
        <p className={styles.detailsNote}>名前やトピックの変更は、チャンネル管理者またはチャットのモデレーター権限を持つ人が行えます。</p>
      )}
      {onLeave && (
        <div className={styles.detailsCard}>
          <button type="button" className={styles.detailsDangerLink} onClick={() => setLeaveOpen(true)} data-testid="fe6-details-leave">
            チャンネルから退出する
          </button>
        </div>
      )}
      {onLeave && (
        <ConfirmDialog
          open={leaveOpen}
          title={`#${channel.name} から退出しますか？`}
          message={
            channel.visibility === "private"
              ? "プライベートチャンネルのため、再度招待されるまで参加・閲覧できなくなります。"
              : "サイドバーから外れます。パブリックチャンネルなので、あとから再参加できます。"
          }
          confirmLabel="退出する"
          onConfirm={async () => {
            await onLeave().catch(() => undefined);
            setLeaveOpen(false);
          }}
          onCancel={() => setLeaveOpen(false)}
          testId="fe6-details-leave-confirm"
        />
      )}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.detailsRow}>
      <div className={styles.detailsRowMain}>
        <span className={styles.detailsLabel}>{label}</span>
        <span className={styles.detailsValue}>{value}</span>
      </div>
    </div>
  );
}

interface EditableRowProps {
  label: string;
  value: string;
  display?: string;
  placeholder?: string;
  canEdit: boolean;
  testId: string;
  hint?: string;
  maxLength: number;
  multiline?: boolean;
  required?: boolean;
  normalize?: (raw: string) => string;
  onSave: (value: string) => Promise<void>;
}

// Slack-style card row: label + value + 「編集」; editing swaps the row for a field.
// The caller applies the change optimistically, so the row closes on submit.
function EditableRow({ label, value, display, placeholder, canEdit, testId, hint, maxLength, multiline, required, normalize, onSave }: EditableRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const next = normalize ? normalize(draft) : draft;
  const invalid = (required && next.trim().length === 0) || next.length > maxLength;

  const start = () => {
    setDraft(value);
    setEditing(true);
  };
  const submit = () => {
    if (invalid) return;
    setEditing(false);
    if (next !== value) void onSave(next).catch(() => undefined);
  };

  if (editing) {
    const fieldProps = {
      className: styles.createInput,
      value: draft,
      autoFocus: true,
      maxLength: maxLength + 20,
      onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
      onKeyDown: (e: { key: string; shiftKey: boolean; nativeEvent: { isComposing?: boolean }; preventDefault: () => void }) => {
        if (e.key === "Escape") setEditing(false);
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          submit();
        }
      },
      "data-testid": `${testId}-input`,
      "aria-label": label,
    };
    return (
      <form
        className={styles.detailsRowEdit}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <span className={styles.detailsLabel}>{label}</span>
        {multiline ? <textarea rows={3} {...fieldProps} /> : <input {...fieldProps} />}
        <div className={styles.detailsEditFoot}>
          <span className={styles.createHint}>
            {normalize && next && next !== draft ? `「${next}」として保存されます。` : hint}
          </span>
          <span className={next.length > maxLength ? styles.detailsCountOver : styles.createHint}>
            {next.length}/{maxLength}
          </span>
        </div>
        <div className={styles.detailsEditActions}>
          <Button variant="secondary" size="sm" onClick={() => setEditing(false)}>
            キャンセル
          </Button>
          <Button size="sm" disabled={invalid} onClick={submit} testId={`${testId}-save`}>
            保存
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className={styles.detailsRow}>
      <div className={styles.detailsRowMain}>
        <span className={styles.detailsLabel}>{label}</span>
        <span className={display ? styles.detailsValue : styles.detailsValueEmpty} data-testid={testId}>
          {display ?? (canEdit ? placeholder : "未設定")}
        </span>
      </div>
      {canEdit && (
        <button type="button" className={styles.detailsEditLink} onClick={start} data-testid={`${testId}-edit`}>
          編集
        </button>
      )}
    </div>
  );
}

/* ── メンバー ─────────────────────────────────────────────────────────────── */

function MembersTab({ channel, members, membersLoaded, currentUserId, resolveUser, canEdit, searchUsers, onAddMember, onRemoveMember }: ChannelDetailsProps) {
  const [filter, setFilter] = useState("");
  const [adding, setAdding] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<common.UserId | null>(null);
  const canManage = canEdit && channel.type !== "dm" && !channel.archived;

  const nameOf = (id: common.UserId) => resolveUser(id)?.displayName ?? "読み込み中…";
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return [...members]
      .filter((m) => !q || nameOf(m.userId).toLowerCase().includes(q))
      // you first, then channel admins, then by name (Slack orders managers on top)
      .sort((a, b) => {
        if (a.userId === currentUserId) return -1;
        if (b.userId === currentUserId) return 1;
        if (a.role !== b.role) return a.role === "admin" ? -1 : 1;
        return nameOf(a.userId).localeCompare(nameOf(b.userId), "ja");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, filter, currentUserId, resolveUser]);

  if (adding) {
    return (
      <AddMembersPanel
        existing={new Set(members.map((m) => m.userId))}
        searchUsers={searchUsers}
        onAdd={onAddMember}
        onDone={() => setAdding(false)}
      />
    );
  }

  return (
    <div className={styles.detailsStack}>
      <input
        className={styles.createInput}
        placeholder="メンバーを検索"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        aria-label="メンバーを検索"
        data-testid="fe6-details-member-filter"
      />
      <div className={styles.detailsMemberList}>
        {canManage && (
          <button type="button" className={styles.detailsMemberAdd} onClick={() => setAdding(true)} data-testid="fe6-details-add-member">
            <span className={styles.detailsMemberAddIcon} aria-hidden>
              ＋
            </span>
            メンバーを追加
          </button>
        )}
        {!membersLoaded ? (
          <SkeletonList rows={4} avatar />
        ) : rows.length === 0 ? (
          <p className={styles.detailsNote}>「{filter}」に一致するメンバーはいません。</p>
        ) : (
          rows.map((m) => {
            const u = resolveUser(m.userId);
            const self = m.userId === currentUserId;
            return (
              <div key={m.userId} className={styles.detailsMember} data-testid="fe6-details-member">
                <Avatar name={u?.displayName ?? "?"} src={u?.avatarUrl ?? undefined} size="sm" />
                <span className={styles.detailsMemberName}>
                  {nameOf(m.userId)}
                  {self && <span className={styles.detailsMemberSelf}>（あなた）</span>}
                </span>
                {m.role === "admin" && <span className={styles.detailsMemberBadge}>チャンネル管理者</span>}
                {canManage && !self && (
                  <button
                    type="button"
                    className={styles.detailsMemberRemove}
                    onClick={() => setPendingRemove(m.userId)}
                    data-testid="fe6-details-remove-member"
                  >
                    削除
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
      <ConfirmDialog
        open={pendingRemove !== null}
        title={`${pendingRemove ? nameOf(pendingRemove) : ""} さんをチャンネルから削除しますか？`}
        message={channel.visibility === "private" ? "再度招待されるまで、このチャンネルを閲覧できなくなります。" : "このチャンネルのメンバーから外れます。あとから再参加できます。"}
        confirmLabel="削除する"
        danger
        onConfirm={() => {
          if (pendingRemove) onRemoveMember(pendingRemove);
          setPendingRemove(null);
        }}
        onCancel={() => setPendingRemove(null)}
        testId="fe6-details-remove-confirm"
      />
    </div>
  );
}

function AddMembersPanel({
  existing,
  searchUsers,
  onAdd,
  onDone,
}: {
  existing: Set<common.UserId>;
  searchUsers: (q: string) => Promise<identity.UserSummary[]>;
  onAdd: (user: identity.UserSummary) => void;
  onDone: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<identity.UserSummary[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setResults(null);
    setFailed(false);
    const handle = globalThis.setTimeout(() => {
      searchUsers(query)
        .then((users) => !cancelled && setResults(users))
        .catch(() => {
          if (cancelled) return;
          setResults([]);
          setFailed(true);
        });
    }, 200);
    return () => {
      cancelled = true;
      globalThis.clearTimeout(handle);
    };
  }, [query, searchUsers]);

  return (
    <div className={styles.detailsStack} data-testid="fe6-details-add-panel">
      <button type="button" className={styles.detailsBack} onClick={onDone}>
        ← メンバー一覧に戻る
      </button>
      <input
        className={styles.createInput}
        placeholder="名前で検索して追加"
        value={query}
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
        aria-label="追加するメンバーを検索"
        data-testid="fe6-details-add-search"
      />
      <div className={styles.detailsMemberList}>
        {results === null ? (
          <SkeletonList rows={4} avatar />
        ) : failed ? (
          <p className={styles.detailsNote}>メンバーを検索できませんでした。時間をおいてもう一度お試しください。</p>
        ) : results.length === 0 ? (
          <p className={styles.detailsNote}>該当するメンバーがいません。</p>
        ) : (
          results.map((u) => {
            const joined = existing.has(u.id);
            return (
              <div key={u.id} className={styles.detailsMember}>
                <Avatar name={u.displayName} src={u.avatarUrl ?? undefined} size="sm" />
                <span className={styles.detailsMemberName}>{u.displayName}</span>
                {joined ? (
                  <span className={styles.detailsMemberSelf}>参加済み</span>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => onAdd(u)} testId="fe6-details-add-pick">
                    追加
                  </Button>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/* ── 設定 ─────────────────────────────────────────────────────────────────── */

function SettingsTab({ channel, canEdit, onUpdate, onDelete, sections }: ChannelDetailsProps) {
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const canArchive = canEdit && channel.type !== "dm";

  return (
    <div className={styles.detailsStack}>
      {sections && (
        <div className={styles.detailsCard}>
          <div className={styles.detailsRow}>
            <div className={styles.detailsRowMain}>
              <span className={styles.detailsLabel}>サイドバーのセクション</span>
              <span className={styles.detailsHelp}>自分のサイドバーでの表示場所です。他のメンバーには影響しません。</span>
            </div>
            <select
              className={styles.detailsSelect}
              value={sections.currentSectionId ?? ""}
              onChange={(e) => sections.onMove(e.target.value || null)}
              aria-label="サイドバーのセクション"
              data-testid="fe6-details-section"
            >
              <option value="">セクションなし</option>
              {sections.items.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {canArchive && (
        <div className={styles.detailsCard}>
          <button type="button" className={styles.detailsAction} onClick={() => setArchiveOpen(true)} data-testid="fe6-settings-archive">
            <span className={styles.detailsActionTitle}>{channel.archived ? "アーカイブを解除する" : "全員に対してチャンネルをアーカイブする"}</span>
            <span className={styles.detailsHelp}>
              {channel.archived
                ? "再び投稿できる状態に戻します。"
                : "メッセージは残り、あとから閲覧・検索できます。新しい投稿はできなくなります。"}
            </span>
          </button>
        </div>
      )}

      {onDelete && (
        <div className={styles.detailsCard}>
          <button type="button" className={styles.detailsAction} onClick={() => setDeleteOpen(true)} data-testid="fe6-settings-delete">
            <span className={styles.detailsActionDanger}>このチャンネルを削除する</span>
            <span className={styles.detailsHelp}>すべてのメッセージを含めて完全に削除します。元に戻せません。</span>
          </button>
        </div>
      )}

      {!canArchive && !onDelete && (
        <p className={styles.detailsNote}>
          アーカイブはチャンネル管理者またはモデレーター、削除はロール管理で「チャンネルを削除」を許可された人だけが行えます。
        </p>
      )}

      <ConfirmDialog
        open={archiveOpen}
        title={channel.archived ? "アーカイブを解除しますか？" : `#${channel.name} をアーカイブしますか？`}
        message={
          channel.archived
            ? "チャンネルへの投稿が再びできるようになります。"
            : "全員に対してアーカイブされ、新しい投稿ができなくなります。メッセージは残るので、あとから閲覧・検索・解除できます。"
        }
        confirmLabel={channel.archived ? "解除する" : "アーカイブする"}
        danger={!channel.archived}
        onConfirm={async () => {
          await onUpdate({ archived: !channel.archived }).catch(() => undefined);
          setArchiveOpen(false);
        }}
        onCancel={() => setArchiveOpen(false)}
        testId="fe6-settings-archive-confirm"
      />
      {onDelete && <DeleteChannelDialog open={deleteOpen} channel={channel} onDelete={onDelete} onClose={() => setDeleteOpen(false)} />}
    </div>
  );
}

// Slack gates delete behind an explicit "yes, permanently delete" checkbox.
function DeleteChannelDialog({ open, channel, onDelete, onClose }: { open: boolean; channel: Channel; onDelete: () => Promise<void>; onClose: () => void }) {
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const close = () => {
    setAgreed(false);
    onClose();
  };
  const confirm = async () => {
    if (!agreed || busy) return;
    setBusy(true);
    try {
      await onDelete();
      close();
    } catch {
      // caller toasts the reason; keep the dialog open to retry
    } finally {
      setBusy(false);
    }
  };
  if (!open) return null;
  return (
    <Modal
      open
      onClose={close}
      title={`#${channel.name} を削除しますか？`}
      size="sm"
      testId="fe6-settings-delete-confirm"
      footer={
        <div className={styles.detailsEditActions}>
          <Button variant="secondary" onClick={close}>
            キャンセル
          </Button>
          <Button variant="danger" disabled={!agreed} loading={busy} onClick={() => void confirm()} testId="fe6-settings-delete-submit">
            チャンネルを削除する
          </Button>
        </div>
      }
    >
      <div className={styles.detailsStack}>
        <p className={styles.detailsDeleteText}>
          チャンネルとすべてのメッセージが完全に削除され、元に戻すことはできません。アーカイブと違い、あとから閲覧・検索・復元することもできなくなります。
        </p>
        {!channel.archived && <p className={styles.detailsHelp}>メッセージを残したい場合は、代わりにアーカイブを使ってください。</p>}
        <label className={styles.detailsCheck}>
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} data-testid="fe6-settings-delete-agree" />
          はい、このチャンネルを完全に削除します
        </label>
      </div>
    </Modal>
  );
}
