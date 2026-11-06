// 名刺の OCR テキスト → 入力項目の下書き。行ごとに「メール / 電話 / 会社 / 部署・役職 / 氏名」を推定する。
// 推定なので外れることがある前提 (保存前に人が写真と見比べて直す)。読めなかった項目は返さない。
import type { CardFormValues } from "./SponsorShared.tsx";

export type CardDraft = Partial<Omit<CardFormValues, "note">>;

const CJK = "\\u3040-\\u30ff\\u3400-\\u9fff\\uf900-\\ufaff\\u3005";
const CJK_GAP = new RegExp(`(?<=[${CJK}])\\s+(?=[${CJK}])`, "g");

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
// 03-1234-5678 / (03)1234-5678 / 090 1234 5678 / +81 3 1234 5678
const PHONE = /(?<!\d)(?:\+81[\s-]?\(?0?\)?|\(?0)\d{1,4}\)?[\s-]?\d{1,4}[\s-]?\d{3,4}(?!\d)/;
const FAX = /fax|ファクス|ファックス/i;
const TEL = /\btel\b|電話|携帯|mobile|phone/i;
const MOBILE = /携帯|mobile|cell/i;
const COMPANY =
  /株式会社|有限会社|合同会社|合資会社|(?:社団|財団)法人|NPO法人|学校法人|医療法人|\(株\)|\(有\)|㈱|㈲|大学|\b(?:inc|ltd|llc|corp|corporation|k\.k)\b/i;
const TITLE =
  /代表取締役(?:社長|会長)?|取締役|執行役員|理事長|理事|社長|会長|課長代理|副?本部長|副?部長|副?課長|室長|所長|センター長|グループ長|係長|主任|主査|マネー?ジャー|リーダー|ディレクター|プロデューサー|エンジニア|デザイナー|コンサルタント|スペシャリスト|CEO|CTO|COO|CFO|CMO|President|Director|Manager|Engineer|Designer/i;
const DEPT_WORD = "(?:事業部|本部|部|課|室|グループ|チーム|センター|ユニット|局|支社|支店|営業所|研究所)";
// 部署語は語の末尾だけ見る (「阿部」のような氏名を部署にしない)。
const DEPARTMENT = new RegExp(`\\S{2,}${DEPT_WORD}(?=\\s|$)|\\b(?:Division|Department|Dept)\\b`, "i");
// 役職語の前置きを「部署」+「役職の修飾」に分ける: 開発本部シニア → 開発本部 / シニア (最後の部署語で切る)。
const LEAD_SPLIT = new RegExp(`^(\\S{2,}${DEPT_WORD})(\\S*)$`);
const NOISE = /https?:\/\/|www\.|〒|\d{3}-\d{4}|[都道府県].*[市区町村郡]|[市区町村].*\d|\btel\b|\bfax\b|e-?mail|住所|address/i;
const NAME_JA = new RegExp(`^[${CJK}]{2,8}$`);
const NAME_EN = /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}$/;

/** OCR の癖を均す: 全角→半角 (NFKC)・日本語の文字間に入る空白を詰める・連続空白を 1 つに。 */
export function normalizeLine(raw: string): string {
  return raw.normalize("NFKC").replace(CJK_GAP, "").replace(/\s+/g, " ").trim();
}

const compactAt = (l: string): string => l.replace(/\s*([@.])\s*/g, "$1");
const looksLikeName = (s: string): boolean => NAME_JA.test(s) || NAME_EN.test(s);

function findEmail(lines: string[]): string | undefined {
  for (const l of lines) {
    const m = EMAIL.exec(compactAt(l));
    if (m) return m[0];
  }
  return undefined;
}

/** 電話: FAX の番号は除き、携帯 → それ以外の順 (同じなら先に出た番号)。 */
function findPhone(lines: string[]): string | undefined {
  const hits: { phone: string; mobile: boolean }[] = [];
  for (const l of lines) {
    // 「TEL 03-... FAX 03-...」は FAX より前だけ見る。FAX だけの行は飛ばす。
    const head = l.split(FAX)[0] ?? "";
    const m = PHONE.exec(head);
    if (m) hits.push({ phone: m[0].trim().replace(/\s+/g, "-"), mobile: MOBILE.test(head) });
  }
  return (hits.find((h) => h.mobile) ?? hits[0])?.phone;
}

/** 部署・役職の行を分ける。「営業部部長」「開発本部 シニアエンジニア」「部長 山田太郎」(後ろは tail)。 */
function splitDeptTitle(line: string): { department?: string; title?: string; tail?: string } {
  const t = TITLE.exec(line);
  if (!t) return DEPARTMENT.test(line) ? { department: line } : {};
  const before = line.slice(0, t.index);
  const sp = before.lastIndexOf(" ");
  const lead = before.slice(sp + 1); // 役職語と同じ語にくっついている前置き
  const head = before.slice(0, sp + 1).trim();
  const split = LEAD_SPLIT.exec(lead);
  const deptLead = split?.[1] ?? "";
  const title = (split ? split[2] : lead) + t[0]; // 「シニア」+「エンジニア」
  const deptParts = [head && DEPARTMENT.test(head) ? head : "", deptLead].filter(Boolean);
  return {
    department: deptParts.length > 0 ? deptParts.join(" ") : undefined,
    title,
    tail: line.slice(t.index + t[0].length).trim() || undefined,
  };
}

export function parseCardText(text: string): CardDraft {
  const lines = text.split(/\r?\n/).map(normalizeLine).filter((l) => l.length >= 2);
  const out: CardDraft = {};
  const email = findEmail(lines);
  if (email) out.email = email;
  const phone = findPhone(lines);
  if (phone) out.phone = phone;

  const rest = lines.filter((l) => !EMAIL.test(compactAt(l)) && !PHONE.test(l) && !TEL.test(l) && !NOISE.test(l));
  const company = rest.find((l) => COMPANY.test(l));
  if (company) out.companyName = company;

  const names: string[] = [];
  for (const l of rest) {
    if (l === company) continue;
    const dt = splitDeptTitle(l);
    if (dt.title || dt.department) {
      if (dt.title && !out.title) out.title = dt.title;
      if (dt.department && !out.department) out.department = dt.department;
      if (dt.tail && looksLikeName(dt.tail)) names.push(dt.tail);
      continue;
    }
    if (looksLikeName(l)) names.push(l);
  }
  // 氏名: 漢字を含む行を優先 (ふりがな・ローマ字の行より先に)。
  const name = names.find((n) => /[㐀-鿿]/.test(n)) ?? names[0];
  if (name) out.personName = name;
  return out;
}

/**
 * 読み取った下書きを、空の項目と「前回の読み取りで入れたまま手を加えていない項目」(prevAuto) にだけ入れる
 * (手で入れた・直した値は上書きしない)。filled = 入れた項目。
 */
export function mergeDraft(
  form: CardFormValues,
  draft: CardDraft,
  prevAuto: CardDraft = {},
): { next: CardFormValues; filled: (keyof CardDraft)[] } {
  const next = { ...form };
  const filled: (keyof CardDraft)[] = [];
  for (const [k, v] of Object.entries(draft) as [keyof CardDraft, string | undefined][]) {
    if (v && (next[k].trim() === "" || next[k] === prevAuto[k])) {
      next[k] = v;
      filled.push(k);
    }
  }
  return { next, filled };
}
