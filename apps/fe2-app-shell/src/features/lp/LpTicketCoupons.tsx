// LP管理 → チケット → クーポンカード（無料券のコード発行・一覧・停止/再開）。
//
// 設計メモ:
//  - コードは券と同じ価値を持つので、一覧・発行・停止/再開はすべて販売の公開と同じ lp:publish
//    （GET も publish）。持たない編集者には一覧を取りにいかず、理由だけのカードを出す。
//  - コードはサーバー生成なので発行は楽観的にしない（仮のコードがコピーされる事故を防ぐ）。
//    停止/再開は楽観的 UI（失敗でロールバック + トースト）。削除は無い（注文が参照するため）。
//  - 状態は「使用可 / 上限に達した / 期限切れ / 停止中」を 1 つのバッジで出し、使用数と期限も並べる。
//  - 有料の券種にも発行できる（そのコードで申し込んだ分は 0 円）。ダイアログでそのことを必ず警告する。
//  - ダイアログは body へ portal されるので、中身は @dub/ui と --dub-* トークンだけで描く。
import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  DataTable,
  DatePicker,
  EmptyState,
  ErrorState,
  FormField,
  Icon,
  Modal,
  Select,
  SkeletonLoader,
  Stack,
  TextField,
  useToast,
  type ColumnDef,
} from "@dub/ui";
import type { LpTicketCoupon, LpTicketCouponInput, LpTicketTypeSummary } from "./lpApi.tsx";
import { useCreateTicketCoupon, useLpTicketCoupons, useSetTicketCouponActive } from "./lpTicketsHooks.ts";
import {
  COUPON_ISSUE_LABEL,
  COUPON_LABEL_MAX,
  COUPON_MAX_USES_MAX,
  COUPON_STATE,
  couponState,
  formatDateTime,
  formatPrice,
  isCouponExpired,
  todayJst,
  validateCouponDraft,
  type CouponDraft,
  type CouponDraftErrors,
} from "./lpTickets.ts";
import styles from "./lp.module.css";

const n = (v: number): string => v.toLocaleString("ja-JP");

