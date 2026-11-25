// 会計: 発行者情報の検査と正規化 (サーバと画面が同じ関数を使う)。
import { describe, expect, it } from "vitest";
import { accounting } from "../src";

const OK = { name: "一般社団法人 Developers Hub", taxRatePercent: 10 };

describe("accounting.normalizeInvoiceRegistrationNo", () => {
  it("accepts T + 13 digits, tolerating full-width digits, lower-case t, spaces and hyphens", () => {
    expect(accounting.normalizeInvoiceRegistrationNo("T1234567890123")).toBe("T1234567890123");
    expect(accounting.normalizeInvoiceRegistrationNo("ｔ１２３４５６７８９０１２３")).toBe("T1234567890123");
    expect(accounting.normalizeInvoiceRegistrationNo(" t 1-2345-6789-0123 ")).toBe("T1234567890123");
  });
  it("rejects anything else", () => {
    for (const bad of ["1234567890123", "T123456789012", "T12345678901234", "X1234567890123", "T12345678901a3", ""]) {
      expect(accounting.normalizeInvoiceRegistrationNo(bad)).toBeNull();
    }
  });
});

describe("accounting.invoiceRegistrationNoCheckDigitOk", () => {
  // 公表されている法人番号 (国税庁 法人番号公表サイト): 国税庁・内閣府・トヨタ自動車・ソニーグループ。
  it("accepts real 法人番号 with T", () => {
    for (const ok of ["T7000012050002", "T2000012010019", "T1180301018771", "T5010401067252"]) {
      expect(accounting.invoiceRegistrationNoCheckDigitOk(ok)).toBe(true);
    }
  });
  it("rejects a wrong check digit or a mistyped digit", () => {
    for (const bad of ["T8000012050002", "T7000012050003", "T7000012050020", "T1234567890123", "7000012050002", "T700001205000"]) {
      expect(accounting.invoiceRegistrationNoCheckDigitOk(bad)).toBe(false);
    }
  });
});

describe("accounting.parseIssuerInput", () => {
  it("normalizes and keeps a registration number whose check digit matches", () => {
    const r = accounting.parseIssuerInput({ ...OK, invoiceRegistrationNo: "ｔ７０００-０１２０-５０００２" });
    expect(r.ok && r.value.invoiceRegistrationNo).toBe("T7000012050002");
  });
  it("reports check_digit (not the shape error) when only the check digit is wrong", () => {
    const r = accounting.parseIssuerInput({ ...OK, invoiceRegistrationNo: "T1234567890123" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual([{ field: "invoiceRegistrationNo", reason: "check_digit" }]);
    expect(accounting.issuerErrorMessage(r.errors[0]!)).toBe("登録番号が正しくありません（T のすぐ後の確認用の数字が合いません）");
  });
  it("still reports the shape error for a malformed number", () => {
    const r = accounting.parseIssuerInput({ ...OK, invoiceRegistrationNo: "T12345" });
    expect(!r.ok && r.errors).toEqual([{ field: "invoiceRegistrationNo", reason: "invalid" }]);
  });
  it("trims, turns empty optionals into null and defaults the tax rate to 10%", () => {
    const r = accounting.parseIssuerInput({ name: "  法人  ", officeName: "", postalCode: "〒920-1234", phone: "０７６-０００-００００" });
    expect(r).toEqual({
      ok: true,
      value: { name: "法人", officeName: null, postalCode: "920-1234", address: null, phone: "076-000-0000", email: null, url: null, invoiceRegistrationNo: null, taxRatePercent: 10 },
    });
  });
  it("reports one error per bad field", () => {
    const r = accounting.parseIssuerInput({ ...OK, name: "", email: "nope", url: "developershub.jp", phone: "abc", taxRatePercent: 5, address: "a".repeat(201) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => `${e.field}:${e.reason}`).sort()).toEqual([
      "address:too_long", "email:invalid", "name:required", "phone:invalid", "taxRatePercent:invalid", "url:invalid",
    ]);
    expect(accounting.issuerErrorMessage({ field: "invoiceRegistrationNo", reason: "invalid" })).toContain("T と 13 桁");
  });
  it("rejects control characters (they would break the printed receipt)", () => {
    expect(accounting.parseIssuerInput({ ...OK, address: "金沢市\n1-2" }).ok).toBe(false);
  });
});

describe("accounting helpers", () => {
  it("formats the address line and computes the included tax", () => {
    expect(accounting.formatIssuerAddress({ postalCode: "920-1234", address: "石川県金沢市" })).toBe("〒920-1234 石川県金沢市");
    expect(accounting.formatIssuerAddress({ postalCode: null, address: null })).toBeNull();
    expect(accounting.taxIncluded(6000, 10)).toBe(545);
    expect(accounting.taxIncluded(6000, 8)).toBe(444);
  });
});
