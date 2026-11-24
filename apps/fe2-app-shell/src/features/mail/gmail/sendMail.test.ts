import { describe, expect, it } from "vitest";
import { auth } from "@dub/types";
import { ApiError } from "../../../lib/api-client.tsx";
import { failureReason } from "./sendMail.ts";

const apiError = (status: number, code: string) => new ApiError(status, { error: { code, message: "x" } } as ConstructorParameters<typeof ApiError>[1]);

describe("sendMail failureReason", () => {
  it("代理表示中のブロックは権限不足と区別して代理表示の文言を出す", () => {
    expect(failureReason(apiError(403, "IMPERSONATION_ACTION_BLOCKED"))).toBe(auth.IMPERSONATION_BLOCKED_MESSAGE);
  });
  it("通常の 403 は送信権限なし", () => {
    expect(failureReason(apiError(403, "FORBIDDEN"))).toBe("メールを送信する権限がありません");
  });
  it("413 は添付サイズ", () => {
    expect(failureReason(apiError(413, "PAYLOAD_TOO_LARGE"))).toBe("添付ファイルが大きすぎるため送信できませんでした");
  });
});
