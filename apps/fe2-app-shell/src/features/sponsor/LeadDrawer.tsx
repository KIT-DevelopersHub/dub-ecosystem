// 営業先の詳細ドロワーと入力フォーム。項目の並びは LEAD_SECTIONS の 1 か所で持ち、表示と編集で共通にする。
// sponsor:write なら編集 (楽観的・409 は読み直し)、sponsor:admin なら削除。閲覧のみの人には編集 UI を出さない。
import { Fragment, useEffect, useMemo, useState } from "react";
import { Button, ConfirmDialog, DatePicker, Drawer, FormField, Select, TextField, Textarea } from "@dub/ui";
import { DialogActions } from "@dub/app-ui";
import { sponsor } from "@dub/types";
import { ApiError } from "../../lib/api-client.tsx";
import { useCompanies } from "./sponsorHooks.ts";
import { useCreateLead, useRemoveLead, useUpdateLead } from "./leadHooks.ts";
import { formatAmount, formatOn } from "./leads.ts";
import { parseAmount } from "./leadImport.ts";
import { useSponsorCapability } from "./SponsorShared.tsx";
import { CardDrawer } from "./CardDrawer.tsx";
import styles from "./sponsor.module.css";

type Lead = sponsor.SponsorLead;
type Key = keyof sponsor.LeadFields;
export type LeadFormValues = Record<Key, string>;

type Kind = "text" | "long" | "date" | "amount" | readonly string[];

interface FieldDef {
  key: Key;
  label: string;
  kind: Kind;
  placeholder?: string;
}

const SECTIONS: { title: string; fields: FieldDef[] }[] = [
  {
    title: "営業の状況",
    fields: [
      { key: "status", label: "ステータス", kind: sponsor.LEAD_STATUSES },
      { key: "priority", label: "連絡優先度", kind: sponsor.LEAD_PRIORITIES },
      { key: "owner", label: "営業担当", kind: "text" },
      { key: "firstContactOn", label: "初回連絡日", kind: "date" },
      { key: "lastContactOn", label: "最終接触日", kind: "date" },
      { key: "proposedOn", label: "提案日", kind: "date" },
      { key: "agreedOn", label: "内諾日", kind: "date" },
      { key: "nextAction", label: "次回アクション", kind: "text", placeholder: "例: 資料送付・担当者へ再連絡" },
      { key: "nextActionOn", label: "次回アクション日", kind: "date" },
    ],
  },
  {
    title: "企業",
    fields: [
      { key: "industry", label: "業界", kind: "text", placeholder: "例: IT・SaaS" },
      { key: "contactName", label: "企業側担当者", kind: "text" },
      { key: "contactRole", label: "企業側部署・役職", kind: "text" },
      { key: "contactEmail", label: "担当者メール（業務用）", kind: "text" },
    ],
  },
  {
    title: "接点",
    fields: [
      { key: "source", label: "接点・紹介元", kind: "text" },
      { key: "contactType", label: "接点区分", kind: "text" },
      { key: "evidence", label: "根拠・確認日", kind: "long" },
    ],
  },
  {
    title: "協賛の条件",
    fields: [
      { key: "plan", label: "検討プラン", kind: sponsor.LEAD_PLANS },
      { key: "expectedAmount", label: "想定協賛額（円）", kind: "amount", placeholder: "例: 300000" },
      { key: "confidence", label: "確度", kind: sponsor.LEAD_CONFIDENCES },
      { key: "budgetPeriod", label: "予算年度・時期", kind: "text" },
      { key: "decisionPeriod", label: "決裁予定時期", kind: "text" },
    ],
  },
  { title: "メモ", fields: [{ key: "note", label: "メモ", kind: "long" }] },
];

const ALL_KEYS: Key[] = ["companyName", ...SECTIONS.flatMap((s) => s.fields.map((f) => f.key))];

export const EMPTY_LEAD_FORM = Object.fromEntries(ALL_KEYS.map((k) => [k, k === "status" ? "未接触" : ""])) as LeadFormValues;

function formFromLead(l: Lead): LeadFormValues {
  return Object.fromEntries(ALL_KEYS.map((k) => [k, l[k] === null ? "" : String(l[k])])) as LeadFormValues;
}

function fieldsFromForm(v: LeadFormValues): sponsor.LeadFields {
  const out = Object.fromEntries(ALL_KEYS.map((k) => [k, v[k].trim() === "" ? null : v[k].trim()])) as Record<Key, unknown>;
  out.expectedAmount = parseAmount(v.expectedAmount);
  return out as unknown as sponsor.LeadFields;
}

