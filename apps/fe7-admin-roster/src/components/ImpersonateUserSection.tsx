// 「このメンバーとして表示」(代理表示 / admin impersonation) for ONE roster user, rendered in
// the roster's inline pane (and so the deep-link detail page too). Shown only to holders of
// identity:impersonate. Ineligible targets keep the button but DISABLED with the reason —
// the same shared rule auth-service enforces (@dub/types `auth.impersonationRefusal`), so a
// greyed button and a 403 never disagree. Confirm → the server swaps the session cookie →
// full reload into the member's view (the shell banner offers 「自分に戻る」).
import { useState } from "react";
import type { identity } from "@dub/types";
import { auth } from "@dub/types";
import { Button, ConfirmDialog } from "@dub/ui";
import { useRosterContext } from "../providers/RosterProvider";
import { usePermissions } from "../hooks/usePermissions";
import { useStartImpersonation, useUser } from "../hooks/useRosterApi";
import { useToast } from "../hooks/useToast";
import { errorMessage, toErrorResponse } from "../lib/errorDisplay";
import styles from "./ImpersonateUserSection.module.css";

function defaultEnter(): void {
  window.location.assign("/");
}

/** The server's refusal label when the 403 carries a known reason, else the generic message. */
function startErrorMessage(err: unknown): string {
  const reason = (toErrorResponse(err)?.error.details as { reason?: string } | undefined)?.reason;
  if (reason && reason in auth.IMPERSONATION_REFUSAL_LABEL) {
    return auth.IMPERSONATION_REFUSAL_LABEL[reason as auth.ImpersonationRefusal];
  }
  return errorMessage(err);
}

export function ImpersonateUserSection({
  user,
  onEntered = defaultEnter,
}: {
  user: identity.IdentityUser;
  /** After the cookie swap (tests inject a spy; production reloads the shell). */
  onEntered?: () => void;
}) {
  const { me } = useRosterContext();
  const { can } = usePermissions();
  const detail = useUser(user.id);
  const start = useStartImpersonation();
  const { toast } = useToast();
  const [confirm, setConfirm] = useState(false);

  if (!me || !can(auth.IMPERSONATE_PERMISSION)) return null;

  // Effective permissions come from the detail read; until it lands the button stays
  // disabled (fail-closed), never briefly enabled for an admin target.
  const perms = detail.data?.permissions;
  const refusal = auth.impersonationRefusal({
    actorId: me.user.id,
    actorImpersonating: Boolean(me.impersonation),
    target: {
      id: user.id,
      status: user.status,
      roleIds: detail.data?.roleIds ?? user.roleIds,
      holdsImpersonate: perms?.includes(auth.IMPERSONATE_PERMISSION) ?? false,
    },
  });
  const loading = !perms && refusal === null;
  const minutes = Math.round(auth.IMPERSONATION_DEFAULT_TTL_SEC / 60);

  async function enter(): Promise<void> {
    try {
      await start.mutateAsync(user.id);
      setConfirm(false);
      onEntered();
    } catch (err) {
      setConfirm(false);
      toast({ kind: "error", title: "代理表示を開始できませんでした", description: startErrorMessage(err) });
    }
  }

  return (
    <div className={styles.section} data-testid="fe7-user-impersonate">
      <span className={styles.title}>このメンバーとして表示</span>
      <p className={styles.help}>
        このメンバーに見えている画面をそのまま確認できます（{minutes}分で自動的に自分に戻ります）。
      </p>
      <div className={styles.actions}>
        <Button
          variant="secondary"
          onClick={() => setConfirm(true)}
          disabled={refusal !== null || loading || start.isPending}
          testId="fe7-user-impersonate-open"
        >
          このメンバーとして表示
        </Button>
      </div>
      {refusal ? (
        <p className={styles.reason} data-testid="fe7-user-impersonate-reason">
          {auth.IMPERSONATION_REFUSAL_LABEL[refusal]}
        </p>
      ) : null}
      <ConfirmDialog
        open={confirm}
        title={`${user.displayName}さんとして表示しますか？`}
        message={
          <>
            <span>{user.displayName}さんの権限で、{minutes}分間アプリを表示します。上部のバナーからいつでも自分に戻れます。</span>
            <ul className={styles.list}>
              <li>表示中の操作はすべてあなたの名前で記録されます</li>
              <li>パスワード・ログイン方法・権限の変更とメール送信はできません</li>
            </ul>
          </>
        }
        confirmLabel="表示する"
        onConfirm={enter}
        onCancel={() => setConfirm(false)}
        testId="fe7-user-impersonate-confirm"
      />
    </div>
  );
}
