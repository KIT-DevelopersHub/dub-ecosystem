// LP管理 → チケット → 券種カード（一覧 + 販売中トグル + 追加/編集ダイアログ）。
// ダイアログは body へ portal されるので、中身は @dub/ui と --dub-* トークンだけで描く
// （lp.module.css の変数/クラスは効かない前提）。
import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  FormField,
  Icon,
  Modal,
  Stack,
  Switch,
  TextField,
  Textarea,
  type ColumnDef,
} from "@dub/ui";
import type { LpTicketTypeSummary } from "./lpApi.tsx";
import { useSaveTicketType } from "./lpTicketsHooks.ts";
import {
  NO_DAY_LABEL,
  TICKET_DAY_LABEL_MAX,
  TICKET_DESCRIPTION_MAX,
  TICKET_MAX_PER_ORDER_DEFAULT,
  TICKET_MAX_PER_ORDER_MAX,
  TICKET_NAME_MAX,
  TICKET_PRICE_MIN_PAID,
  COUPON_ONLY_NOTE,
  formatPrice,
  formatYen,
  groupTicketTypesByDay,
  validateTicketType,
  type TicketTypeDraft,
  type TicketTypeDraftErrors,
} from "./lpTickets.ts";
import styles from "./lp.module.css";

const EMPTY_DRAFT: TicketTypeDraft = {
  name: "",
  description: "",
  price: "",
  capacity: "",
  dayLabel: "",
  maxPerOrder: String(TICKET_MAX_PER_ORDER_DEFAULT),
  active: true,
};

function draftOf(t: LpTicketTypeSummary): TicketTypeDraft {
  return {
    name: t.name,
    description: t.description,
    price: String(t.priceJpy),
    capacity: t.capacity === null ? "" : String(t.capacity),
    dayLabel: t.dayLabel,
    maxPerOrder: String(t.maxPerOrder),
    active: t.active,
  };
}

const isOptimistic = (t: LpTicketTypeSummary): boolean => t.id.startsWith("optimistic:");
const n = (v: number): string => v.toLocaleString("ja-JP");

