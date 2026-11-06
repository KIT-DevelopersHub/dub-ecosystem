// スプレッドシートから貼り付けた表 (タブ区切り) を営業先の行に変換する純関数。
// 列は見出しで対応付けるので、列の順番が変わっても、余分な列があってもよい。
// 読み取れない値は空にして警告で知らせ、長すぎる値は取り込みを止める (サーバは 1 行でも不正なら全件を拒否する)。
import { sponsor } from "@dub/types";

type Key = keyof sponsor.CreateLeadRequest;

/** 見出し → 項目。 */
const HEADERS: Record<string, Key> = {
  企業名: "companyName",
  業界: "industry",
  営業担当: "owner",
  企業側担当者: "contactName",
  "企業側部署・役職": "contactRole",
  "接点・紹介元": "source",
  検討プラン: "plan",
  ステータス: "status",
  初回連絡日: "firstContactOn",
  最終接触日: "lastContactOn",
  次回アクション: "nextAction",
  次回アクション日: "nextActionOn",
  想定協賛額: "expectedAmount",
  確度: "confidence",
  "予算年度・時期": "budgetPeriod",
  決裁予定時期: "decisionPeriod",
  メモ: "note",
  "担当者メール(業務用)": "contactEmail",
  接点区分: "contactType",
  "根拠・確認日": "evidence",
  連絡優先度: "priority",
};

/** 「値なし」の意味で手入力された表記 (空として扱う)。 */
const NONE_WORDS = new Set(["なし", "無し", "-", "ー", "—", "未定"]);

/** タブ区切りを行と列に分ける。改行やタブを含むセルは " で囲まれて届く。 */
export function parseTsv(input: string): string[][] {
  const text = input.replace(/\r\n?/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  const endCell = () => {
    row.push(cell);
    cell = "";
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"' && cell === "") {
      const close = closingQuote(text, i + 1);
      if (close !== -1) {
        cell = text.slice(i + 1, close).replaceAll('""', '"');
        i = close + 1;
        continue;
      }
    }
    if (ch === "\t") {
      endCell();
    } else if (ch === "\n") {
      endCell();
      rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
    i += 1;
  }
  if (cell !== "" || row.length > 0) {
    endCell();
    rows.push(row);
  }
  return rows;
}

/**
 * 開始位置以降で閉じる " の位置。無ければ -1 (その " はただの文字)。
 * セルの中にタブは入らないので、タブを跨ぐものや、セルの終わりに続かないものは引用と見なさない。
 */
function closingQuote(text: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === "\t") return -1;
    if (text[i] !== '"') continue;
    if (text[i + 1] === '"') {
      i += 1;
      continue;
    }
    const next = text[i + 1];
    return next === undefined || next === "\t" || next === "\n" ? i : -1;
  }
  return -1;
}

/** 2026/9/1・2026-09-01・2026年9月1日 → 2026-09-01。読めなければ null。 */
export function parseDate(raw: string): string | null {
  const m = /^(\d{4})[/.\-年](\d{1,2})[/.\-月](\d{1,2})日?$/.exec(raw.normalize("NFKC").trim());
  if (!m) return null;
  const iso = `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

/** ¥300,000・300000 → 300000。読めなければ null。 */
export function parseAmount(raw: string): number | null {
  const t = raw.normalize("NFKC").replace(/[¥,\s]|円$/g, "");
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n <= sponsor.LEAD_AMOUNT_MAX ? n : null;
}

export interface ParsedLeads {
  leads: sponsor.CreateLeadRequest[];
  /** 見出し行が見つからない。 */
  noHeader: boolean;
  /** 空にした値・読まなかった列の説明。 */
  warnings: string[];
  /** 長すぎて保存できない値の説明。1 件でもあれば取り込めない。 */
  errors: string[];
}

const DATE_KEYS: readonly Key[] = ["firstContactOn", "lastContactOn", "nextActionOn"];
const CHOICES: Partial<Record<Key, readonly string[]>> = {
  plan: sponsor.LEAD_PLANS,
  confidence: sponsor.LEAD_CONFIDENCES,
  priority: sponsor.LEAD_PRIORITIES,
};

const LONG_KEYS: readonly Key[] = ["note", "evidence"];

const normalizeHeader = (h: string): string => h.normalize("NFKC").replace(/\s/g, "").replace(/\(任意\)$/, "");

function labelOf(key: Key): string {
  return Object.keys(HEADERS).find((h) => HEADERS[h] === key) ?? key;
}

export function parseLeadSheet(input: string): ParsedLeads {
  const rows = parseTsv(input);
  const headerAt = rows.findIndex((r) => r.some((c) => normalizeHeader(c) === "企業名"));
  if (headerAt === -1) return { leads: [], noHeader: true, warnings: [], errors: [] };
  const headers = rows[headerAt]!;
  const columns = headers.map((h) => HEADERS[normalizeHeader(h)]);

  const leads: sponsor.CreateLeadRequest[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const unread = headers.filter((h, i) => !columns[i] && h.trim() !== "" && h.trim() !== "No.");
  if (unread.length > 0) warnings.push(`次の列は読み取りません: ${unread.join("、")}`);

  rows.slice(headerAt + 1).forEach((cells) => {
    const lead: Record<string, unknown> = {};
    const dropped: string[] = [];
    const tooLong: string[] = [];
    columns.forEach((key, i) => {
      const value = cells[i]?.trim() ?? "";
      if (!key || value === "") return;
      const choices = key === "status" ? sponsor.LEAD_STATUSES : CHOICES[key];
      if (choices?.includes(value)) {
        lead[key] = value;
      } else if (key === "companyName") {
        lead[key] = value;
      } else if (NONE_WORDS.has(value)) {
        return;
      } else if (choices || DATE_KEYS.includes(key) || key === "expectedAmount") {
        const parsed = choices ? null : key === "expectedAmount" ? parseAmount(value) : parseDate(value);
        if (parsed !== null) lead[key] = parsed;
        else dropped.push(`${labelOf(key)}「${value}」`);
      } else if (value.length > (LONG_KEYS.includes(key) ? sponsor.CARD_NOTE_MAX : sponsor.CARD_FIELD_MAX)) {
        tooLong.push(labelOf(key));
      } else {
        lead[key] = value;
      }
    });
    if (typeof lead.companyName !== "string") return;
    leads.push(lead as sponsor.CreateLeadRequest);
    if (lead.companyName.length > sponsor.CARD_FIELD_MAX) tooLong.push(labelOf("companyName"));
    const name = lead.companyName.slice(0, 40);
    if (dropped.length > 0) warnings.push(`${name}: ${dropped.join("・")} は読み取れないため空にします`);
    if (tooLong.length > 0) errors.push(`${name}: ${tooLong.join("・")} が長すぎます`);
  });
  return { leads, noHeader: false, warnings, errors };
}
