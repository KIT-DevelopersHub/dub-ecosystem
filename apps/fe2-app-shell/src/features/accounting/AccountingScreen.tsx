// 会計: 団体の発行者情報 (法人名・所在地・インボイス登録番号・税率)。チケットの領収書はここを読んで発行者欄を印字する。
import { useState, type FormEvent } from "react";
import { Badge, Button, ErrorState, FormField, PageHeader, Select, SkeletonCard, Stack, TextField } from "@dub/ui";
import { accounting } from "@dub/types";
import { useAppCapability } from "../../auth/AuthProvider.tsx";
import { useIssuer, useSaveIssuer } from "./accountingHooks.ts";
import styles from "./accounting.module.css";

type Form = Record<Exclude<accounting.IssuerField, "taxRatePercent">, string> & { taxRatePercent: string };

const toForm = (i: accounting.AccountingIssuer | null): Form => ({
  name: i?.name ?? "",
  officeName: i?.officeName ?? "",
  postalCode: i?.postalCode ?? "",
  address: i?.address ?? "",
  phone: i?.phone ?? "",
  email: i?.email ?? "",
  url: i?.url ?? "",
  invoiceRegistrationNo: i?.invoiceRegistrationNo ?? "",
  taxRatePercent: String(i?.taxRatePercent ?? accounting.DEFAULT_TAX_RATE),
});

const fromForm = (f: Form): Record<string, unknown> => ({ ...f, taxRatePercent: Number(f.taxRatePercent) });

const TAX_OPTIONS = accounting.TAX_RATES.map((r) => ({ value: String(r), label: r === 10 ? "10%（標準税率）" : `${r}%（軽減税率）` }));

interface FieldDef {
  key: Exclude<accounting.IssuerField, "taxRatePercent">;
  label: string;
  placeholder?: string;
  help?: string;
  required?: boolean;
  type?: "text" | "email" | "url";
}

const SECTIONS: { title: string; fields: FieldDef[] }[] = [
  {
    title: "発行者",
    fields: [
      { key: "name", label: "法人名", placeholder: "一般社団法人 Developers Hub", required: true },
      { key: "officeName", label: "事務局名（表示名）", placeholder: "北陸ITカンファレンス 事務局", help: "領収書の発行者欄に出す名前。空欄ならイベント名＋「事務局」になります。" },
    ],
  },
  {
    title: "所在地・連絡先",
    fields: [
      { key: "postalCode", label: "郵便番号", placeholder: "920-0000" },
      { key: "address", label: "住所", placeholder: "石川県金沢市〇〇町 1-2-3" },
      { key: "phone", label: "電話番号（任意）", placeholder: "076-000-0000", help: "入れた時だけ領収書に出ます。" },
      { key: "email", label: "メール", placeholder: "info@developershub.jp", type: "email" },
      { key: "url", label: "URL", placeholder: "https://developershub.jp", type: "url" },
    ],
  },
  {
    title: "インボイス",
    fields: [
      { key: "invoiceRegistrationNo", label: "適格請求書発行事業者の登録番号", placeholder: "T1234567890123", help: "T と 13 桁の数字。入れると領収書に登録番号と消費税額の内訳が出ます。" },
    ],
  },
];

function IssuerForm({ issuer, canEdit }: { issuer: accounting.AccountingIssuer | null; canEdit: boolean }): JSX.Element {
  const [form, setForm] = useState<Form>(() => toForm(issuer));
  const [submitted, setSubmitted] = useState(false);
  const save = useSaveIssuer();
  const parsed = accounting.parseIssuerInput(fromForm(form));
  const errorOf = (field: accounting.IssuerField): string | undefined => {
    if (!submitted || parsed.ok) return undefined;
    const e = parsed.errors.find((x) => x.field === field);
    return e ? accounting.issuerErrorMessage(e) : undefined;
  };
  const set = (key: keyof Form) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (!parsed.ok || !canEdit) return;
    // 正規化した値 (T 番号・郵便番号の形) をフォームにも戻す。
    setForm(toForm({ ...parsed.value, version: 0, updatedBy: "" as accounting.AccountingIssuer["updatedBy"], updatedByName: null, updatedAt: "" }));
    save.mutate({ ...parsed.value, expectedVersion: issuer?.version ?? 0 });
  };

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate data-testid="fe2-accounting-form">
      {!canEdit && <p className={styles.note} data-testid="fe2-accounting-readonly">閲覧のみの権限です。変更するには会計アプリの「編集」権限が必要です。</p>}
      {SECTIONS.map((s) => (
        <section key={s.title} className={styles.card} aria-label={s.title}>
          <h2 className={styles.sectionTitle}>{s.title}</h2>
          <div className={styles.grid}>
            {s.fields.map((f) => (
              <FormField key={f.key} label={f.label} htmlFor={`fe2-accounting-${f.key}`} required={f.required ?? false} error={errorOf(f.key)} {...(f.help ? { help: f.help } : {})}>
                <TextField
                  id={`fe2-accounting-${f.key}`}
                  testId={`fe2-accounting-field-${f.key}`}
                  value={form[f.key]}
                  onChange={set(f.key)}
                  invalid={errorOf(f.key) !== undefined}
                  disabled={!canEdit}
                  type={f.type ?? "text"}
                  {...(f.placeholder ? { placeholder: f.placeholder } : {})}
                />
              </FormField>
            ))}
            {s.title === "インボイス" && (
              <FormField label="消費税率" htmlFor="fe2-accounting-taxRatePercent" error={errorOf("taxRatePercent")} help="チケットは標準税率 10% です。">
                <Select<string>
                  id="fe2-accounting-taxRatePercent"
                  testId="fe2-accounting-field-taxRatePercent"
                  value={form.taxRatePercent}
                  onChange={set("taxRatePercent")}
                  options={TAX_OPTIONS}
                  disabled={!canEdit}
                />
              </FormField>
            )}
          </div>
        </section>
      ))}
      <div className={styles.actions}>
        {issuer?.updatedByName && <span className={styles.note}>最終更新: {issuer.updatedByName}</span>}
        <Button type="submit" variant="primary" disabled={!canEdit || save.isPending} testId="fe2-accounting-save">
          保存
        </Button>
      </div>
    </form>
  );
}

export function AccountingScreen(): JSX.Element {
  const { canEdit } = useAppCapability("accounting");
  const q = useIssuer();
  return (
    <div className={styles.page}>
      <Stack gap={6} testId="fe2-accounting-screen">
        <PageHeader
          testId="fe2-accounting-header"
          title="会計"
          description="発行者情報。チケットの領収書の発行者欄（法人名・所在地・登録番号・税率）はここから印字されます。"
          {...(q.data ? { actions: q.data.issuer ? <Badge tone="success">設定済み</Badge> : <Badge tone="warning">未設定</Badge> } : {})}
        />
        {q.isPending ? (
          <div className={styles.form} data-testid="fe2-accounting-skeleton">
            {[0, 1, 2].map((i) => <SkeletonCard key={i} lines={3} />)}
          </div>
        ) : q.isError ? (
          <ErrorState testId="fe2-accounting-error" error={{ code: "INTERNAL", message: "発行者情報を読み込めませんでした。" }} onRetry={() => void q.refetch()} />
        ) : (
          <>
            {!q.data.issuer && (
              <p className={styles.note} data-testid="fe2-accounting-unset">
                まだ保存されていません。保存するまで、領収書は既定の発行者（所在地・登録番号は「未設定」）で出ます。
              </p>
            )}
            <IssuerForm issuer={q.data.issuer} canEdit={canEdit} />
          </>
        )}
      </Stack>
    </div>
  );
}
