// 運営名簿のダウンロード(CSV / Excel / PDF)。画面で絞り込み・並べ替え済みの行をそのまま
// 書き出す。列は操作列を除く全データ列(表示列ピッカーの状態には依存しない)。
// 外部ライブラリは使わない: xlsx は最小構成の OOXML を無圧縮 zip で、PDF はブラウザの
// 日本語フォントで canvas に描いたページ画像(JPEG)を 1 枚ずつ埋め込んで生成する。
import type { MemberTeam, OrgMember } from "./contracts.ts";
import { statusLabel } from "./memberStatus.ts";

export type RosterExportFormat = "csv" | "xlsx" | "pdf";

export interface RosterTable {
  headers: string[];
  rows: string[][];
}

const join = (parts: (string | null | undefined)[], sep: string): string =>
  parts.filter((x): x is string => !!x && x.trim().length > 0).join(sep);

export function buildRosterTable(
  members: OrgMember[],
  ctx: { teamsById: Map<string, MemberTeam>; accountLabels: Map<string, string>; leaderNames: Map<string, string> },
): RosterTable {
  const headers = [
    "氏名", "フリガナ", "名列番号", "氏名（ローマ字）", "学科", "学年", "担当・役割", "リーダー", "ステータス",
    "developershub.jpメール", "所属チーム", "連絡先", "学校メール", "Gmail",
  ];
  const rows = members.map((m) => [
    m.name,
    join([m.lastNameKana, m.firstNameKana], " "),
    m.rosterNumber ?? "",
    join([m.lastNameRomaji, m.firstNameRomaji], " "),
    m.department ?? "",
    m.grade ?? "",
    m.roleTitle ?? "",
    m.leaderId ? ctx.leaderNames.get(m.leaderId) ?? "" : "",
    statusLabel(m.status),
    m.identityUserId ? ctx.accountLabels.get(m.identityUserId) ?? m.identityUserId : "",
    m.teamIds.map((id) => ctx.teamsById.get(id)?.name ?? "").filter(Boolean).join("、"),
    m.contact ?? "",
    m.schoolEmail ?? "",
    m.gmail ?? "",
  ]);
  return { headers, rows };
}

// ---- CSV -------------------------------------------------------------------------------

// 表計算ソフトでの数式解釈(CSV injection)を防ぐ。電話番号の "+81" 等は数字が続くので対象外。
function neutralizeFormula(v: string): string {
  return /^[=@\t\r]/.test(v) || /^[+-][^\d\s]/.test(v) ? `'${v}` : v;
}

