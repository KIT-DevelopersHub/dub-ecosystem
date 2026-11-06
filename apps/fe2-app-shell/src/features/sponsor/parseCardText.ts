// 名刺の OCR 結果 → 入力項目の下書き。メール/電話は形で、会社・部署・役職は語で決め、氏名は候補行の採点で選ぶ。
// 推定なので外れることがある前提 (保存前に人が写真と見比べて直す)。読めなかった項目は返さない。
import type { CardFormValues } from "./SponsorShared.tsx";

export type CardDraft = Partial<Omit<CardFormValues, "note">>;

export interface CardBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** OCR の 1 行。bbox = 写真上の位置 (テキストだけの入力では無い)。 */
export interface CardLine {
  text: string;
  bbox?: CardBox;
}

const CJK = "\\u3040-\\u30ff\\u3400-\\u9fff\\uf900-\\ufaff\\u3005";
const KANJI = "\\u3400-\\u9fff\\uf900-\\ufaff\\u3005";
const KANA = "\\u3041-\\u3096\\u30a1-\\u30fa\\u30fc";
const CJK_GAP = new RegExp(`(?<=[${CJK}])\\s+(?=[${CJK}])`, "g");

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
// 03-1234-5678 / (03)1234-5678 / 090 1234 5678 / +81 3 1234 5678
const PHONE = /(?<!\d)(?:\+81[\s.-]?\(?0?\)?\d{1,4}|\(?0\d{1,4})\)?[\s.-]?\d{1,4}[\s.-]?\d{3,4}(?!\d)/g;
const FAX = /fax|ファクス|ファックス/i;
const TEL = /(?<![a-z])tel(?![a-z])|電話|携帯|mobile|phone/i;
// 読み違いで電話として取れなかった番号の行も氏名・社名の候補から外す。
const NUMBERS = /\d{2,}[\s.-]\d{2,}[\s.-]\d{2,}/;
const MOBILE = /^(?:0|81)[789]0/;
const LEGAL =
  /株式会社|有限会社|合同会社|合資会社|(?:社団|財団)法人|NPO法人|学校法人|医療法人|\(株\)|\(有\)|㈱|㈲|大学|\b(?:inc|ltd|llc|corp|corporation|k\.k)\b/i;
// 法人格を書かない社名に多い語。氏名から外し、会社の候補にする。
const COMPANY_WORD =
  /工業|製作所|電機|電気|電工|建設|工務店|商事|商店|物産|通商|産業|銀行|信用金庫|証券|保険|製薬|製菓|食品|化学|運輸|不動産|自動車|技研|工房|印刷|新聞|放送|通信|病院|協会|組合|機構|ホールディングス|テック|テクノ|システム|ソフト|ソリューション|ネットワーク|ワークス|ラボ|デザイン|ジャパン|\b(?:lab|labs|tech|technologies|systems|solutions|works|studio|group|holdings|japan)\b/i;
const TITLE =
  /代表取締役(?:社長|会長)?|代表社員|代表理事|代表(?=\s|$)|取締役|執行役員|監査役|理事長|理事|顧問|社長|会長|専務|常務|課長代理|副?本部長|副?部長|副?課長|室長|所長|院長|店長|店主|工場長|支店長|局長|学長|センター長|グループ長|係長|支配人|主任|主査|准?教授|講師|助教|研究員|担当|弁護士|弁理士|税理士|(?:公認)?会計士|司法書士|行政書士|医師|マネー?ジャー?|リーダー?|ディレクター|プロデューサー|エンジニア|デザイナー|コンサルタント|スペシャリスト|\b(?:CEO|CTO|COO|CFO|CMO|VP|President|Founder|Partner|Representative|Director|Manager|Engineer|Designer|Consultant|Officer|Chief|Head)\b/i;
const LATIN_LINE = /^[\x20-\x7e]+$/;
const DEPT_WORD = "(?:事業部|学部|本部|部|課|室|学科|研究科|専攻|グループ|チーム|センター|ユニット|局|支社|支店|営業所|研究所)";
// 部署語は語の末尾だけ見る (「阿部」のような氏名を部署にしない)。
const DEPARTMENT = new RegExp(`\\S{2,}${DEPT_WORD}(?=\\s|$)|\\b(?:Division|Department|Dept)\\b`, "i");
// 役職語の前置きを「部署」+「役職の修飾」に分ける: 開発本部シニア → 開発本部 / シニア (最後の部署語で切る)。
const LEAD_SPLIT = new RegExp(`^(\\S{2,}${DEPT_WORD})(\\S*)$`);
const NOISE =
  /https?:\/\/|www\.|〒|\d{3}-\d{4}|[都道府県].*[市区町村郡]|[市区町村].*\d|(?<![a-z])fax(?![a-z])|e-?mail|住所|address|\d+\s*(?:F|階)\b|ビル\s*\d/i;
