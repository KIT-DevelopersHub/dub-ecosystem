// メールの詳細設定ダイアログに出す「別のロール宛てのメールも閲覧」。選んだロールの人宛てに
// 届いたメールを、このロールの人も見られるようにする（一方向。相手側からは見えない）。
// 同じロール内の相互閲覧は細かい権限 mail:read_role_shared のまま、ここは別ロール専用。
import { Badge, Button, SkeletonList, Switch } from "@dub/ui";
import { useRoles } from "../hooks/useRosterApi";

const listStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--dub-space-2, 8px)" };
const rowStyle: React.CSSProperties = {
  padding: "var(--dub-space-3, 12px)",
  border: "1px solid var(--dub-color-border-default, #dde1e9)",
  borderRadius: "var(--dub-radius-md, 6px)",
};
const rowOnStyle: React.CSSProperties = {
  background: "var(--dub-color-success-50, #ecfdf3)",
  borderColor: "var(--dub-color-success-200, #abefc6)",
};
const hintStyle: React.CSSProperties = { color: "var(--dub-color-text-muted, #6f7a90)", fontSize: 12.5, lineHeight: 1.6, margin: 0 };
const toolbarStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: "var(--dub-space-2, 8px)" };

export function MailCrossRoleSection({
  roleId,
  value,
  onChange,
  disabled,
  idPrefix = "fe7",
}: {
  /** 編集中のロール（自分自身は候補から外す）。作成画面では未定。 */
  roleId?: string;
  value: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  idPrefix?: string;
}) {
  const roles = useRoles();
  const ns = `${idPrefix}-mail-cross-role`;

  if (roles.isPending) return <SkeletonList rows={3} testId={`${ns}-loading`} />;
  if (roles.isError) return <p style={hintStyle}>ロール一覧を読み込めませんでした。</p>;

  const candidates = roles.data.items.filter((r) => r.id !== roleId);
  const selected = new Set(value);
  const allOn = candidates.length > 0 && candidates.every((r) => selected.has(r.id));
  const toggle = (id: string) => onChange(selected.has(id) ? value.filter((v) => v !== id) : [...value, id]);

  return (
    <div style={listStyle} data-testid={ns}>
      <p style={hintStyle}>
        オンにしたロールの人宛てに届いたメールを、このロールの人も閲覧できます（受信メールのみ・一方向で、相手のロールからこのロールのメールは見えません）。同じロール内で見せ合う設定は上の「同じロールの人宛てのメールを閲覧」です。
      </p>
      {candidates.length === 0 ? (
        <p style={hintStyle} data-testid={`${ns}-empty`}>ほかのロールがありません。</p>
      ) : (
        <>
          <div style={toolbarStyle}>
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled}
              onClick={() => onChange(allOn ? [] : candidates.map((r) => r.id))}
              testId={`${ns}-all`}
            >
              {allOn ? "すべて外す" : "すべてのロールを選ぶ"}
            </Button>
            <span style={hintStyle} data-testid={`${ns}-count`}>
              {selected.size} / {candidates.length} ロール
            </span>
          </div>
          {candidates.map((r) => {
            const on = selected.has(r.id);
            return (
              <div key={r.id} style={{ ...rowStyle, ...(on ? rowOnStyle : null) }} data-testid={`${ns}-row-${r.id}`}>
                <Switch
                  id={`${ns}-${r.id}`}
                  checked={on}
                  disabled={disabled}
                  onChange={() => toggle(r.id)}
                  testId={`${ns}-toggle-${r.id}`}
                  label={
                    <span style={{ fontWeight: 600 }}>
                      {r.name}宛てのメール {r.isSystem ? <Badge tone="neutral">標準</Badge> : null}
                    </span>
                  }
                />
              </div>
            );
          })}
          <p style={hintStyle}>
            「すべてのロールを選ぶ」は今あるロールだけが対象です。あとから作ったロールは自動では入りません。送信済みメールも含めて全員分を常に見せたい場合は「全メールの閲覧（監督）」を使ってください。
          </p>
        </>
      )}
    </div>
  );
}
