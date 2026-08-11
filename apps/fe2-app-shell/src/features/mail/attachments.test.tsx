import { describe, it, expect } from "vitest";
import { attachmentDownloadPath, fileToAttachment, formatBytes } from "./mailApi.tsx";

describe("mailApi attachment helpers", () => {
  // jsdom's Blob/File lacks arrayBuffer(); stub a File-like carrying the fields used.
  const fileLike = (name: string, type: string, bytes: Uint8Array): File =>
    ({ name, type, size: bytes.byteLength, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } as unknown as File);

  it("fileToAttachment reads a File into base64 + metadata", async () => {
    const att = await fileToAttachment(fileLike("note.txt", "text/plain", new TextEncoder().encode("hello world")));
    expect(att.filename).toBe("note.txt");
    expect(att.contentType).toBe("text/plain");
    expect(atob(att.contentBase64)).toBe("hello world");
  });

  it("fileToAttachment falls back to octet-stream when the File has no type", async () => {
    const att = await fileToAttachment(fileLike("blob.bin", "", new Uint8Array([1, 2, 3])));
    expect(att.contentType).toBe("application/octet-stream");
  });

  it("attachmentDownloadPath builds the encoded same-origin route", () => {
    expect(attachmentDownloadPath("messages", "mailin_1", "mailatt_9")).toBe("/api/v1/mail/messages/mailin_1/attachments/mailatt_9");
    expect(attachmentDownloadPath("sent", "a b", "c/d")).toBe("/api/v1/mail/sent/a%20b/attachments/c%2Fd");
  });

  it("formatBytes renders human sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
