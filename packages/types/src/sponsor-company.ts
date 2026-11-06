// sponsor — 会社名の照合キー。名刺と営業先 (外部キーなし) を結び、メール連携でも名刺のアドレスを営業先に結ぶ。
// sponsor.ts から再エクスポートされる (sponsor-mail.ts が実行時に使うので、循環しないよう別ファイル)。
const LEGAL_FORMS =
  /株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人|特定非営利活動法人|npo法人|\((株|有|同|資|名|社|財)\)/g;

/** 会社名の照合キー。法人格・空白・記号を除いた NFKC 小文字。 */
export function companyKey(name: string): string {
  const base = name.normalize("NFKC").toLowerCase();
  const key = base.replace(LEGAL_FORMS, "").replace(/[\s・.,、。'"]/g, "");
  return key === "" ? base.trim() : key;
}
