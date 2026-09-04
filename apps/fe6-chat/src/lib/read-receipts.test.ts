import { afterEach, describe, expect, it, vi } from "vitest";
import type { common } from "@dub/types";
import { getReadersOf, getReceiptsVersion, resetReceipts, setReader, subscribeReceipts } from "./read-receipts";

const CH = "chn_1" as common.ChannelId;
const ME = "usr_me" as common.UserId;
const U1 = "usr_1" as common.UserId;
const U2 = "usr_2" as common.UserId;
const M1 = "msg_001" as common.MessageId;
const M2 = "msg_002" as common.MessageId;
const M3 = "msg_003" as common.MessageId;

afterEach(() => resetReceipts());

describe("read-receipts store", () => {
  it("reports readers whose watermark is at or past a message", () => {
    setReader(CH, U1, M2);
    setReader(CH, U2, M1);
    expect(getReadersOf(CH, M2).sort()).toEqual([U1]);
    expect(getReadersOf(CH, M1).sort()).toEqual([U1, U2]);
  });

  it("excludes the given ids (self / author)", () => {
    setReader(CH, ME, M3);
    setReader(CH, U1, M3);
    expect(getReadersOf(CH, M2, [ME])).toEqual([U1]);
  });

  it("never moves a watermark backwards", () => {
    setReader(CH, U1, M3);
    setReader(CH, U1, M1); // ignored — older
    expect(getReadersOf(CH, M3)).toEqual([U1]);
  });

  it("bumps the version and notifies only on a real advance", () => {
    const cb = vi.fn();
    subscribeReceipts(CH, cb);
    const v0 = getReceiptsVersion(CH);
    setReader(CH, U1, M2);
    expect(getReceiptsVersion(CH)).toBe(v0 + 1);
    setReader(CH, U1, M1); // no-op (older)
    expect(getReceiptsVersion(CH)).toBe(v0 + 1);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
