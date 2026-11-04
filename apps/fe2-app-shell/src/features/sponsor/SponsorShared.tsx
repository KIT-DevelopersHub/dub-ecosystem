// スポンサーの共通部品: 権限フラグ・共有の注意書き・名刺の写真 (サムネ/拡大)・入力フォーム・写真の再送。
import { Button, FormField, Modal, Skeleton, TextField, Textarea } from "@dub/ui";
import { sponsor } from "@dub/types";
import { useAppCapability, usePermissions } from "../../auth/AuthProvider.tsx";
import { useCardImage, useUploadImage } from "./sponsorHooks.ts";
import { suggestCompanies } from "./companies.ts";
import { usePendingState } from "./pendingStore.ts";
import { useSponsorPending } from "./SponsorProvider.tsx";
import styles from "./sponsor.module.css";

/** 撮影画面に出す共有範囲の一文 (Liveness マーカーにも使うので文言を変えない)。 */
export const SHARE_NOTICE = "撮った名刺はスポンサーチームのメンバー全員に共有されます";

/** スポンサーアプリでの操作可否。member-service の policy-table と同じ組み合わせ。 */
export function useSponsorCapability(): { canWrite: boolean; canAdmin: boolean } {
  const { canEdit } = useAppCapability("sponsor");
  const { can } = usePermissions();
  return { canWrite: canEdit && can("sponsor:write"), canAdmin: canEdit && can("sponsor:admin") };
}

/** 一覧の「登録日時」: 2026/11/04 13:05 */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" });
}

/** 名刺の写真 (91:55 の箱)。読み込み中はスケルトン、写真なしはプレースホルダ。 */
export function CardPhoto({
  card,
  size = "thumb",
  onOpen,
}: {
  card: sponsor.BusinessCard;
  size?: "thumb" | "large";
  onOpen?: () => void;
}): JSX.Element {
  const img = useCardImage(card);
  const cls = `${styles.photo} ${size === "large" ? styles.photoLarge : ""}`;
  if (img.kind === "ready") {
    const node = <img src={img.url} alt={`${sponsor.cardDisplayName(card)} の名刺`} className={styles.photoImg} />;
    return (
      <div className={cls} data-testid={`fe2-sponsor-photo-${card.id}`}>
        {onOpen ? (
          <button type="button" className={styles.photoButton} onClick={onOpen} aria-label="写真を拡大" data-testid="fe2-sponsor-photo-zoom">
            {node}
          </button>
        ) : (
          node
        )}
        {img.pending === "uploading" ? <span className={styles.photoBadge}>写真を送信中…</span> : null}
        {img.pending === "failed" ? <span className={`${styles.photoBadge} ${styles.photoBadgeDanger}`}>写真の送信に失敗</span> : null}
      </div>
    );
  }
  if (img.kind === "loading") {
    return (
      <div className={cls} data-testid={`fe2-sponsor-photo-loading-${card.id}`}>
        <Skeleton variant="rect" width="100%" height="100%" radius="0" />
      </div>
    );
  }
  return (
    <div className={`${cls} ${styles.photoEmpty}`} data-testid={`fe2-sponsor-photo-none-${card.id}`}>
      {img.kind === "error" ? "写真を読み込めません" : "写真なし"}
    </div>
  );
}

/** 写真の送信に失敗した名刺の「写真を再送」。送信待ちの写真が無ければ何も出さない。 */
export function RetryUpload({ card }: { card: sponsor.BusinessCard }): JSX.Element | null {
  const pending = usePendingState(useSponsorPending()).images[card.id];
  const upload = useUploadImage();
  if (pending?.status !== "failed") return null;
  return (
    <Button variant="secondary" size="sm" testId={`fe2-sponsor-retry-${card.id}`} onClick={() => void upload(card.id, pending.blob)}>
      写真を再送
    </Button>
  );
}

/** 写真の拡大表示。 */
export function PhotoZoom({ card, open, onClose }: { card: sponsor.BusinessCard; open: boolean; onClose: () => void }): JSX.Element {
  return (
    <Modal testId="fe2-sponsor-zoom" open={open} onClose={onClose} title={sponsor.cardDisplayName(card)} size="full">
      <div className={styles.zoomBody}>
        <CardPhoto card={card} size="large" />
      </div>
    </Modal>
  );
}

export type CardFormValues = Record<keyof Required<sponsor.CardFields>, string>;

export const EMPTY_FORM: CardFormValues = {
  companyName: "", personName: "", department: "", title: "", email: "", phone: "", note: "",
};

export function formFromCard(c: sponsor.CardFields): CardFormValues {
  return {
    companyName: c.companyName ?? "", personName: c.personName ?? "", department: c.department ?? "", title: c.title ?? "",
    email: c.email ?? "", phone: c.phone ?? "", note: c.note ?? "",
  };
}

const TEXT_FIELDS: { key: Exclude<keyof CardFormValues, "note">; label: string; type?: "email"; placeholder?: string }[] = [
  { key: "companyName", label: "会社名", placeholder: "例: 株式会社〇〇" },
  { key: "personName", label: "氏名" },
  { key: "department", label: "部署" },
  { key: "title", label: "役職" },
  { key: "email", label: "メール", type: "email" },
  { key: "phone", label: "電話" },
];

/** 会社名の下に出す「登録済みの企業」候補。押すとその表記に揃える (企業への紐付け)。 */
function CompanySuggestions({ input, companies, onPick }: { input: string; companies: readonly string[]; onPick: (name: string) => void }): JSX.Element | null {
  const hits = suggestCompanies(input, companies);
  if (hits.length === 0) return null;
  return (
    <div className={styles.suggest} data-testid="fe2-sponsor-company-suggest">
      <span className={styles.suggestLabel}>登録済みの企業:</span>
      {hits.map((name) => (
        <button key={name} type="button" className={styles.suggestChip} onClick={() => onPick(name)}>
          {name}
        </button>
      ))}
    </div>
  );
}

/** 名刺の項目 (すべて任意)。登録と編集で共通。companies = 既存の企業名 (候補に出す)。 */
export function CardForm({
  idPrefix,
  value,
  onChange,
  companies = [],
}: {
  idPrefix: string;
  value: CardFormValues;
  onChange: (next: CardFormValues) => void;
  companies?: readonly string[];
}): JSX.Element {
  const set = (k: keyof CardFormValues) => (v: string) => onChange({ ...value, [k]: v });
  return (
    <div className={styles.form}>
      <div className={styles.formGrid}>
        {TEXT_FIELDS.map((f) => (
          <FormField key={f.key} label={f.label} htmlFor={`${idPrefix}-${f.key}`}>
            <TextField
              id={`${idPrefix}-${f.key}`}
              testId={`fe2-sponsor-field-${f.key}`}
              type={f.type}
              value={value[f.key]}
              onChange={set(f.key)}
              placeholder={f.placeholder}
            />
            {f.key === "companyName" ? (
              <CompanySuggestions input={value.companyName} companies={companies} onPick={set("companyName")} />
            ) : null}
          </FormField>
        ))}
      </div>
      <FormField label="メモ" htmlFor={`${idPrefix}-note`}>
        <Textarea
          id={`${idPrefix}-note`}
          testId="fe2-sponsor-field-note"
          rows={3}
          value={value.note}
          onChange={set("note")}
          placeholder="どこで交換したか・協賛の温度感など"
        />
      </FormField>
    </div>
  );
}