const NAME_JA = new RegExp(`^[${KANJI}]{2,6}$|^[${KANJI}]{1,4}[${KANA}]{2,4}$`);
const NAME_KATAKANA = /^[ァ-ヺ・ー\s]{3,16}$/;
const NAME_EN = /^[A-Z][a-zA-Z'-]+(?:\s+[A-Z]\.)?(?:\s+[A-Z][a-zA-Z'-]+){1,2}$/;
const FURIGANA = /^[ぁ-ゖー\s]{3,}$/;
// スローガンの行 (「未来をつくる技術」)。
const TAGLINE = /[をへ]|ます|です|する|ために|つくる/;
const FREE_MAIL = /^(?:gmail|googlemail|yahoo|ymail|outlook|hotmail|icloud|me|docomo|ezweb|softbank)$/;
// 多い名字。社名との見分けに使う。1 文字の名字は社名の頭と衝突しやすいので 林・森・原 だけ。
const SURNAMES = new Set(
  "佐藤 鈴木 高橋 田中 伊藤 渡辺 渡邊 渡邉 渡部 山本 中村 小林 加藤 吉田 山田 佐々木 山口 松本 井上 木村 林 斎藤 斉藤 齋藤 清水 山崎 森 池田 橋本 阿部 石川 山下 中島 前田 藤田 後藤 小川 岡田 長谷川 村上 近藤 石井 坂本 遠藤 青木 藤井 西村 福田 太田 三浦 岡本 松田 中川 藤原 原田 小野 田村 竹内 金子 和田 中山 石田 上田 森田 原 柴田 酒井 工藤 横山 宮崎 宮本 内田 高木 安藤 谷口 大野 丸山 今井 高田 河野 藤本 村田 武田 上野 杉山 増田 平野 大塚 千葉 久保 松井 小島 岩崎 桜井 櫻井 野口 松尾 菅原 木下 野村 新井 佐野 大西 古川 浜田 濱田 市川 小松 水野 西田 北村 安田 五十嵐 川口 平田 中田 菊地 菊池 田口 飯田 服部 樋口 川崎 永井 本田 久保田 吉川 山内 星野 秋山 松岡 中野 島田 望月 片山 岡崎 荒井 大久保 高野 小山 石原 大橋 須藤 土屋 川上 関口 木内 南 岩田 小池 川村 黒田 三宅 宮田 堀 長田 尾崎 榎本 細川 河合 西川 今村 小泉 松浦 吉村 福島 福井".split(" "),
);
const hasSurname = (s: string): boolean =>
  s.length >= 3 && [1, 2, 3].some((n) => s.length > n && SURNAMES.has(s.slice(0, n)));

/** OCR の癖を均す: 全角→半角 (NFKC)・日本語の文字間に入る空白を詰める・連続空白を 1 つに。 */
export function normalizeLine(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(CJK_GAP, "")
    .replace(/\(\s*([株有])\s*\)/g, "($1)")
    .replace(/\s+/g, " ")
    .trim();
}

const compactAt = (l: string): string => l.replace(/\s*([@.])\s*/g, "$1");
const alnum = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** メールの末尾の読み違いを直す: 「co jp」「.cojp」「techjjp」→ 点を補う。 */
function repairDomain(line: string): string {
  const at = line.indexOf("@");
  if (at < 0) return line;
  const domain = line
    .slice(at + 1)
    .replace(/\s+(?=(?:[a-z0-9-]+\s+)*(?:jp|com|net|org|io|co|or|ne|ac|go|info|biz)(?:\s|$))/g, ".")
    .replace(/(?<=[a-z0-9-])\.?(co|or|ne|ac|go|ed)\.?jp\b/i, ".$1.jp")
    .replace(/(?<=[a-z0-9-])\.?j+p$/i, ".jp");
  return line.slice(0, at + 1) + domain;
}

function emailIn(lines: string[]): string | undefined {
  for (const l of lines) {
    const m = EMAIL.exec(repairDomain(compactAt(l)));
    if (m) return m[0];
  }
  return undefined;
}

