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
  TICKET_DESCRIPTION_MAX,
  TICKET_NAME_MAX,
  TICKET_PRICE_MIN_PAID,
  formatPrice,
  formatYen,
  validateTicketType,
  type TicketTypeDraft,
  type TicketTypeDraftErrors,
} from "./lpTickets.ts";
import styles from "./lp.module.css";

const EMPTY_DRAFT: TicketTypeDraft = { name: "", description: "", price: "", capacity: "", active: true };

function draftOf(t: LpTicketTypeSummary): TicketTypeDraft {
  return {
    name: t.name,
    description: t.description,
    price: String(t.priceJpy),
    capacity: t.capacity === null ? "" : String(t.capacity),
    active: t.active,
  };
}

const isOptimistic = (t: LpTicketTypeSummary): boolean => t.id.startsWith("optimistic:");

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
          </Stack>
        ),
      },
      {
        key: "price",
        header: "価格",
        align: "right",
        width: "7rem",
        noWrap: true,
        cell: (t) => <span className={styles.num}>{formatPrice(t.priceJpy)}</span>,
      },
      {
        key: "capacity",
        header: "定員",
        align: "right",
        width: "6rem",
        noWrap: true,
        cell: (t) => <span className={styles.num}>{t.capacity === null ? "—" : t.capacity.toLocaleString("ja-JP")}</span>,
      },
      {
        key: "sold",
        header: "販売数 / 残り",
        align: "right",
        width: "9rem",
        noWrap: true,
        cell: (t) => (
          <span className={styles.num} data-testid={`fe2-lp-ticket-type-sold-${t.id}`}>
            {t.stats.sold.toLocaleString("ja-JP")} / {t.stats.remaining === null ? "無制限" : t.stats.remaining.toLocaleString("ja-JP")}
          </span>
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
        <DataTable<LpTicketTypeSummary>
          testId="fe2-lp-ticket-types-table"
          columns={columns}
          rows={types}
          rowKey={(t) => t.id}
        />
      )}
      {editing !== undefined ? (
        <TicketTypeDialog
          target={editing}
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
  onCancel,
  onSubmit,
}: {
  target: LpTicketTypeSummary | null;
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
          help={`0 = 無料（決済なしで即申込完了）。有料は ${TICKET_PRICE_MIN_PAID} 円以上`}
          {...err("price")}
        >
          <TextField id="fe2-lp-ticket-type-price" testId="fe2-lp-ticket-type-price" type="number" value={draft.price} placeholder="3000" onChange={(v) => set({ price: v })} />
        </FormField>
        <FormField label="定員" htmlFor="fe2-lp-ticket-type-capacity" help="空欄 = 無制限" {...err("capacity")}>
          <TextField id="fe2-lp-ticket-type-capacity" testId="fe2-lp-ticket-type-capacity" type="number" value={draft.capacity} placeholder="無制限" onChange={(v) => set({ capacity: v })} />
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
