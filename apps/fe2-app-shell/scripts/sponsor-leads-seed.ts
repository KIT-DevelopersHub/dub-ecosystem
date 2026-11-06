// スポンサー営業進捗の初期データを、手元の Excel から D1 投入用の SQL にする。
// データはこのリポジトリ (公開) に入れない: 入力も出力もリポジトリの外に置き、SQL をコミットしない。
//
//   pnpm -C infra/d1 exec tsx "$PWD/apps/fe2-app-shell/scripts/sponsor-leads-seed.ts" <営業進捗管理.xlsm の絶対パス> <出力.sql の絶対パス>
//
// 列の読み方は画面の取り込みと同じ parseLeadSheet。マクロは実行せず、シートの値だけを読む。
// 同じ企業名の行が既にあれば入れないので、再実行しても増えない。適用手順は docs/sponsor-app.md。
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { common, sponsor } from "@dub/types";
import { parseLeadSheet } from "../src/features/sponsor/leadImport.ts";

const DATE_COLUMNS = new Set(["初回連絡日", "最終接触日", "提案日", "内諾日", "次回アクション日"]);
const COLUMNS: readonly [string, keyof sponsor.LeadFields][] = [
  ["company_name", "companyName"], ["industry", "industry"], ["owner", "owner"], ["contact_name", "contactName"], ["contact_role", "contactRole"],
  ["contact_email", "contactEmail"], ["source", "source"], ["contact_type", "contactType"], ["evidence", "evidence"], ["priority", "priority"],
  ["plan", "plan"], ["status", "status"], ["first_contact_on", "firstContactOn"], ["last_contact_on", "lastContactOn"], ["proposed_on", "proposedOn"],
  ["agreed_on", "agreedOn"], ["next_action", "nextAction"], ["next_action_on", "nextActionOn"], ["expected_amount", "expectedAmount"],
  ["confidence", "confidence"], ["budget_period", "budgetPeriod"], ["decision_period", "decisionPeriod"], ["note", "note"],
];

const unzip = (book: string, ...args: string[]): string => execFileSync("unzip", [...args, book], { encoding: "utf8", maxBuffer: 1 << 28 });
const entry = (book: string, name: string): string => execFileSync("unzip", ["-p", book, name], { encoding: "utf8", maxBuffer: 1 << 28 });

const unescapeXml = (s: string): string =>
  s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

const texts = (xml: string): string => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1]!)).join("");

function columnIndex(ref: string): number {
  return [...ref.replace(/\d+$/, "")].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
}

function quoteCell(s: string): string {
  return /[\t\n"]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** シートの XML → 画面に貼り付けるのと同じタブ区切り (日付は yyyy/mm/dd)。 */
function sheetToTsv(xml: string, shared: readonly string[]): string {
  const rows: string[][] = [];
  for (const row of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells: string[] = [];
    for (const cell of (row[1] ?? "").matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1]!;
      const body = cell[2] ?? "";
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      if (!ref) continue;
      const type = /\bt="(\w+)"/.exec(attrs)?.[1];
      const column = columnIndex(ref);
      const header = rows[0]?.[column] ?? "";
      if (type === "inlineStr") cells[column] = texts(body);
      else if (value === undefined) continue;
      else if (type === "s") cells[column] = shared[Number(value)] ?? "";
      else if (type === "str") cells[column] = unescapeXml(value);
      else if (DATE_COLUMNS.has(header)) cells[column] = new Date(Date.UTC(1899, 11, 30) + Number(value) * 86_400_000).toISOString().slice(0, 10);
      else cells[column] = value.replace(/\.0+$/, "");
    }
    rows.push(Array.from(cells, (c) => c ?? ""));
  }
  return rows.map((r) => r.map(quoteCell).join("\t")).join("\n");
}

function sql(value: unknown): string {
  if (value === undefined || value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function main(): void {
  const [book, out] = process.argv.slice(2);
  if (!book || !out) {
    console.error("usage: sponsor-leads-seed.ts <book.xlsx|xlsm> <out.sql>");
    process.exit(2);
  }
  const repoRoot = resolve(fileURLToPath(import.meta.url), "../../../..");
  if (resolve(out).startsWith(repoRoot + sep)) {
    console.error("出力先はリポジトリの外にしてください (実データをコミットしないため)。");
    process.exit(2);
  }

  const shared = [...entry(book, "xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]!));
  const sheets = unzip(book, "-Z1").split("\n").filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n));
  const parsed = sheets.map((name) => parseLeadSheet(sheetToTsv(entry(book, name), shared))).find((p) => p.leads.length > 0);
  if (!parsed) throw new Error("「企業名」の見出しがあるシートが見つかりません");
  if (parsed.errors.length > 0) throw new Error(parsed.errors.join("\n"));

  const now = new Date().toISOString();
  const seen = new Set<string>();
  const statements: string[] = [];
  for (const lead of parsed.leads) {
    const key = sponsor.companyKey(lead.companyName);
    if (seen.has(key)) continue;
    seen.add(key);
    const id = `lead_seed_${String(seen.size).padStart(3, "0")}`;
    const values = COLUMNS.map(([, field]) => sql(field === "status" ? (lead.status ?? "未接触") : lead[field]));
    statements.push(
      `INSERT INTO member_sponsor_leads (id, org_id, ${COLUMNS.map(([c]) => c).join(", ")}, version, created_by, created_by_name, created_at, updated_at)\n` +
        `  SELECT ${sql(id)}, ${sql(common.DUB_DEFAULT_ORG_ID)}, ${values.join(", ")}, 1, 'sheet_seed', 'スプレッドシートから移行', ${sql(now)}, ${sql(now)}\n` +
        `  WHERE NOT EXISTS (SELECT 1 FROM member_sponsor_leads WHERE org_id = ${sql(common.DUB_DEFAULT_ORG_ID)} AND company_name = ${sql(lead.companyName)} AND archived_at IS NULL);`,
    );
  }
  writeFileSync(out, `${statements.join("\n")}\n`, { mode: 0o600 });
  console.log(`${statements.length} 社の SQL を書き出しました (読めない値 ${parsed.warnings.length} 件)。`);
  for (const w of parsed.warnings) console.log(`  ${w.replace(/^[^:]*: /, "")}`);
}

main();
