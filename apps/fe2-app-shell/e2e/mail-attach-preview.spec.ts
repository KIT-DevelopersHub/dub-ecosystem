// Compose-attachment in-place PREVIEW E2E (real browser, DEMO transport). Attaches an image,
// a text file, a pdf and a zip to a draft, then clicks each chip to open the preview modal —
// image inline, text panel, pdf embedded viewer, unsupported → download fallback — navigating
// with 次へ. Screenshots land in ~/DubVault/docs/mail-attach-preview/ for the PR / review.
import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SHOTS = join(homedir(), "DubVault", "docs", "mail-attach-preview");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => join(SHOTS, name);

const TMP = join(SHOTS, ".fixtures");
mkdirSync(TMP, { recursive: true });

// A tiny valid PDF (correct xref offsets) so chromium's embedded viewer renders it cleanly.
function buildPdf(): Buffer {
  const stream = "BT /F1 24 Tf 40 110 Td (Dub PDF preview) Tj ET";
  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  bodies.forEach((body, i) => {
    const n = i + 1;
    offsets[n] = Buffer.byteLength(pdf, "latin1");
    pdf += `${n} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf, "latin1");
  pdf += "xref\n0 6\n0000000000 65535 f \n";
  for (let n = 1; n <= 5; n++) pdf += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

const PNG_8x8 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFElEQVR4nGNkYPhfz0AEYBpVSF+FAP7pAv4prsMnAAAAAElFTkSuQmCC",
  "base64",
);
const imgPath = join(TMP, "設計スケッチ.png");
const txtPath = join(TMP, "仕様メモ.txt");
const pdfPath = join(TMP, "資料.pdf");
const zipPath = join(TMP, "backup.zip");
writeFileSync(imgPath, PNG_8x8);
writeFileSync(txtPath, "# 仕様メモ\n\n- 添付プレビュー機能\n- 画像 / PDF / テキスト / 非対応フォールバック\n- 送信前・サーバ往復なし");
writeFileSync(pdfPath, buildPdf());
writeFileSync(zipPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]));

test("draft attachment preview: image / text / pdf / unsupported with prev-next", async ({ page }) => {
  await page.goto("/mail");
  await page.addStyleTag({ content: '[role="note"]{display:none !important}' });
  await expect(page.getByTestId("fe2-mail-gmail")).toBeVisible();

  await page.getByTestId("fe2-mail-compose-open").click();
  await expect(page.getByTestId("fe2-mail-compose-window")).toBeVisible();
  await page.getByTestId("fe2-mail-compose-to").fill("teammate@example.com");
  await page.getByTestId("fe2-mail-compose-subject").fill("添付プレビュー確認");
  await page.getByTestId("fe2-mail-compose-attach-input").setInputFiles([imgPath, txtPath, pdfPath, zipPath]);
  await expect(page.getByTestId("fe2-mail-attach-chip")).toHaveCount(4);

  // (1) image inline
  await page.getByTestId("fe2-mail-attach-chip").first().click();
  await expect(page.getByTestId("fe2-mail-attach-preview")).toBeVisible();
  await expect(page.getByTestId("fe2-mail-preview-image")).toBeVisible();
  await expect(page.getByTestId("fe2-mail-preview-counter")).toHaveText("1 / 4");
  await page.waitForTimeout(350); // let the modal entrance animation settle before capture
  await page.screenshot({ path: shot("01-image-preview.png"), fullPage: true });

  // (2) text panel shows content
  await page.getByTestId("fe2-mail-preview-next").click();
  await expect(page.getByTestId("fe2-mail-preview-text")).toContainText("添付プレビュー機能");
  await page.screenshot({ path: shot("02-text-preview.png"), fullPage: true });

  // (3) pdf embedded viewer
  await page.getByTestId("fe2-mail-preview-next").click();
  await expect(page.getByTestId("fe2-mail-preview-pdf")).toBeVisible();
  await page.waitForTimeout(600); // let the embedded PDF viewer paint
  await page.screenshot({ path: shot("03-pdf-preview.png"), fullPage: true });

  // (4) unsupported → download fallback
  await page.getByTestId("fe2-mail-preview-next").click();
  await expect(page.getByTestId("fe2-mail-preview-unsupported")).toBeVisible();
  await expect(page.getByTestId("fe2-mail-preview-download")).toBeVisible();
  await page.screenshot({ path: shot("04-unsupported-fallback.png"), fullPage: true });

  // close returns to the draft with attachments intact
  await page.locator('[data-testid="fe2-mail-attach-preview"]').getByRole("button", { name: "閉じる" }).click();
  await expect(page.getByTestId("fe2-mail-attach-preview")).toBeHidden();
  await expect(page.getByTestId("fe2-mail-attach-chip")).toHaveCount(4);
});