/** 英語モデルの結果を優先。 */
function findEmail(lines: string[], latinLines: string[]): string | undefined {
  const latin = emailIn(latinLines);
  const ja = emailIn(lines);
  // 先頭や区切りの点が欠けただけなら長い方。
  if (latin && ja && (ja.endsWith(latin) || alnum(ja) === alnum(latin))) return ja.length > latin.length ? ja : latin;
  return latin ?? ja;
}

interface PhoneHit {
  phone: string;
  digits: string;
  mobile: boolean;
  fax: boolean;
}

/** 国内の番号として桁が合うものだけ。郵便番号の 070-0031 のような短い並びを除く。 */
function validDigits(digits: string): boolean {
  const national = digits.replace(/^810?/, "0");
  return /^0\d{9,10}$/.test(national);
}

/** 番号の中の読み違いを直す: 長音・各種ダッシュ → ハイフン、1lii → 1111、0S → 05。 */
function repairDigits(line: string): string {
  return line
    .replace(/(?<=\d)[‐-―−ー~](?=\d)/g, "-")
    .replace(/(?<![A-Za-z])[(+0-9][0-9lIiOoSs()+.\s-]{8,}/g, (m) =>
      m.replace(/[lIi]/g, "1").replace(/[Oo]/g, "0").replace(/[Ss]/g, "5"),
    );
}

/** 電話らしい番号を全部拾う。同じ行では「FAX」より後ろの番号を FAX 扱いにする。 */
function phoneHits(lines: string[]): PhoneHit[] {
  const hits: PhoneHit[] = [];
  for (const line of lines) {
    const l = repairDigits(line);
    const faxAt = l.search(FAX);
    for (const m of l.matchAll(PHONE)) {
      const digits = m[0].replace(/\D/g, "");
      if (!validDigits(digits)) continue;
      const fax = faxAt >= 0 && m.index >= faxAt;
      hits.push({ phone: m[0].trim().replace(/[\s.]+/g, "-"), digits, mobile: MOBILE.test(digits), fax });
    }
  }
  return hits;
}

const distance = (a: string, b: string): number => {
  if (a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
};

/**
 * 電話: 数字は英語モデルの結果を信じ、「ファクス」など日本語のラベルは日本語モデルの同じ番号から引き継ぐ。
 * FAX は除き、携帯 (090/080/070) → それ以外の順 (同じなら先に出た番号)。
 */
function findPhone(lines: string[], latinLines: string[]): string | undefined {
  const ja = phoneHits(lines);
  const latin = phoneHits(latinLines);
  const merged = latin.map((h) => {
    const near = ja.reduce<PhoneHit | undefined>(
      (best, j) => (distance(j.digits, h.digits) < (best ? distance(best.digits, h.digits) : 4) ? j : best),
      undefined,
    );
    return { ...h, fax: h.fax || !!near?.fax };
  });
  const hits = (merged.length > 0 ? merged : ja).filter((h) => !h.fax);
  return (hits.find((h) => h.mobile) ?? hits[0])?.phone;
}

/** 部署・役職の行を分ける。「営業部部長」「開発本部 シニアエンジニア」「部長 山田太郎」(後ろは tail)。 */
function splitDeptTitle(line: string): { department?: string; title?: string; tail?: string } {
  const t = TITLE.exec(line);
  if (!t) return DEPARTMENT.test(line) ? { department: line } : {};
  // 英語の役職は行全体 (Senior Software Engineer・VP of Engineering)。
  if (LATIN_LINE.test(line)) return { title: line };
  const before = line.slice(0, t.index);
  const sp = before.lastIndexOf(" ");
  const lead = before.slice(sp + 1); // 役職語と同じ語にくっついている前置き
  const head = before.slice(0, sp + 1).trim();
  const after = line.slice(t.index + t[0].length).trim();
  // 「山田太郎 部長」: 氏名の後ろに役職。
  if (hasSurname(lead)) return { title: t[0], tail: lead };
  if (!lead && looksLikePerson(head)) return { title: t[0], tail: head };
  const split = LEAD_SPLIT.exec(lead);
  const deptLead = split?.[1] ?? "";
  const title = (split ? split[2] : lead) + t[0]; // 「シニア」+「エンジニア」
  // 「DX 推進室主査」は空白で切れた頭も部署名の一部。
  const deptParts = [head && (split || DEPARTMENT.test(head)) ? head : "", deptLead].filter(Boolean);
  return {
    department: deptParts.length > 0 ? deptParts.join(" ") : undefined,
    title,
    tail: after || undefined,
  };
}

function looksLikePerson(s: string): boolean {
  return (NAME_JA.test(s) || NAME_KATAKANA.test(s) || NAME_EN.test(s)) && !TAGLINE.test(s);
}

/** メールのドメインの社名部分 (フリーメールは無し)。 */
function emailOrg(email: string | undefined): string {
  const label = email?.split("@")[1]?.split(".")[0] ?? "";
  return FREE_MAIL.test(label) ? "" : alnum(label);
}

/** 英字の行がドメインの社名と同じか (Acme Robotics ↔ acme-robotics.com)。 */
function matchesOrg(line: string, org: string): boolean {
  const a = alnum(line);
  return org.length >= 3 && a.length >= 3 && (a.includes(org) || org.includes(a));
}

interface Candidate {
  text: string;
  index: number;
  size: number;
  /** 上下の行が部署・役職か。 */
  nextToRole: boolean;
  /** 上下の行がふりがな・ローマ字か。 */
  nextToReading: boolean;
  /** 名刺のいちばん上の行か (社名のことが多い)。 */
  top: boolean;
}

/** 氏名らしさ。0 以下は氏名として採らない。 */
function nameScore(c: Candidate, ctx: { email?: string; org: string; maxSize: number }): number {
  if (!looksLikePerson(c.text)) return 0;
  // カタカナだけの行は社名のことが多いので、形だけでは氏名にしない。
  let score = NAME_JA.test(c.text) ? 3 : NAME_KATAKANA.test(c.text) ? 0 : 1;
  if (hasSurname(c.text)) score += 4;
  if (COMPANY_WORD.test(c.text) || matchesOrg(c.text, ctx.org)) score -= 8;
  if (c.top && !hasSurname(c.text)) score -= 4;
  if (c.nextToRole) score += 2;
  if (c.nextToReading) score += 2;
  if (c.size > 0 && c.size >= ctx.maxSize * 0.9) score += 2;
  const local = alnum(ctx.email?.split("@")[0] ?? "");
  if (NAME_EN.test(c.text) && c.text.split(/\s+/).some((w) => w.length >= 3 && local.includes(alnum(w)))) score += 4;
  return score;
}

const COMPANY_CHARS = new RegExp(`^[${CJK}A-Za-z&'. -]+$`);
const COMPANY_BODY = new RegExp(`[${KANJI}\\u3041-\\u3096\\u30a1-\\u30fa]{2}|[A-Za-z]{3}`);

/** 法人格の無い社名に使える行か。OCR の崩れ (「ーー」)・住所・ふりがなを除く。 */
function companyShaped(s: string): boolean {
  return !/[\d,]/.test(s) && !TAGLINE.test(s) && !FURIGANA.test(s) && COMPANY_CHARS.test(s) && COMPANY_BODY.test(s);
}

function pickCompany(cands: Candidate[], org: string): string | undefined {
  const score = (c: Candidate): number =>
    (matchesOrg(c.text, org) ? 4 : 0) + (COMPANY_WORD.test(c.text) ? 4 : 0) + (c.top ? 1 : 0) + (c.nextToRole ? -1 : 0);
  const ok = cands.filter((c) => companyShaped(c.text));
  return ok.reduce<Candidate | undefined>((best, c) => (!best || score(c) > score(best) ? c : best), undefined)?.text;
}

const NAME_PIECE = new RegExp(`^[${CJK}]{1,4}$`);
// 罫線やロゴを読んだだけの行。
const SCRATCH = /^[\u30fc\s_=~|.,:;'"`-]+$/;

function sameRow(a: CardBox, b: CardBox): boolean {
  const overlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  const height = Math.min(a.y1 - a.y0, b.y1 - b.y0);
  const gap = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
  return overlap >= height / 2 && gap <= height * 3;
}

/**
 * 上から順に並べ、姓名の間が空いて 2 行に割れた氏名 (「佐々」「木陽子」) を 1 行に戻す。
 * 同じ高さに並ぶ短い日本語の断片だけを対象にする (別カラムの行はつながない)。
 */
function joinNamePieces(lines: CardLine[]): CardLine[] {
  const center = (l: CardLine): number => (l.bbox ? l.bbox.y0 + l.bbox.y1 : 0);
  const out: CardLine[] = [];
  for (const l of [...lines].sort((a, b) => center(a) - center(b))) {
    const i = out.findIndex((p) => p.bbox && l.bbox && sameRow(p.bbox, l.bbox) && NAME_PIECE.test(p.text) && NAME_PIECE.test(l.text));
    const prev = out[i];
    if (!prev?.bbox || !l.bbox) {
      out.push(l);
      continue;
    }
    const [a, b] = prev.bbox.x0 <= l.bbox.x0 ? [prev, l] : [l, prev];
    out[i] = {
      text: a.text + b.text,
      bbox: {
        x0: Math.min(prev.bbox.x0, l.bbox.x0),
        y0: Math.min(prev.bbox.y0, l.bbox.y0),
        x1: Math.max(prev.bbox.x1, l.bbox.x1),
        y1: Math.max(prev.bbox.y1, l.bbox.y1),
      },
    };
  }
  return out;
}

/**
 * 行の一覧 → 下書き。latinText = 英語モデルだけで読んだ全文 (数字と英字はこちらが正確なのでメール・電話に使う)。
 */
export function parseCardLines(input: CardLine[], latinText = ""): CardDraft {
  const lines = joinNamePieces(input.map((l) => ({ ...l, text: normalizeLine(l.text) })).filter((l) => !SCRATCH.test(l.text)))
    .map((l) => ({ text: l.text, size: l.bbox ? l.bbox.y1 - l.bbox.y0 : 0 }))
    .filter((l) => l.text.length >= 2);
  const texts = lines.map((l) => l.text);
  const latinLines = latinText.split(/\r?\n/).map(normalizeLine);
  const out: CardDraft = {};
  const email = findEmail(texts, latinLines);
  if (email) out.email = email;
  const phone = findPhone(texts, latinLines);
  if (phone) out.phone = phone;

  const rest = lines.filter((l) => !l.text.includes("@") && !NUMBERS.test(l.text) && !TEL.test(l.text) && !NOISE.test(l.text));
  const legal = rest.filter((l) => LEGAL.test(l.text));
  const company = legal.reduce<(typeof rest)[number] | undefined>((best, l) => (!best || l.size > best.size ? l : best), undefined);
  if (company) out.companyName = company.text;

  const isRole = rest.map((l) => {
    if (legal.includes(l)) return null;
    // 氏名の形で名字が当たる行は部署語で終わっていても氏名 (長谷部)。
    if (!TITLE.test(l.text) && NAME_JA.test(l.text) && hasSurname(l.text)) return null;
    const dt = splitDeptTitle(l.text);
    return dt.title || dt.department ? dt : null;
  });
  const reading = (l: (typeof rest)[number] | undefined): boolean =>
    !!l && (FURIGANA.test(l.text) || (NAME_EN.test(l.text) && !matchesOrg(l.text, emailOrg(email))));
  const cands: Candidate[] = [];
  rest.forEach((l, i) => {
    const near = [i - 1, i + 1];
    const base = {
      index: i,
      size: l.size,
      top: i === 0,
      nextToRole: near.some((j) => !!isRole[j]),
      nextToReading: near.some((j) => reading(rest[j])),
    };
    const dt = isRole[i];
    if (dt) {
      if (dt.title) out.title ??= dt.title;
      if (dt.department) out.department = out.department ? `${out.department} ${dt.department}` : dt.department;
      if (dt.tail) cands.push({ ...base, text: dt.tail, nextToRole: true });
      return;
    }
    if (!legal.includes(l) && !FURIGANA.test(l.text)) cands.push({ ...base, text: l.text });
  });

  const org = emailOrg(email);
  const maxSize = Math.max(0, ...cands.map((c) => c.size));
  const ctx = { email, org, maxSize };
  const name = cands.reduce<Candidate | undefined>(
    (best, c) => (nameScore(c, ctx) > (best ? nameScore(best, ctx) : 0) ? c : best),
    undefined,
  );
  if (name) out.personName = name.text;
  if (!company) {
    // 法人格の無い社名: 氏名に選ばなかった行から。氏名と同じ人のローマ字表記は除く。
    const isRomaji = (c: Candidate): boolean =>
      !!name && NAME_JA.test(name.text) && NAME_EN.test(c.text) && Math.abs(c.index - name.index) === 1;
    const left = cands.filter((c) => c !== name && !isRomaji(c));
    const brand = pickCompany(left, org);
    if (brand) out.companyName = brand;
  }
  return out;
}

export function parseCardText(text: string, latinText = ""): CardDraft {
  return parseCardLines(text.split(/\r?\n/).map((l) => ({ text: l })), latinText);
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