function csvCell(v: string): string {
  const s = neutralizeFormula(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Excel で文字化けしないよう UTF-8 BOM 付き・CRLF 改行。 */
export function toCsv(t: RosterTable): string {
  return "﻿" + [t.headers, ...t.rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// ---- XLSX (minimal OOXML in a stored zip) ----------------------------------------------

const enc = new TextEncoder();

function xmlEscape(s: string): string {
  // XML 1.0 で不正な制御文字は落とす(タブ・改行は残す)。
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function colName(i: number): string {
  let n = i + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function sheetXml(t: RosterTable): string {
  const all = [t.headers, ...t.rows];
  const widths = t.headers.map((_, c) =>
    Math.min(50, Math.max(8, ...all.map((r) => [...(r[c] ?? "")].reduce((w, ch) => w + (ch.charCodeAt(0) > 0xff ? 2 : 1), 0) + 2))),
  );
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
  const rows = all
    .map((r, ri) => {
      const cells = r
        .map((v, ci) => (v ? `<c r="${colName(ci)}${ri + 1}" t="inlineStr"${ri === 0 ? ' s="1"' : ""}><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>` : ""))
        .join("");
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<cols>${cols}</cols><sheetData>${rows}</sheetData></worksheet>`
  );
}

const XLSX_STATIC: Record<string, string> = {
  "[Content_Types].xml":
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
  "_rels/.rels":
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  "xl/workbook.xml":
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="運営名簿" sheetId="1" r:id="rId1"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels":
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
  // s="1" = 見出し行(太字)。
  "xl/styles.xml":
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
    "</styleSheet>",
};

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** 無圧縮(store) zip。ファイル名は UTF-8 フラグ付き。 */
export function zipStore(files: { name: string; data: Uint8Array }[]): Uint8Array<ArrayBuffer> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, f.data.length, true);
    lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, f.data);
    centrals.push(central);
    offset += local.length + f.data.length;
  }
  const cd = concat(centrals);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cd.length, true);
  ev.setUint32(16, offset, true);
  return concat([...locals, cd, end]);
}

export function toXlsx(t: RosterTable): Uint8Array<ArrayBuffer> {
  const files = Object.entries({ ...XLSX_STATIC, "xl/worksheets/sheet1.xml": sheetXml(t) }).map(([name, xml]) => ({
    name,
    data: enc.encode(xml),
  }));
  return zipStore(files);
}

// ---- PDF (canvas-rendered pages embedded as JPEG) --------------------------------------

export interface JpegPage {
  jpeg: Uint8Array;
  pxWidth: number;
  pxHeight: number;
}

const latin1 = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** JPEG ページ画像を 1 ページ 1 枚で並べた PDF を組み立てる(A4 横 = 842x595pt)。 */
export function buildPdfFromJpegs(pages: JpegPage[], pageW = 842, pageH = 595): Uint8Array<ArrayBuffer> {
  const chunks: Uint8Array[] = [latin1("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")];
  const offsets: number[] = [];
  let pos = chunks[0]!.length;
  const push = (b: Uint8Array): void => {
    chunks.push(b);
    pos += b.length;
  };
  const obj = (id: number, body: Uint8Array[]): void => {
    offsets[id] = pos;
    push(latin1(`${id} 0 obj\n`));
    body.forEach(push);
    push(latin1("\nendobj\n"));
  };
  // 1 = catalog, 2 = pages, then per page: page, content, image.
  const pageIds = pages.map((_, i) => 3 + i * 3);
  obj(1, [latin1("<< /Type /Catalog /Pages 2 0 R >>")]);
  obj(2, [latin1(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`)]);
  pages.forEach((p, i) => {
    const pid = pageIds[i]!;
    const content = latin1(`q ${pageW} 0 0 ${pageH} 0 0 cm /Im0 Do Q`);
    obj(pid, [
      latin1(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im0 ${pid + 2} 0 R >> >> /Contents ${pid + 1} 0 R >>`,
      ),
    ]);
    obj(pid + 1, [latin1(`<< /Length ${content.length} >>\nstream\n`), content, latin1("\nendstream")]);
    obj(pid + 2, [
      latin1(
        `<< /Type /XObject /Subtype /Image /Width ${p.pxWidth} /Height ${p.pxHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`,
      ),
      p.jpeg,
      latin1("\nendstream"),
    ]);
  });
  const count = 3 + pages.length * 3;
  const xref = pos;
  let x = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id++) x += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  x += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  push(latin1(x));
  return concat(chunks);
}

const PDF_FONT = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic", Meiryo, sans-serif';
// 列幅の比率(buildRosterTable の headers と同順)。
const PDF_COL_WEIGHTS = [1.1, 1.2, 1.3, 1.0, 0.6, 1.2, 1.0, 0.8, 1.9, 1.3, 1.2, 1.9, 1.9];

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  if (!text) return [""];
  const lines: string[] = [];
  let line = "";
  for (const ch of text) {
    if (line && ctx.measureText(line + ch).width > maxW) {
      lines.push(line);
      line = ch;
    } else line += ch;
  }
  lines.push(line);
  return lines;
}

function canvasToJpeg(canvas: HTMLCanvasElement): Uint8Array {
  const b64 = canvas.toDataURL("image/jpeg", 0.92).split(",")[1] ?? "";
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export function toPdf(t: RosterTable, title: string, subtitle: string): Uint8Array<ArrayBuffer> {
  const W = 842, H = 595, M = 24, SCALE = 2.5; // pt, pt, margin pt, px per pt
  const FS = 7, LH = 9.5, PAD = 3, HEAD_H = 40, FOOT_H = 16;
  const tableW = W - M * 2;
  const total = PDF_COL_WEIGHTS.reduce((a, b) => a + b, 0);
  const colW = PDF_COL_WEIGHTS.map((w) => (w / total) * tableW);

  const measure = document.createElement("canvas").getContext("2d");
  if (!measure) throw new Error("canvas unsupported");
  const font = (bold: boolean): string => `${bold ? "bold " : ""}${FS}px ${PDF_FONT}`;
  const layout = (cells: string[], bold: boolean): { lines: string[][]; h: number } => {
    measure.font = font(bold);
    const lines = cells.map((c, i) => wrapText(measure, c, colW[i]! - PAD * 2));
    return { lines, h: Math.max(...lines.map((l) => l.length)) * LH + PAD * 2 };
  };
  const header = layout(t.headers, true);
  const body = t.rows.map((r) => layout(r, false));

  // ページ分割(各ページの先頭に見出し行を繰り返す)。
  const avail = H - M * 2 - HEAD_H - FOOT_H - header.h;
  const pages: (typeof body)[] = [];
  let cur: typeof body = [];
  let used = 0;
  for (const row of body) {
    if (cur.length > 0 && used + row.h > avail) {
      pages.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(row);
    used += row.h;
  }
  pages.push(cur);

  const out: JpegPage[] = pages.map((rows, pi) => {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(W * SCALE);
    canvas.height = Math.round(H * SCALE);
    const ctx = canvas.getContext("2d")!;
    ctx.scale(SCALE, SCALE);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = "top";
    ctx.fillStyle = "#111";
    ctx.font = `bold 14px ${PDF_FONT}`;
    ctx.fillText(title, M, M);
    ctx.font = `8px ${PDF_FONT}`;
    ctx.fillStyle = "#555";
    ctx.fillText(subtitle, M, M + 20);

    let y = M + HEAD_H;
    const drawRow = (r: { lines: string[][]; h: number }, bold: boolean, fill?: string): void => {
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fillRect(M, y, tableW, r.h);
      }
      ctx.font = font(bold);
      ctx.fillStyle = "#111";
      let x = M;
      r.lines.forEach((ls, ci) => {
        ls.forEach((l, li) => ctx.fillText(l, x + PAD, y + PAD + li * LH + (LH - FS) / 2));
        x += colW[ci]!;
      });
      ctx.strokeStyle = "#ccc";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(M, y + r.h);
      ctx.lineTo(M + tableW, y + r.h);
      ctx.stroke();
      y += r.h;
    };
    drawRow(header, true, "#eef1f5");
    rows.forEach((r, i) => drawRow(r, false, i % 2 === 1 ? "#fafafa" : undefined));
    // 縦罫線
    ctx.strokeStyle = "#ccc";
    ctx.beginPath();
    let x = M;
    for (let ci = 0; ci <= colW.length; ci++) {
      ctx.moveTo(x, M + HEAD_H);
      ctx.lineTo(x, y);
      x += colW[ci] ?? 0;
    }
    ctx.moveTo(M, M + HEAD_H);
    ctx.lineTo(M + tableW, M + HEAD_H);
    ctx.stroke();

    ctx.font = `7px ${PDF_FONT}`;
    ctx.fillStyle = "#777";
    const label = `${pi + 1} / ${pages.length}`;
    ctx.fillText(label, W - M - ctx.measureText(label).width, H - M);
    return { jpeg: canvasToJpeg(canvas), pxWidth: canvas.width, pxHeight: canvas.height };
  });
  return buildPdfFromJpegs(out, W, H);
}

// ---- download ---------------------------------------------------------------------------

const MIME: Record<RosterExportFormat, string> = {
  csv: "text/csv;charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};

function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

export function exportRoster(t: RosterTable, format: RosterExportFormat, now = new Date()): void {
  const subtitle = `出力日 ${now.toLocaleDateString("ja-JP")}　${t.rows.length} 名`;
  const data: BlobPart =
    format === "csv" ? toCsv(t) : format === "xlsx" ? toXlsx(t) : toPdf(t, "運営名簿", subtitle);
  const url = URL.createObjectURL(new Blob([data], { type: MIME[format] }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `運営名簿_${stamp(now)}.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
