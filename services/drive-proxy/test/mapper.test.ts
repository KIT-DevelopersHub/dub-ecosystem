import { describe, it, expect } from "vitest";
import { isDubError, CommonErrorCodes } from "@dub/errors";
import { kindOf, toDriveFile, embedUrlFor, editUrlFor, mapGoogleError } from "../src/google/mapper";

describe("kindOf", () => {
  it("maps Google-native and common mime types", () => {
    expect(kindOf("application/vnd.google-apps.document")).toBe("doc");
    expect(kindOf("application/vnd.google-apps.spreadsheet")).toBe("sheet");
    expect(kindOf("application/vnd.google-apps.presentation")).toBe("slide");
    expect(kindOf("application/vnd.google-apps.form")).toBe("form");
    expect(kindOf("application/vnd.google-apps.folder")).toBe("folder");
    expect(kindOf("application/pdf")).toBe("pdf");
    expect(kindOf("image/png")).toBe("image");
    expect(kindOf("application/zip")).toBe("other");
  });
});

describe("toDriveFile", () => {
  it("projects to the frozen DriveFile shape", () => {
    const f = toDriveFile({ id: "x", name: "N", mimeType: "text/plain", modifiedTime: "2026-08-09T00:00:00Z" });
    expect(f).toEqual({ id: "x", name: "N", mimeType: "text/plain", modifiedAt: "2026-08-09T00:00:00Z" });
  });
  it("defaults missing modifiedTime", () => {
    expect(toDriveFile({ id: "x", name: "N", mimeType: "text/plain" }).modifiedAt).toBe(new Date(0).toISOString());
  });
});

describe("embedUrlFor", () => {
  it("returns kind-specific embed URLs for all embeddable kinds", () => {
    expect(embedUrlFor("i", "doc")).toBe("https://docs.google.com/document/d/i/preview");
    expect(embedUrlFor("i", "sheet")).toBe("https://docs.google.com/spreadsheets/d/i/preview");
    expect(embedUrlFor("i", "slide")).toBe("https://docs.google.com/presentation/d/i/embed");
    expect(embedUrlFor("i", "form")).toBe("https://docs.google.com/forms/d/i/viewform?embedded=true");
    expect(embedUrlFor("i", "pdf")).toBe("https://drive.google.com/file/d/i/preview");
    expect(embedUrlFor("i", "image")).toBe("https://drive.google.com/file/d/i/preview");
    expect(embedUrlFor("i", "other")).toBe("https://drive.google.com/file/d/i/preview");
  });
  it("rejects folders", () => {
    try {
      embedUrlFor("i", "folder");
      throw new Error("expected throw");
    } catch (e) {
      expect(isDubError(e)).toBe(true);
      expect((e as { code: string }).code).toBe(CommonErrorCodes.VALIDATION_FAILED);
    }
  });
});

describe("editUrlFor", () => {
  it("returns editor URLs, falling back to webViewLink", () => {
    expect(editUrlFor("i", "doc")).toBe("https://docs.google.com/document/d/i/edit");
    expect(editUrlFor("i", "pdf", "https://wv")).toBe("https://wv");
  });
});

describe("mapGoogleError (§6 conversion table)", () => {
  const cases: [number, string][] = [
    [400, CommonErrorCodes.VALIDATION_FAILED],
    [401, CommonErrorCodes.UPSTREAM_UNAVAILABLE],
    [403, CommonErrorCodes.FORBIDDEN],
    [404, CommonErrorCodes.NOT_FOUND],
    [409, CommonErrorCodes.CONFLICT],
    [429, CommonErrorCodes.RATE_LIMITED],
    [500, CommonErrorCodes.UPSTREAM_UNAVAILABLE],
    [503, CommonErrorCodes.UPSTREAM_UNAVAILABLE],
    [504, CommonErrorCodes.UPSTREAM_TIMEOUT],
  ];
  it.each(cases)("maps HTTP %i to %s", (status, code) => {
    const e = mapGoogleError(status, { error: { message: "boom" } });
    expect(e.code).toBe(code);
  });
  it("passes Retry-After through for 429", () => {
    const e = mapGoogleError(429, null, 30);
    expect(e.code).toBe(CommonErrorCodes.RATE_LIMITED);
    expect((e.details as { retryAfterSec: number }).retryAfterSec).toBe(30);
  });
  it("never leaks the raw Google message for credential/5xx", () => {
    expect(mapGoogleError(401, { error: { message: "invalid_grant secret" } }).message).not.toContain("secret");
    expect(mapGoogleError(500, { error: { message: "stacktrace" } }).message).not.toContain("stacktrace");
  });
});