function typeLabel(t: LpTicketTypeSummary): string {
  return t.dayLabel ? `${t.name} · ${t.dayLabel}` : t.name;
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CodeCell({ coupon }: { coupon: LpTicketCoupon }): JSX.Element {
  const toast = useToast();
  return (
    <div className={styles.urlActions}>
      <code className={styles.couponCode} data-testid={`fe2-lp-coupon-code-${coupon.id}`}>
        {coupon.code}
      </code>
      <Button
        variant="secondary"
        size="sm"
        testId={`fe2-lp-coupon-copy-${coupon.id}`}
        onClick={() => {
          void copyToClipboard(coupon.code).then((ok) =>
            toast.show({
              kind: ok ? "success" : "error",
              title: ok ? `クーポンコード ${coupon.code} をコピーしました` : "コピーに失敗しました（コードを選択して手動でコピーしてください）",
            }),
          );
        }}
      >
        コピー
      </Button>
    </div>
  );
}

/** lp:publish を持たない編集者向け: 一覧は取らず、権限が要ることだけ伝える。 */
export function LpTicketCouponsLockedCard(): JSX.Element {
  return (
    <Card testId="fe2-lp-coupons-locked" header={<span className={styles.sectionTitle}>クーポン</span>}>
      <span className={styles.note} data-testid="fe2-lp-coupons-publish-hint">
        0 円の券種はクーポンコードでのみ申し込めます。クーポンの一覧・{COUPON_ISSUE_LABEL}・停止には lp:publish 権限が必要です。
      </span>
    </Card>
  );
}

/** lp:publish を持つ人だけに描画する（呼び出し側で判定）。 */
export function LpTicketCouponsCard({ types }: { types: LpTicketTypeSummary[] }): JSX.Element {
  const coupons = useLpTicketCoupons(true);
  const create = useCreateTicketCoupon();
  const toggle = useSetTicketCouponActive();
  const [issuing, setIssuing] = useState(false);
  const typeById = useMemo(() => new Map(types.map((t) => [t.id, t])), [types]);
  const rows = coupons.data?.items ?? [];

  const columns: ColumnDef<LpTicketCoupon>[] = useMemo(
    () => [
      { key: "code", header: "コード", minWidth: "14rem", noWrap: true, cell: (c) => <CodeCell coupon={c} /> },
      {
        key: "label",
        header: "用途メモ",
        minWidth: "9rem",
        cell: (c) => (c.label ? <span className={styles.linkName}>{c.label}</span> : <span className={styles.kpiHint}>—</span>),
      },
      {
        key: "type",
        header: "対象券種",
        minWidth: "9rem",
        cell: (c) => {
          const t = typeById.get(c.ticketTypeId);
          return (
            <Stack gap={1}>
              <span data-testid={`fe2-lp-coupon-type-${c.id}`}>{t ? typeLabel(t) : "（不明な券種）"}</span>
              {t && t.priceJpy > 0 ? (
                <span className={styles.kpiHint} data-testid={`fe2-lp-coupon-paid-type-${c.id}`}>
                  通常 {formatPrice(t.priceJpy)} → このコードなら無料
                </span>
              ) : null}
            </Stack>
          );
        },
      },
      {
        key: "used",
        header: "使用（枚）",
        align: "right",
        width: "8rem",
        noWrap: true,
        cell: (c) => (
          <Stack gap={1}>
            <span className={styles.num} data-testid={`fe2-lp-coupon-used-${c.id}`}>
              {n(c.used)} / {n(c.maxUses)}
            </span>
            <span className={styles.kpiHint}>残り {n(Math.max(0, c.maxUses - c.used))} 枚</span>
          </Stack>
        ),
      },
      {
        key: "expires",
        header: "期限",
        width: "10rem",
        noWrap: true,
        cell: (c) => (
          <span className={styles.num} data-testid={`fe2-lp-coupon-expires-${c.id}`}>
            {c.expiresAt ? `${formatDateTime(c.expiresAt)} まで` : "期限なし"}
          </span>
        ),
      },
      {
        key: "state",
        header: "状態",
        width: "8rem",
        noWrap: true,
        cell: (c) => {
          const s = COUPON_STATE[couponState(c)];
          const pending = toggle.isPending && toggle.variables?.id === c.id;
          // 期限切れは再開しても使えないので、再開ボタンは出さない（停止は出す）。
          const canResume = !isCouponExpired(c);
          return (
            <Stack gap={2}>
              <Badge tone={s.tone} testId={`fe2-lp-coupon-state-${c.id}`}>
                {s.label}
              </Badge>
              {c.active || canResume ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  testId={`fe2-lp-coupon-toggle-${c.id}`}
                  onClick={() => toggle.mutate({ id: c.id, active: !c.active })}
                >
                  {c.active ? "停止する" : "再開する"}
                </Button>
              ) : null}
            </Stack>
          );
        },
      },
    ],
    [typeById, toggle],
  );

  let content: JSX.Element;
  if (coupons.isLoading) {
    content = (
      <div data-testid="fe2-lp-coupons-loading">
        <SkeletonLoader lines={4} />
      </div>
    );
  } else if (coupons.isError) {
    content = (
      <ErrorState
        testId="fe2-lp-coupons-error"
        error={{ code: "INTERNAL", message: "クーポンを読み込めませんでした。" }}
        onRetry={() => void coupons.refetch()}
      />
    );
  } else if (rows.length === 0) {
    content = (
      <EmptyState
        testId="fe2-lp-coupons-empty"
        icon="hash"
        title="まだクーポンはありません"
        description={`「${COUPON_ISSUE_LABEL}」から、招待・登壇者向けなどの無料券のコードを作れます。`}
      />
    );
  } else {
    content = <DataTable<LpTicketCoupon> testId="fe2-lp-coupons-table" columns={columns} rows={rows} rowKey={(c) => c.id} />;
  }

  return (
    <Card
      testId="fe2-lp-coupons"
      header={
        <div className={styles.cardHeaderRow}>
          <span className={styles.sectionTitle}>クーポン</span>
          <Button
            variant="secondary"
            size="sm"
            iconLeft={<Icon name="plus" />}
            disabled={types.length === 0}
            onClick={() => setIssuing(true)}
            testId="fe2-lp-coupon-issue"
          >
            {COUPON_ISSUE_LABEL}
          </Button>
        </div>
      }
    >
      <Stack gap={5}>
        <span className={styles.note}>
          0 円の券種はクーポンコードでのみ申し込めます。コードを招待者に渡し、購入ページで入力してもらいます。1 つのコードで使える枚数と期限を決められます。
        </span>
        {content}
      </Stack>
      {issuing ? (
        <CouponDialog
          types={types}
          saving={create.isPending}
          onCancel={() => setIssuing(false)}
          onSubmit={(input) => create.mutate(input, { onSuccess: () => setIssuing(false) })}
        />
      ) : null}
    </Card>
  );
}

function defaultTypeId(types: LpTicketTypeSummary[]): string {
  return (types.find((t) => t.priceJpy === 0 && t.active) ?? types.find((t) => t.priceJpy === 0) ?? types[0])?.id ?? "";
}

