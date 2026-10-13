// LP管理 → チケット → 入力項目カード。氏名・メールは固定行（Stripe と連絡に必須）、それ以外を
// 下書きとして編集し「保存」で一覧ごと送る（楽観的 UI: 押した瞬間に確定表示 → 失敗で下書きを戻す）。
import { useState } from "react";
import { Badge, Button, Card, Checkbox, Icon, Select, Stack, TextField, Textarea } from "@dub/ui";
import type { LpTicketField, LpTicketFieldType } from "./lpApi.tsx";
import { useSaveTicketFields } from "./lpTicketsHooks.ts";
import {
  FIELD_TYPE_LABELS,
  TICKET_FIELDS_MAX,
  moveItem,
  newFieldId,
  normalizeTicketFields,
  parseOptions,
  validateTicketFields,
} from "./lpTickets.ts";
import styles from "./lp.module.css";

/** 選択肢は入力途中の改行を保つためテキストのまま持つ（保存時に配列化）。 */
type DraftField = LpTicketField & { optionsText: string };

const TYPE_OPTIONS = (Object.keys(FIELD_TYPE_LABELS) as LpTicketFieldType[]).map((v) => ({
  value: v,
  label: FIELD_TYPE_LABELS[v],
}));

const toDraft = (fields: LpTicketField[]): DraftField[] => fields.map((f) => ({ ...f, optionsText: f.options.join("\n") }));
const fromDraft = (draft: DraftField[]): LpTicketField[] =>
  normalizeTicketFields(draft.map(({ optionsText, ...f }) => ({ ...f, options: parseOptions(optionsText) })));

export function LpTicketFieldsCard({ fields, canEdit }: { fields: LpTicketField[]; canEdit: boolean }): JSX.Element {
  const save = useSaveTicketFields();
  // null = 未編集（サーバー値をそのまま見せる）。編集を始めた時点で下書きを持つ。
  const [draft, setDraft] = useState<DraftField[] | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const list = draft ?? toDraft(fields);
  const dirty = draft !== null;

  const update = (next: DraftField[]): void => {
    setDraft(next);
    setErrors({});
  };
  const patch = (id: string, p: Partial<DraftField>): void => update(list.map((f) => (f.id === id ? { ...f, ...p } : f)));

  const submit = (): void => {
    const next = fromDraft(list);
    const found = validateTicketFields(next);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const kept = list;
    setDraft(null);
    save.mutate({ fields: next }, { onError: () => setDraft(kept) });
  };

  return (
    <Card
      testId="fe2-lp-ticket-fields"
      header={
        <div className={styles.cardHeaderRow}>
          <span className={styles.sectionTitle}>入力項目</span>
          {canEdit ? (
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<Icon name="plus" />}
              disabled={list.length >= TICKET_FIELDS_MAX}
              onClick={() =>
                update([...list, { id: newFieldId(), label: "", type: "text", required: false, options: [], optionsText: "" }])
              }
              testId="fe2-lp-ticket-field-add"
            >
              項目を追加
            </Button>
          ) : null}
        </div>
      }
    >
      <Stack gap={5}>
        <span className={styles.note}>
          購入ページのフォームに並ぶ項目です。氏名とメールアドレスは決済と連絡に使うため必ず入力してもらいます。
          追加の項目は最大 {TICKET_FIELDS_MAX} 個まで。
        </span>
        <div className={styles.fieldList}>
          {(["氏名", "メールアドレス"] as const).map((label) => (
            <div key={label} className={styles.fieldRowLocked} data-testid="fe2-lp-ticket-field-locked">
              <Icon name="lock" />
              <strong>{label}</strong>
              <Badge tone="neutral">必須・固定</Badge>
            </div>
          ))}
          {list.map((f, i) => (
            <FieldRow
              key={f.id}
              field={f}
              index={i}
              count={list.length}
              canEdit={canEdit}
              error={errors[f.id]}
              onPatch={(p) => patch(f.id, p)}
              onMove={(d) => update(moveItem(list, i, d))}
              onRemove={() => update(list.filter((x) => x.id !== f.id))}
            />
          ))}
          {list.length === 0 ? <span className={styles.note}>追加の項目はありません。</span> : null}
        </div>
        {canEdit ? (
          <div className={styles.formActions}>
            <Button variant="ghost" disabled={!dirty} onClick={() => {
                setDraft(null);
                setErrors({});
              }} testId="fe2-lp-ticket-fields-reset">
              元に戻す
            </Button>
            <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={submit} testId="fe2-lp-ticket-fields-save">
              保存
            </Button>
          </div>
        ) : null}
      </Stack>
    </Card>
  );
}

function FieldRow({
  field: f,
  index,
  count,
  canEdit,
  error,
  onPatch,
  onMove,
  onRemove,
}: {
  field: DraftField;
  index: number;
  count: number;
  canEdit: boolean;
  error: string | undefined;
  onPatch: (p: Partial<DraftField>) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}): JSX.Element {
  const tid = `fe2-lp-ticket-field-${f.id}`;
  return (
    <div className={styles.fieldRow} data-testid={tid}>
      <div className={styles.fieldMain}>
        <TextField
          id={`${tid}-label`}
          testId={`${tid}-label`}
          value={f.label}
          placeholder="項目名（例: 所属）"
          disabled={!canEdit}
          invalid={!!error}
          onChange={(v) => onPatch({ label: v })}
        />
        <Select<LpTicketFieldType>
          id={`${tid}-type`}
          testId={`${tid}-type`}
          value={f.type}
          options={TYPE_OPTIONS}
          disabled={!canEdit}
          onChange={(v) => onPatch({ type: v })}
        />
        <Checkbox
          id={`${tid}-required`}
          testId={`${tid}-required`}
          checked={f.required}
          disabled={!canEdit}
          label="必須"
          onChange={(v) => onPatch({ required: v })}
        />
        {canEdit ? (
          <div className={styles.fieldButtons}>
            <Button variant="ghost" size="sm" disabled={index === 0} onClick={() => onMove(-1)} testId={`${tid}-up`}>
              上へ
            </Button>
            <Button variant="ghost" size="sm" disabled={index === count - 1} onClick={() => onMove(1)} testId={`${tid}-down`}>
              下へ
            </Button>
            <Button variant="ghost" size="sm" iconLeft={<Icon name="trash" />} onClick={onRemove} testId={`${tid}-remove`}>
              削除
            </Button>
          </div>
        ) : null}
      </div>
      {f.type === "select" ? (
        <div className={styles.fieldOptions}>
          <span className={styles.kpiLabel}>選択肢（1 行に 1 つ）</span>
          <Textarea
            id={`${tid}-options`}
            testId={`${tid}-options`}
            value={f.optionsText}
            rows={3}
            disabled={!canEdit}
            onChange={(v) => onPatch({ optionsText: v })}
          />
        </div>
      ) : null}
      {error ? (
        <span className={styles.fieldError} role="alert" data-testid={`${tid}-error`}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
