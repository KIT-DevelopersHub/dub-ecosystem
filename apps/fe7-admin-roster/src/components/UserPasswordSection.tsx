// Admin password management for a single roster user (#5a set/re-issue, #5c view),
// rendered inside UserInlineEditor. Admin-only surface (the caller gates on
// identity:admin). Two flows:
//   - 初期パスワードの発行/設定: auto-generate a strong password OR specify one. A
//     generated password is shown EXACTLY ONCE (it is never re-fetchable) with copy.
//   - パスワードを表示: reveal the current password (decrypted + audited server-side).
//     Gated behind a confirm dialog and a 要注意 warning; hidden again on demand.
//
// Design: sensitive values stay collapsed by default (控えめ), every reveal is
// confirm-gated, and revealed plaintext is visually flagged so it is never mistaken
// for ambient UI. The plaintext is held only in local state and dropped on unmount.
import { useState } from "react";
import type { identity } from "@dub/types";
import { Button, TextField, ConfirmDialog, FormField, Divider } from "@dub/ui";
import { useSetUserPassword, useViewUserPassword } from "../hooks/useRosterApi";
import { useToast } from "../hooks/useToast";
import { errorMessage } from "../lib/errorDisplay";

const sectionStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--dub-space-3)" };
const titleStyle: React.CSSProperties = { fontWeight: 600, fontSize: "var(--dub-font-size-sm)" };
const helpStyle: React.CSSProperties = { color: "var(--dub-color-text-muted)", fontSize: 13, margin: 0 };
const actionsStyle: React.CSSProperties = { display: "flex", gap: "var(--dub-space-2)", flexWrap: "wrap", alignItems: "flex-end" };
const secretBoxStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--dub-space-2)",
  padding: "var(--dub-space-3)",
  borderRadius: "var(--dub-radius-md)",
  border: "1px solid var(--dub-color-warning-300)",
  background: "var(--dub-color-warning-50)",
};
const secretRowStyle: React.CSSProperties = { display: "flex", gap: "var(--dub-space-2)", alignItems: "center", flexWrap: "wrap" };
const secretValueStyle: React.CSSProperties = {
  fontFamily: "var(--dub-font-family-mono)",
  fontSize: "var(--dub-font-size-sm)",
  padding: "4px 8px",
  borderRadius: 6,
  background: "var(--dub-color-surface-base)",
  border: "1px solid var(--dub-color-border-default)",
  userSelect: "all",
  wordBreak: "break-all",
};
const warnLabelStyle: React.CSSProperties = { color: "var(--dub-color-warning-700)", fontSize: "var(--dub-font-size-xs)", fontWeight: 600 };

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function UserPasswordSection({ user }: { user: identity.IdentityUser }) {
  const setPw = useSetUserPassword(user.id);
  const viewPw = useViewUserPassword(user.id);
  const { toast } = useToast();

  const [specify, setSpecify] = useState("");
  const [issued, setIssued] = useState<string | null>(null); // one-time generated password
  const [revealed, setRevealed] = useState<string | null>(null); // viewed current password
  const [viewConfirm, setViewConfirm] = useState(false);

  async function onCopy(value: string) {
    const ok = await copy(value);
    toast(ok ? { kind: "success", title: "コピーしました" } : { kind: "error", title: "コピーに失敗しました" });
  }

  function generate() {
    setRevealed(null);
    setPw.mutate(
      { generate: true },
      {
        onSuccess: (res) => {
          setIssued(res.password ?? null);
          toast({ kind: "success", title: "初期パスワードを発行しました" });
        },
        onError: (err) => toast({ kind: "error", title: "発行に失敗しました", description: errorMessage(err) }),
      },
    );
  }

  function applySpecified() {
    const pw = specify.trim();
    if (pw.length < 8) {
      toast({ kind: "error", title: "8文字以上で指定してください" });
      return;
    }
    setRevealed(null);
    setPw.mutate(
      { password: pw, mustChange: true },
      {
        onSuccess: () => {
          setIssued(null);
          setSpecify("");
          toast({ kind: "success", title: "パスワードを設定しました" });
        },
        onError: (err) => toast({ kind: "error", title: "設定に失敗しました", description: errorMessage(err) }),
      },
    );
  }

  function confirmView() {
    setViewConfirm(false);
    setIssued(null);
    viewPw.mutate(undefined, {
      onSuccess: (res) => setRevealed(res.password),
      onError: (err) => toast({ kind: "error", title: "表示できませんでした", description: errorMessage(err) }),
    });
  }

  return (
    <div style={sectionStyle} data-testid={`fe7-user-password-${user.id}`}>
      <Divider />
      <span style={titleStyle}>ログインパスワード</span>
      <p style={helpStyle}>
        同期直後のユーザーには初期パスワードがありません。ここで発行して本人に手渡してください。
      </p>

      {/* Issue / set */}
      <div style={actionsStyle}>
        <Button
          variant="primary"
          onClick={generate}
          loading={setPw.isPending}
          testId="fe7-user-password-generate"
        >
          初期パスワードを発行
        </Button>
        <FormField label="パスワードを指定（任意・8文字以上）" htmlFor={`fe7-user-password-specify-${user.id}`}>
          <TextField
            id={`fe7-user-password-specify-${user.id}`}
            value={specify}
            onChange={setSpecify}
            type="text"
            placeholder="指定する場合のみ入力"
            testId="fe7-user-password-specify"
          />
        </FormField>
        <Button
          variant="secondary"
          onClick={applySpecified}
          disabled={setPw.isPending || specify.trim().length === 0}
          testId="fe7-user-password-set"
        >
          設定
        </Button>
      </div>

      {/* One-time issued password */}
      {issued ? (
        <div style={secretBoxStyle} data-testid="fe7-user-password-issued">
          <span style={warnLabelStyle}>この画面を閉じると再表示できません。今すぐ控えてください。</span>
          <div style={secretRowStyle}>
            <code style={secretValueStyle}>{issued}</code>
            <Button variant="secondary" size="sm" onClick={() => onCopy(issued)} testId="fe7-user-password-issued-copy">
              コピー
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setIssued(null)} testId="fe7-user-password-issued-dismiss">
              閉じる
            </Button>
          </div>
        </div>
      ) : null}

      {/* View current */}
      <div style={actionsStyle}>
        {revealed ? (
          <div style={secretBoxStyle} data-testid="fe7-user-password-revealed">
            <span style={warnLabelStyle}>現在のパスワード（取り扱い注意）</span>
            <div style={secretRowStyle}>
              <code style={secretValueStyle}>{revealed}</code>
              <Button variant="secondary" size="sm" onClick={() => onCopy(revealed)} testId="fe7-user-password-revealed-copy">
                コピー
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setRevealed(null)} testId="fe7-user-password-hide">
                隠す
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="secondary"
            onClick={() => setViewConfirm(true)}
            loading={viewPw.isPending}
            testId="fe7-user-password-view"
          >
            パスワードを表示
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={viewConfirm}
        title="パスワードを表示"
        message="現在のパスワードを平文で表示します。この操作は監査ログに記録されます。よろしいですか？"
        danger
        confirmLabel="表示する"
        onConfirm={confirmView}
        onCancel={() => setViewConfirm(false)}
        testId="fe7-user-password-view-confirm"
      />
    </div>
  );
}