const amountInvalid = (v: LeadFormValues): boolean => v.expectedAmount.trim() !== "" && parseAmount(v.expectedAmount) === null;
const formValid = (v: LeadFormValues): boolean => v.companyName.trim() !== "" && !amountInvalid(v);

function Input({ id, def, value, onChange, invalid }: { id: string; def: FieldDef; value: string; onChange: (v: string) => void; invalid?: boolean }): JSX.Element {
  const testId = `fe2-sponsor-lead-field-${def.key}`;
  if (def.kind === "long") return <Textarea id={id} testId={testId} rows={2} value={value} onChange={onChange} />;
  if (def.kind === "date") return <DatePicker id={id} testId={testId} value={value || null} onChange={(v) => onChange(v ?? "")} />;
  if (def.kind === "text" || def.kind === "amount") {
    return <TextField id={id} testId={testId} value={value} onChange={onChange} placeholder={def.placeholder} invalid={invalid} />;
  }
  const options = def.kind.map((o) => ({ value: o, label: o }));
  return (
    <Select<string>
      id={id}
      testId={testId}
      value={value}
      onChange={onChange}
      options={def.key === "status" ? options : [{ value: "", label: "未設定" }, ...options]}
    />
  );
}

/** 企業名は必須。項目が多いので見出しごとに分ける。 */
export function LeadForm({ idPrefix, value, onChange }: { idPrefix: string; value: LeadFormValues; onChange: (next: LeadFormValues) => void }): JSX.Element {
  const set = (k: Key) => (v: string) => onChange({ ...value, [k]: v });
  return (
    <div className={styles.form}>
      <FormField label="企業名" htmlFor={`${idPrefix}-companyName`} required>
        <TextField id={`${idPrefix}-companyName`} testId="fe2-sponsor-lead-field-companyName" value={value.companyName} onChange={set("companyName")} />
      </FormField>
      {SECTIONS.map((s) => (
        <div key={s.title} className={styles.form}>
          <h3 className={styles.leadSectionTitle}>{s.title}</h3>
          <div className={styles.formGrid}>
            {s.fields.map((f) => (
              <FormField
                key={f.key}
                label={f.label}
                htmlFor={`${idPrefix}-${f.key}`}
                error={f.kind === "amount" && amountInvalid(value) ? "数字で入力してください" : undefined}
              >
                <Input
                  id={`${idPrefix}-${f.key}`}
                  def={f}
                  value={value[f.key]}
                  onChange={set(f.key)}
                  invalid={f.kind === "amount" && amountInvalid(value)}
                />
              </FormField>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function display(lead: Lead, def: FieldDef): string {
  if (def.kind === "date") return formatOn(lead[def.key] as string | null);
  if (def.kind === "amount") return formatAmount(lead.expectedAmount);
  return (lead[def.key] as string | null) ?? "—";
}

export function LeadDrawer({ lead, onClose }: { lead: Lead | null; onClose: () => void }): JSX.Element {
  const { canWrite, canAdmin } = useSponsorCapability();
  const update = useUpdateLead();
  const remove = useRemoveLead();
  const { companies } = useCompanies();
  // base = 編集を開いた時点の行。差分と expectedVersion の基準を固定し、途中の再取得で他の人の更新を上書きしない。
  const [editing, setEditing] = useState<{ base: Lead; form: LeadFormValues } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [cardId, setCardId] = useState<string | null>(null);

  const id = lead?.id ?? null;
  useEffect(() => setEditing(null), [id]);

  const cards = useMemo(() => {
    if (!lead) return [];
    const key = sponsor.companyKey(lead.companyName);
    return companies.find((c) => c.key === key)?.cards ?? [];
  }, [companies, lead]);

  const save = ({ base, form }: { base: Lead; form: LeadFormValues }) => {
    // 変えた項目だけ送る (無駄な version 更新で他の人の編集を 409 にしない)。
    const before = fieldsFromForm(formFromLead(base));
    const after = fieldsFromForm(form);
    const changed: Partial<sponsor.LeadFields> = Object.fromEntries(ALL_KEYS.filter((k) => after[k] !== before[k]).map((k) => [k, after[k]]));
    if (Object.keys(changed).length > 0) {
      update.mutate(
        { lead: base, fields: changed },
        // 通信失敗なら入力を戻す。409 は最新を読み直して見てもらうので戻さない。
        { onError: (err) => !(ApiError.isApiError(err) && err.status === 409) && setEditing({ base, form }) },
      );
    }
    setEditing(null);
  };

  return (
    <>
      <Drawer testId="fe2-sponsor-lead-drawer" open={lead !== null && cardId === null} onClose={onClose} title={lead?.companyName ?? "企業"}>
        {lead ? (
          <div className={styles.detail} data-testid="fe2-sponsor-lead-detail">
            {editing ? (
              <div className={styles.detailSection}>
                <LeadForm idPrefix={`sponsor-lead-${lead.id}`} value={editing.form} onChange={(form) => setEditing({ ...editing, form })} />
                <DialogActions>
                  <Button variant="secondary" size="lg" testId="fe2-sponsor-lead-edit-cancel" onClick={() => setEditing(null)}>
                    キャンセル
                  </Button>
                  <Button size="lg" testId="fe2-sponsor-lead-edit-save" disabled={!formValid(editing.form)} onClick={() => save(editing)}>
                    保存する
                  </Button>
                </DialogActions>
              </div>
            ) : (
              <>
                {SECTIONS.map((s) => (
                  <div key={s.title} className={styles.detailSection}>
                    <h3 className={styles.leadSectionTitle}>{s.title}</h3>
                    <dl className={`${styles.fields} ${styles.leadFields}`}>
                      {s.fields.map((f) => (
                        <Fragment key={f.key}>
                          <dt>{f.label}</dt>
                          <dd>{display(lead, f)}</dd>
                        </Fragment>
                      ))}
                    </dl>
                  </div>
                ))}
                {cards.length > 0 ? (
                  <div className={styles.detailSection} data-testid="fe2-sponsor-lead-cards">
                    <h3 className={styles.leadSectionTitle}>この企業の名刺（{cards.length} 枚）</h3>
                    <div className={styles.leadCards}>
                      {cards.map((c) => (
                        <div key={c.id}>
                          <Button variant="secondary" size="sm" testId={`fe2-sponsor-lead-card-${c.id}`} onClick={() => setCardId(c.id)}>
                            {[c.personName, c.title].filter(Boolean).join("・") || "氏名未入力"}
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                {canWrite || canAdmin ? (
                  <div className={styles.inlineActions}>
                    {canWrite ? (
                      <Button testId="fe2-sponsor-lead-edit" onClick={() => setEditing({ base: lead, form: formFromLead(lead) })}>
                        編集する
                      </Button>
                    ) : null}
                    {canAdmin ? (
                      <Button variant="danger" testId="fe2-sponsor-lead-remove" onClick={() => setConfirmRemove(true)}>
                        削除する
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}
            <ConfirmDialog
              testId="fe2-sponsor-lead-remove-confirm"
              open={confirmRemove}
              danger
              title="この企業を削除しますか？"
              message={`「${lead.companyName}」の営業の記録を削除します。チームの全員の一覧から消え、元に戻せません。`}
              confirmLabel="削除する"
              onCancel={() => setConfirmRemove(false)}
              onConfirm={() => {
                setConfirmRemove(false);
                onClose();
                remove.mutate(lead);
              }}
            />
          </div>
        ) : (
          <span />
        )}
      </Drawer>
      <CardDrawer cardId={cardId} onClose={() => setCardId(null)} />
    </>
  );
}

/** 新規追加のドロワー。 */
export function LeadCreateDrawer({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  const create = useCreateLead();
  const [form, setForm] = useState<LeadFormValues>(EMPTY_LEAD_FORM);
  useEffect(() => {
    if (open) setForm(EMPTY_LEAD_FORM);
  }, [open]);
  return (
    <Drawer testId="fe2-sponsor-lead-create" open={open} onClose={onClose} title="企業を追加">
      <div className={styles.detail}>
        <LeadForm idPrefix="sponsor-lead-new" value={form} onChange={setForm} />
        <DialogActions>
          <Button variant="secondary" size="lg" testId="fe2-sponsor-lead-create-cancel" onClick={onClose}>
            キャンセル
          </Button>
          <Button
            size="lg"
            testId="fe2-sponsor-lead-create-save"
            disabled={!formValid(form)}
            onClick={() => {
              create.mutate(fieldsFromForm(form));
              onClose();
            }}
          >
            追加する
          </Button>
        </DialogActions>
      </div>
    </Drawer>
  );
}
