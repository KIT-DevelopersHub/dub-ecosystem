// メール名簿(identity_users)側から「運営メンバーと紐付け」を行うダイアログ。fe2 の
// member→account LinkIdentityDialog の逆方向: ここでは1件の @developershub.jp アカウントに
// 対して既存の運営メンバーを検索/選択して紐付ける。書き込む先は同じ member.identityUserId
// (単一の真実) で、サーバが 1:1 制約 (MEMBER_IDENTITY_ALREADY_LINKED 409) を担保する。
// 紐付けは楽観的 (useLinkMemberIdentity)。
import { useMemo, useState } from "react";
import { Modal, Button, TextField, Tag, SkeletonLoader, ErrorState } from "@dub/ui";
import { DialogActions } from "@dub/app-ui";
import type { member } from "@dub/types";
import type { RosterUser } from "../contracts/pending";
import { useMembersOverview, useLinkMemberIdentity } from "../hooks/useRosterApi";
import { displayError } from "../lib/errorDisplay";

/** local-part of an email ("taro.sato@x" -> "taro.sato"), used for a light name hint. */
function localPart(email: string): string {
  const at = email.indexOf("@");
  return (at > 0 ? email.slice(0, at) : email).toLowerCase();
}

/** Loose "looks like a candidate" heuristic: the account's display name or email
 *  local-part shares a token with the member's name. Never auto-applies — just floats up. */
function looksLikeCandidate(memberName: string, account: RosterUser): boolean {
  const name = memberName.toLowerCase().replace(/\s+/g, "");
  const dn = account.displayName.toLowerCase().replace(/\s+/g, "");
  if (name && dn && (dn.includes(name) || name.includes(dn))) return true;
  const lp = localPart(account.email);
  return lp.length >= 3 && name.includes(lp);
}

export function MemberLinkDialog({
  open,
  onClose,
  account,
}: {
  open: boolean;
  onClose: () => void;
  /** The メール名簿 row (developershub.jp/identity account) being linked. */
  account: RosterUser | null;
}): JSX.Element {
  const overview = useMembersOverview();
  const link = useLinkMemberIdentity();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const members = overview.data?.members ?? [];
  const ranked = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = members.map((m) => ({
      member: m,
      // linked to ANOTHER account already → disabled (avoid silently stealing a link).
      taken: !!m.identityUserId && m.identityUserId !== account?.id,
      candidate: account ? looksLikeCandidate(m.name, account) : false,
    }));
    const filtered = q
      ? rows.filter((r) => r.member.name.toLowerCase().includes(q) || (r.member.roleTitle ?? "").toLowerCase().includes(q))
      : rows;
    // candidates first, then already-taken sink to the bottom, then by name.
    return filtered.sort((a, b) => {
      if (a.taken !== b.taken) return a.taken ? 1 : -1;
      if (a.candidate !== b.candidate) return a.candidate ? -1 : 1;
      return a.member.name.localeCompare(b.member.name, "ja");
    });
  }, [members, search, account]);

  const close = () => {
    setSelectedId(null);
    setSearch("");
    onClose();
  };

  const confirm = () => {
    if (!account || !selectedId) return;
    const target = members.find((m) => m.id === selectedId);
    if (!target) return;
    link.mutate(
      { member: target, identityUserId: account.id },
      { onSuccess: () => close() },
    );
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={account ? `${account.email} を運営メンバーと紐付け` : "運営メンバーと紐付け"}
      testId="fe7-member-link-dialog"
      footer={
        <DialogActions>
          <Button variant="secondary" onClick={close} disabled={link.isPending} testId="fe7-member-link-cancel">
            キャンセル
          </Button>
          <Button variant="primary" onClick={confirm} loading={link.isPending} disabled={!selectedId} testId="fe7-member-link-confirm">
            紐付ける
          </Button>
        </DialogActions>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p style={{ color: "var(--dub-color-fg-muted, #57606a)", margin: 0, fontSize: 13 }}>
          このメールアドレスに対応する運営メンバーを選んで「紐付ける」を押してください（自動では紐付けません）。既に別のアカウントに紐付いているメンバーは選べません。
        </p>
        <TextField id="fe7-member-link-search" value={search} onChange={setSearch} placeholder="氏名・担当で絞り込み" testId="fe7-member-link-search" />

        {overview.isLoading ? (
          <SkeletonLoader testId="fe7-member-link-loading" />
        ) : overview.isError ? (
          <ErrorState error={displayError(overview.error)} onRetry={() => overview.refetch()} testId="fe7-member-link-error" />
        ) : ranked.length === 0 ? (
          <p style={{ color: "var(--dub-color-fg-muted, #57606a)", margin: 0 }} data-testid="fe7-member-link-empty">
            該当する運営メンバーがいません。
          </p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4, maxHeight: 320, overflowY: "auto" }} data-testid="fe7-member-link-candidates">
            {ranked.map(({ member: m, taken, candidate }) => (
              <li key={m.id}>
                <button
                  type="button"
                  aria-pressed={selectedId === m.id}
                  disabled={taken}
                  onClick={() => setSelectedId(m.id)}
                  data-testid={`fe7-member-link-option-${m.id}`}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    padding: "8px 10px",
                    border: `1px solid ${selectedId === m.id ? "var(--dub-color-accent-fg, #0969da)" : "var(--dub-color-border, #d0d7de)"}`,
                    borderRadius: 6,
                    background: selectedId === m.id ? "var(--dub-color-accent-subtle, #ddf4ff)" : "transparent",
                    cursor: taken ? "not-allowed" : "pointer",
                    opacity: taken ? 0.55 : 1,
                    textAlign: "left",
                    font: "inherit",
                  }}
                >
                  <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                    <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span>
                    <span style={{ fontSize: 12, color: "var(--dub-color-fg-muted, #57606a)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {m.roleTitle ?? "担当未設定"}
                    </span>
                  </span>
                  <span style={{ display: "inline-flex", gap: 4, flexShrink: 0 }}>
                    {candidate && !taken ? <Tag tone="success">候補</Tag> : null}
                    {taken ? <Tag tone="neutral">紐付け済み</Tag> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