function CouponDialog({
  types,
  saving,
  onCancel,
  onSubmit,
}: {
  types: LpTicketTypeSummary[];
  saving: boolean;
  onCancel: () => void;
  onSubmit: (input: LpTicketCouponInput) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<CouponDraft>(() => ({ ticketTypeId: defaultTypeId(types), maxUses: "1", label: "", expiresOn: null }));
  const [errors, setErrors] = useState<CouponDraftErrors>({});
  const set = (patch: Partial<CouponDraft>): void => {
    setDraft((d) => ({ ...d, ...patch }));
    setErrors({});
  };
  const submit = (): void => {
    const result = validateCouponDraft(draft);
    setErrors(result.errors);
    if (result.input) onSubmit(result.input);
  };
  const err = (k: keyof CouponDraftErrors) => (errors[k] ? { error: errors[k] } : {});
  const selected = types.find((t) => t.id === draft.ticketTypeId);
  const options = types.map((t) => ({
    value: t.id,
    label: `${typeLabel(t)}（${formatPrice(t.priceJpy)}${t.active ? "" : "・販売停止中"}）`,
  }));
  const hint = { color: "var(--dub-color-text-muted)", fontSize: "var(--dub-font-size-sm)", lineHeight: "var(--dub-font-lineHeight-relaxed)" };

  return (
    <Modal
      open
      onClose={onCancel}
      title={COUPON_ISSUE_LABEL}
      size="md"
      testId="fe2-lp-coupon-dialog"
      footer={
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--dub-space-3)" }}>
          <Button variant="secondary" onClick={onCancel} testId="fe2-lp-coupon-cancel">
            キャンセル
          </Button>
          <Button variant="primary" loading={saving} onClick={submit} testId="fe2-lp-coupon-save">
            発行する
          </Button>
        </div>
      }
    >
      <div style={{ display: "grid", gap: "var(--dub-space-5)" }}>
        <span style={hint}>コードは自動で作られます（英大文字と数字 10 文字）。発行後に一覧からコピーして渡してください。</span>
        <FormField label="対象の券種" htmlFor="fe2-lp-coupon-type" required help="このコードで申し込める券種です（1 コード = 1 券種）" {...err("ticketTypeId")}>
          <Select id="fe2-lp-coupon-type" testId="fe2-lp-coupon-type" value={draft.ticketTypeId || null} options={options} placeholder="券種を選ぶ" onChange={(v) => set({ ticketTypeId: v })} />
        </FormField>
        {selected && selected.priceJpy > 0 ? (
          <p
            role="alert"
            data-testid="fe2-lp-coupon-paid-warning"
            style={{
              margin: 0,
              padding: "var(--dub-space-3) var(--dub-space-4)",
              border: "1px solid var(--dub-color-warning-200)",
              borderRadius: "var(--dub-radius-sm)",
              background: "var(--dub-color-warning-50)",
              color: "var(--dub-color-warning-700)",
              fontSize: "var(--dub-font-size-sm)",
              lineHeight: "var(--dub-font-lineHeight-relaxed)",
            }}
          >
            有料の券種（{formatPrice(selected.priceJpy)}）です。このコードで申し込んだ分は 0 円になり、売上には入りません。
          </p>
        ) : null}
        <FormField
          label="使える枚数"
          htmlFor="fe2-lp-coupon-max"
          required
          help={`このコードで申し込める合計枚数（1〜${n(COUPON_MAX_USES_MAX)}）。1 人 1 枚なら配る人数分`}
          {...err("maxUses")}
        >
          <TextField id="fe2-lp-coupon-max" testId="fe2-lp-coupon-max" type="number" value={draft.maxUses} placeholder="1" onChange={(v) => set({ maxUses: v })} />
        </FormField>
        <FormField label="用途メモ" htmlFor="fe2-lp-coupon-label" help={`任意・管理用（購入者には見えません）。${COUPON_LABEL_MAX}文字以内`} {...err("label")}>
          <TextField id="fe2-lp-coupon-label" testId="fe2-lp-coupon-label" value={draft.label} placeholder="登壇者向け" onChange={(v) => set({ label: v })} />
        </FormField>
        <FormField label="期限" htmlFor="fe2-lp-coupon-expires" help="任意・空欄 = 期限なし。選んだ日の 23:59（日本時間）まで使えます" {...err("expiresOn")}>
          <DatePicker id="fe2-lp-coupon-expires" testId="fe2-lp-coupon-expires" value={draft.expiresOn} min={todayJst()} onChange={(v) => set({ expiresOn: v })} />
        </FormField>
      </div>
    </Modal>
  );
}