export function LpTicketTypesCard({
  types,
  canEdit,
}: {
  types: LpTicketTypeSummary[];
  canEdit: boolean;
}): JSX.Element {
  const save = useSaveTicketType();
  // undefined = 閉じている / null = 新規 / 券種 = その券種を編集
  const [editing, setEditing] = useState<LpTicketTypeSummary | null | undefined>(undefined);
  const groups = useMemo(() => groupTicketTypesByDay(types), [types]);
  // 全券種が日付なしなら見出しは出さない（v1 と同じ 1 枚の表）。
  const showGroups = groups.some((g) => g.dayLabel !== "");
  const dayLabels = useMemo(() => groups.map((g) => g.dayLabel).filter((d) => d !== ""), [groups]);

  const columns: ColumnDef<LpTicketTypeSummary>[] = useMemo(
    () => [
      {
        key: "name",
        header: "券種",
        minWidth: "12rem",
        cell: (t) => (
          <Stack gap={1}>
            <span className={styles.linkName}>{t.name}</span>
            {t.description ? <span className={styles.kpiHint}>{t.description}</span> : null}
            <span className={styles.kpiHint} data-testid={`fe2-lp-ticket-type-max-${t.id}`}>
              1 回の購入で最大 {n(t.maxPerOrder)} 枚
            </span>
          </Stack>
        ),
      },
      {
        key: "price",
        header: "価格（1 枚）",
        align: "right",
        width: "8rem",
        noWrap: true,
        cell: (t) =>
          t.priceJpy === 0 ? (
            <Stack gap={1}>
              <span className={styles.num}>{formatPrice(t.priceJpy)}</span>
              <span className={styles.kpiHint} data-testid={`fe2-lp-ticket-type-coupon-only-${t.id}`}>
                クーポン専用
              </span>
            </Stack>
          ) : (
            <span className={styles.num}>{formatPrice(t.priceJpy)}</span>
          ),
      },
      {
        key: "capacity",
        header: "定員（枚）",
        align: "right",
        width: "6rem",
        noWrap: true,
        cell: (t) => <span className={styles.num}>{t.capacity === null ? "—" : n(t.capacity)}</span>,
      },
      {
        key: "sold",
        header: "販売 / 残り（枚）",
        align: "right",
        width: "10rem",
        noWrap: true,
        cell: (t) => (
          <Stack gap={1}>
            <span className={styles.num} data-testid={`fe2-lp-ticket-type-sold-${t.id}`}>
              {n(t.stats.sold)} / {t.stats.remaining === null ? "無制限" : n(t.stats.remaining)}
            </span>
            {t.stats.pending > 0 ? (
              <span className={styles.kpiHint} data-testid={`fe2-lp-ticket-type-pending-${t.id}`}>
                決済待ち {n(t.stats.pending)} 枚
              </span>
            ) : null}
          </Stack>
        ),
      },
      {
        key: "revenue",
        header: "売上",
        align: "right",
        width: "8rem",
        noWrap: true,
        cell: (t) => <span className={styles.num}>{formatYen(t.stats.revenueJpy)}</span>,
      },
      {
        key: "active",
        header: "販売中",
        width: "8rem",
        noWrap: true,
        cell: (t) =>
          canEdit ? (
            <Switch
              id={`fe2-lp-ticket-type-active-${t.id}`}
              testId={`fe2-lp-ticket-type-active-${t.id}`}
              checked={t.active}
              disabled={isOptimistic(t)}
              label={t.active ? "販売中" : "停止中"}
              onChange={(active) =>
                save.mutate({ id: t.id, input: { active }, toast: active ? `「${t.name}」の販売を再開しました` : `「${t.name}」の販売を停止しました` })
              }
            />
          ) : (
            <Badge tone={t.active ? "success" : "neutral"} testId={`fe2-lp-ticket-type-state-${t.id}`}>
              {t.active ? "販売中" : "停止中"}
            </Badge>
          ),
      },
      ...(canEdit
        ? [
            {
              key: "actions",
              header: "",
              width: "6rem",
              noWrap: true,
              hideable: false,
              cell: (t: LpTicketTypeSummary) => (
                <Button
                  variant="ghost"
                  size="sm"
                  iconLeft={<Icon name="edit" />}
                  disabled={isOptimistic(t)}
                  onClick={() => setEditing(t)}
                  testId={`fe2-lp-ticket-type-edit-${t.id}`}
                >
                  編集
                </Button>
              ),
            },
          ]
        : []),
    ],
    [canEdit, save],
  );

  return (
    <Card
      testId="fe2-lp-ticket-types"
      header={
        <div className={styles.cardHeaderRow}>
          <span className={styles.sectionTitle}>券種</span>
          {canEdit ? (
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<Icon name="plus" />}
              onClick={() => setEditing(null)}
              testId="fe2-lp-ticket-type-add"
            >
              券種を追加
            </Button>
          ) : null}
        </div>
      }
    >
      {types.length === 0 ? (
        <EmptyState
          testId="fe2-lp-ticket-types-empty"
          icon="flag"
          title="まだ券種がありません"
          description={canEdit ? "「券種を追加」から一般・学生などの券種を作ると、購入ページに並びます。" : "編集権限を持つ人が券種を追加すると、ここに並びます。"}
        />
      ) : (
        <Stack gap={5} testId="fe2-lp-ticket-types-table">
          <span className={styles.note}>
            販売数・残り・定員はすべて「枚数」です（1 回の購入で複数枚・複数の券種を買えます）。対象日が同じ券種は購入ページでもまとめて表示されます。
          </span>
          {showGroups ? (
            groups.map((g, i) => (
              <section key={g.dayLabel || "__none__"} className={styles.ticketDayGroup} data-testid={`fe2-lp-ticket-day-group-${i}`}>
                <div className={styles.ticketDayHeader}>
                  <Badge tone={g.dayLabel ? "brand" : "neutral"}>{g.dayLabel || NO_DAY_LABEL}</Badge>
                  <span className={styles.kpiHint} data-testid={`fe2-lp-ticket-day-group-total-${i}`}>
                    販売 {n(g.sold)} 枚 · 売上 {formatYen(g.revenueJpy)}
                  </span>
                </div>
                <DataTable<LpTicketTypeSummary> columns={columns} rows={g.types} rowKey={(t) => t.id} />
              </section>
            ))
          ) : (
            <DataTable<LpTicketTypeSummary> columns={columns} rows={types} rowKey={(t) => t.id} />
          )}
        </Stack>
      )}
      {editing !== undefined ? (
        <TicketTypeDialog
          target={editing}
          dayLabels={dayLabels}
          onCancel={() => setEditing(undefined)}
          onSubmit={(input) => {
            setEditing(undefined);
            save.mutate(editing ? { id: editing.id, input } : { input });
          }}
        />
      ) : null}
    </Card>
  );
}

