// LP管理 → チケット / 登壇者募集 → 入力項目カード。固定項目（氏名・メール等）は鍵つきの行、それ以外を
// 下書きとして編集し「保存」で一覧ごと送る（楽観的 UI: 押した瞬間に確定表示 → 失敗で下書きを戻す）。
import { useState, type ReactNode } from "react";
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
  return (
    <LpFieldsEditorCard
      fields={fields}
      canEdit={canEdit}
      save={save}
      locked={["氏名", "メールアドレス"]}
      note={
        <>
          購入ページのフォームに並ぶ項目です。氏名とメールアドレスは決済と連絡に使うため必ず入力してもらいます。
          追加の項目は最大 {TICKET_FIELDS_MAX} 個まで。
        </>
      }
      testIdPrefix="fe2-lp-ticket-field"
    />
  );
}

export interface LpFieldsEditorProps {
  fields: LpTicketField[];
  canEdit: boolean;
  save: {
    mutate: (vars: { fields: LpTicketField[] }, opts: { onError: () => void }) => void;
    isPending: boolean;
  };
  /** 固定項目のラベル（鍵つき・必須の行として先頭に出す）。 */
  locked: readonly string[];
  note: ReactNode;
  /** 例 "fe2-lp-ticket-field" → カードは "<prefix>s"、各行は "<prefix>-<id>"。 */
  testIdPrefix: string;
}

export function LpFieldsEditorCard({ fields, canEdit, save, locked, note, testIdPrefix: P }: LpFieldsEditorProps): JSX.Element {
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
      testId={`${P}s`}
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
              testId={`${P}-add`}
            >
              項目を追加
            </Button>
          ) : null}
        </div>
      }
    >
      <Stack gap={5}>
        <span className={styles.note}>{note}</span>
        <div className={styles.fieldList}>
          {locked.map((label) => (
            <div key={label} className={styles.fieldRowLocked} data-testid={`${P}-locked`}>
              <Icon name="lock" />
              <strong>{label}</strong>
              <Badge tone="neutral">必須・固定</Badge>
            </div>
          ))}
          {list.map((f, i) => (
            <FieldRow
              key={f.id}
              testIdPrefix={P}
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
              }} testId={`${P}s-reset`}>
              元に戻す
            </Button>
            <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={submit} testId={`${P}s-save`}>
              保存
            </Button>
          </div>
        ) : null}
      </Stack>
    </Card>
  );
}

function FieldRow({
  testIdPrefix,
  field: f,
  index,
  count,
  canEdit,
  error,
  onPatch,
  onMove,
  onRemove,
}: {
  testIdPrefix: string;
  field: DraftField;
  index: number;
  count: number;
  canEdit: boolean;
  error: string | undefined;
  onPatch: (p: Partial<DraftField>) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}): JSX.Element {
  const tid = `${testIdPrefix}-${f.id}`;
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
