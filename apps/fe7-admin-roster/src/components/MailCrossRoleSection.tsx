// メールの詳細設定ダイアログに出す「別のロール宛てのメールも閲覧」。選んだロールの人宛てに
// 届いたメールを、このロールの人も見られるようにする（一方向。相手側からは見えない）。
// 同じロール内の相互閲覧は細かい権限 mail:read_role_shared のまま、ここは別ロール専用。
// 行の見た目は「細かい権限」と同じ ToggleRow を使う。
import { Button, SkeletonList } from "@dub/ui";
import { useRoles } from "../hooks/useRosterApi";
import { ToggleRow, toggleListStyle } from "./PermissionToggleList";

const headerStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: "var(--dub-space-2, 8px)" };
const headingStyle: React.CSSProperties = { fontWeight: 700, fontSize: 14, margin: 0, flex: 1 };
const hintStyle: React.CSSProperties = { color: "var(--dub-color-text-muted, #6f7a90)", fontSize: 12.5, lineHeight: 1.6, margin: 0 };
const countStyle: React.CSSProperties = { color: "var(--dub-color-text-muted, #6f7a90)", fontSize: 12.5 };

export function MailCrossRoleSection({
  roleId,
  value,
  onChange,
  disabled,
  locked,
  idPrefix = "fe7",
}: {
  /** 編集中のロール（自分自身は候補から外す）。作成画面では未定。 */
  roleId?: string;
  value: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** メールアプリが「無効」= 説明文の代わりに案内を出す. */
  locked?: boolean;
  idPrefix?: string;
}) {
  const roles = useRoles();
  const ns = `${idPrefix}-mail-cross-role`;
  const candidates = roles.data?.items.filter((r) => r.id !== roleId) ?? [];
  const selected = new Set(value);
  const allOn = candidates.length > 0 && candidates.every((r) => selected.has(r.id));
  const toggle = (id: string) => onChange(selected.has(id) ? value.filter((v) => v !== id) : [...value, id]);

  return (
    <div style={toggleListStyle} data-testid={ns}>
      <div style={headerStyle}>
        <h3 style={headingStyle}>別のロール宛てのメールも閲覧</h3>
        {candidates.length > 0 ? (
          <>
            <span style={countStyle} data-testid={`${ns}-count`}>
              {selected.size} / {candidates.length} ロール
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => onChange(allOn ? [] : candidates.map((r) => r.id))}
              testId={`${ns}-all`}
            >
              {allOn ? "すべて外す" : "すべて選ぶ"}
            </Button>
          </>
        ) : null}
      </div>
      {locked ? (
        <p style={hintStyle} data-testid={`${ns}-locked`}>
          このアプリは「無効」です。使うには、上の権限を「閲覧」以上にしてください。
        </p>
      ) : (
        <p style={hintStyle}>オンにしたロール宛ての受信メールも読めます（相手からは見えません）。</p>
      )}
      {roles.isPending ? (
        <SkeletonList rows={3} testId={`${ns}-loading`} />
      ) : roles.isError ? (
        <p style={hintStyle}>ロール一覧を読み込めませんでした。</p>
      ) : candidates.length === 0 ? (
        <p style={hintStyle} data-testid={`${ns}-empty`}>ほかのロールがありません。</p>
      ) : (
        candidates.map((r) => (
          <ToggleRow
            key={r.id}
            id={`${ns}-${r.id}`}
            testIdPrefix={ns}
            testIdKey={r.id}
            checked={selected.has(r.id)}
            disabled={disabled}
            onChange={() => toggle(r.id)}
            title={r.name}
          />
        ))
      )}
    </div>
  );
}