function TicketTypeDialog({
  target,
  dayLabels,
  onCancel,
  onSubmit,
}: {
  target: LpTicketTypeSummary | null;
  /** 既存の対象日（表記ゆれで別グループに割れないよう、選んで入れられるようにする）。 */
  dayLabels: string[];
  onCancel: () => void;
  onSubmit: (input: NonNullable<ReturnType<typeof validateTicketType>["input"]>) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<TicketTypeDraft>(() => (target ? draftOf(target) : EMPTY_DRAFT));
  const [errors, setErrors] = useState<TicketTypeDraftErrors>({});
  const set = (patch: Partial<TicketTypeDraft>): void => {
    setDraft((d) => ({ ...d, ...patch }));
    setErrors({});
  };
  const submit = (): void => {
    const result = validateTicketType(draft);
    setErrors(result.errors);
    if (result.input) onSubmit(result.input);
  };
  const err = (k: keyof TicketTypeDraftErrors) => (errors[k] ? { error: errors[k] } : {});

  return (
    <Modal
      open
      onClose={onCancel}
      title={target ? "券種を編集" : "券種を追加"}
      size="md"
      testId="fe2-lp-ticket-type-dialog"
      footer={
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--dub-space-3)" }}>
          <Button variant="secondary" onClick={onCancel} testId="fe2-lp-ticket-type-cancel">
            キャンセル
          </Button>
          <Button variant="primary" onClick={submit} testId="fe2-lp-ticket-type-save">
            {target ? "保存" : "追加"}
          </Button>
        </div>
      }
    >
      <div style={{ display: "grid", gap: "var(--dub-space-5)" }}>
        <FormField label="券種名" htmlFor="fe2-lp-ticket-type-name" required help={`購入ページに出る名前です（${TICKET_NAME_MAX}文字以内）`} {...err("name")}>
          <TextField id="fe2-lp-ticket-type-name" testId="fe2-lp-ticket-type-name" value={draft.name} placeholder="一般" onChange={(v) => set({ name: v })} />
        </FormField>
        <FormField
          label="対象日"
          htmlFor="fe2-lp-ticket-type-day"
          help={`空欄 = 通し・共通（日付なし）。同じ対象日の券種は購入ページでまとめて並びます（${TICKET_DAY_LABEL_MAX}文字以内）`}
          {...err("dayLabel")}
        >
          <div style={{ display: "grid", gap: "var(--dub-space-2)" }}>
            <TextField
              id="fe2-lp-ticket-type-day"
              testId="fe2-lp-ticket-type-day"
              value={draft.dayLabel}
              placeholder="Day 1 · 9/13(月)"
              onChange={(v) => set({ dayLabel: v })}
            />
            {dayLabels.length > 0 ? (
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--dub-space-2)" }}>
                <span style={{ color: "var(--dub-color-text-muted)", fontSize: "var(--dub-font-size-xs)" }}>既存の対象日:</span>
                {dayLabels.map((d, i) => (
                  <Button
                    key={d}
                    variant={draft.dayLabel.trim() === d ? "primary" : "secondary"}
                    size="sm"
                    onClick={() => set({ dayLabel: d })}
                    testId={`fe2-lp-ticket-type-day-pick-${i}`}
                  >
                    {d}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
        </FormField>
        <FormField label="説明" htmlFor="fe2-lp-ticket-type-description" help={`任意・${TICKET_DESCRIPTION_MAX}文字以内`} {...err("description")}>
          <Textarea
            id="fe2-lp-ticket-type-description"
            testId="fe2-lp-ticket-type-description"
            value={draft.description}
            rows={3}
            onChange={(v) => set({ description: v })}
          />
        </FormField>
        <FormField
          label="価格（円）"
          htmlFor="fe2-lp-ticket-type-price"
          required
          help={`0 = 無料（決済なし・クーポンコードで申し込む券種）。有料は ${TICKET_PRICE_MIN_PAID} 円以上`}
          {...err("price")}
        >
          <div style={{ display: "grid", gap: "var(--dub-space-2)" }}>
            <TextField id="fe2-lp-ticket-type-price" testId="fe2-lp-ticket-type-price" type="number" value={draft.price} placeholder="3000" onChange={(v) => set({ price: v })} />
            {draft.price.trim() !== "" && Number(draft.price.trim()) === 0 ? (
              <p
                data-testid="fe2-lp-ticket-type-coupon-note"
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "var(--dub-space-2)",
                  margin: 0,
                  padding: "var(--dub-space-3) var(--dub-space-4)",
                  border: "1px solid var(--dub-color-border-default)",
                  borderRadius: "var(--dub-radius-sm)",
                  background: "var(--dub-color-surface-sunken)",
                  color: "var(--dub-color-text-secondary)",
                  fontSize: "var(--dub-font-size-sm)",
                  lineHeight: "var(--dub-font-lineHeight-relaxed)",
                }}
              >
                <Icon name="info" />
                <span>{COUPON_ONLY_NOTE}。コードは「クーポン」欄から発行して招待者に渡してください。</span>
              </p>
            ) : null}
          </div>
        </FormField>
        <FormField label="定員（枚）" htmlFor="fe2-lp-ticket-type-capacity" help="この券種で売る合計枚数。空欄 = 無制限" {...err("capacity")}>
          <TextField id="fe2-lp-ticket-type-capacity" testId="fe2-lp-ticket-type-capacity" type="number" value={draft.capacity} placeholder="無制限" onChange={(v) => set({ capacity: v })} />
        </FormField>
        <FormField
          label="1 回の購入上限（枚）"
          htmlFor="fe2-lp-ticket-type-max"
          required
          help={`1 人が 1 回の購入でこの券種を何枚まで買えるか（1〜${TICKET_MAX_PER_ORDER_MAX}）。1 回の購入の合計は全券種で最大 ${TICKET_MAX_PER_ORDER_MAX} 枚`}
          {...err("maxPerOrder")}
        >
          <TextField
            id="fe2-lp-ticket-type-max"
            testId="fe2-lp-ticket-type-max"
            type="number"
            value={draft.maxPerOrder}
            placeholder={String(TICKET_MAX_PER_ORDER_DEFAULT)}
            onChange={(v) => set({ maxPerOrder: v })}
          />
        </FormField>
        <Switch
          id="fe2-lp-ticket-type-active"
          testId="fe2-lp-ticket-type-active"
          checked={draft.active}
          label="販売中にする"
          onChange={(v) => set({ active: v })}
        />
      </div>
    </Modal>
  );
}
