import { useState } from "react";
import type { chat } from "@dub/types";
import { Card, SegmentedControl, Button, ConfirmDialog, SkeletonList, ErrorState } from "@dub/ui";
import type { SegmentedOption } from "@dub/ui";
import { useChatDeletionPolicy, useUpdateChatDeletionPolicy } from "../hooks/useRosterApi";
import { usePermissions } from "../hooks/usePermissions";
import { displayError } from "../lib/errorDisplay";

// メッセージ削除ポリシー — a workspace-wide setting on the ロール管理 screen. Today every
// tier defaults to 完全に消す(hard) so "誰が消しても痕跡なく消える"; this is the 器 that later
// lets 一般メンバー be switched to 痕跡を残す(tombstone) while admin/maintainer stay hard.
// The tier is resolved server-side from chat:moderate (member vs moderator) — this UI
// never asserts a caller's tier, it only configures the behaviour per tier.

function modeOptions(tier: "member" | "moderator", disabled: boolean): SegmentedOption<chat.MessageDeletionMode>[] {
  return [
    { value: "hard", label: "完全に消す", testId: `fe7-chatdel-${tier}-hard`, disabled },
    { value: "tombstone", label: "痕跡を残す", testId: `fe7-chatdel-${tier}-tombstone`, disabled },
  ];
}

const sectionTitle: React.CSSProperties = { fontWeight: 600, fontSize: 16, marginBottom: 4 };
const sectionDesc: React.CSSProperties = { color: "var(--dub-color-text-muted, #57606a)", fontSize: 13, marginBottom: 16 };
const tierLabel: React.CSSProperties = { fontWeight: 600, fontSize: 14, marginBottom: 2 };
const tierHint: React.CSSProperties = { color: "var(--dub-color-text-muted, #57606a)", fontSize: 12, marginBottom: 8 };
const tierBlock: React.CSSProperties = { marginBottom: 20 };
const footer: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12, marginTop: 8 };

export function ChatDeletionPolicySection() {
  const query = useChatDeletionPolicy();
  const update = useUpdateChatDeletionPolicy();
  const { can } = usePermissions();
  const readOnly = !can("chat:moderate");

  // Seed the editable copy from the server once, then let the user edit locally.
  const [member, setMember] = useState<chat.MessageDeletionMode | null>(null);
  const [moderator, setModerator] = useState<chat.MessageDeletionMode | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [confirmSave, setConfirmSave] = useState(false);

  if (query.data && !hydrated) {
    setMember(query.data.policy.member);
    setModerator(query.data.policy.moderator);
    setHydrated(true);
  }

  const effMember = member ?? query.data?.policy.member ?? "hard";
  const effModerator = moderator ?? query.data?.policy.moderator ?? "hard";
  const dirty =
    !!query.data && (effMember !== query.data.policy.member || effModerator !== query.data.policy.moderator);

  function save() {
    setConfirmSave(false);
    if (!query.data) return;
    update.mutate({ policy: { member: effMember, moderator: effModerator }, version: query.data.version });
  }

  return (
    <Card testId="fe7-chat-deletion-policy">
      <div style={sectionTitle}>メッセージ削除ポリシー</div>
      <div style={sectionDesc}>
        チャットのメッセージを削除したときの挙動を、権限（ロール）ごとに設定します。「完全に消す」は
        一覧から痕跡なく消え、「痕跡を残す」は「このメッセージは削除されました」と表示されます。
      </div>

      {query.isLoading ? (
        <div data-testid="fe7-chatdel-skeleton">
          <SkeletonList rows={2} />
        </div>
      ) : query.isError ? (
        <ErrorState error={displayError(query.error)} onRetry={() => query.refetch()} testId="fe7-chatdel-error" />
      ) : (
        <>
          <div style={tierBlock}>
            <div style={tierLabel}>一般メンバーの削除</div>
            <div style={tierHint}>chat:moderate を持たないメンバーが自分のメッセージを削除したとき。</div>
            <SegmentedControl
              testId="fe7-chatdel-member"
              aria-label="一般メンバーの削除の挙動"
              value={effMember}
              onChange={(v) => setMember(v)}
              options={modeOptions("member", readOnly)}
            />
          </div>

          <div style={tierBlock}>
            <div style={tierLabel}>管理者・maintainer の削除</div>
            <div style={tierHint}>chat:moderate を持つ管理者・maintainer が削除したとき。</div>
            <SegmentedControl
              testId="fe7-chatdel-moderator"
              aria-label="管理者・maintainer の削除の挙動"
              value={effModerator}
              onChange={(v) => setModerator(v)}
              options={modeOptions("moderator", readOnly)}
            />
          </div>

          {readOnly ? (
            <p style={tierHint}>編集するには chat:moderate 権限が必要です。</p>
          ) : (
            <div style={footer}>
              <Button
                variant="primary"
                onClick={() => setConfirmSave(true)}
                disabled={!dirty || update.isPending}
                testId="fe7-chatdel-save"
              >
                保存
              </Button>
              {update.isPending ? <span style={tierHint}>保存中…</span> : null}
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        title="削除ポリシーを保存"
        message="メッセージ削除の挙動を保存します。以降の削除操作に適用されます。"
        open={confirmSave}
        onConfirm={save}
        onCancel={() => setConfirmSave(false)}
        testId="fe7-chatdel-save-confirm"
      />
    </Card>
  );
}
