import { describe, it, expect } from "vitest";
import {
  applyMention,
  detectMentionTrigger,
  extractMentions,
  extractTeamMentions,
  isMentioned,
  isTeamMentioned,
  mentionToken,
  mentionsMe,
  toPlainMentions,
} from "./mentions";

describe("extractMentions", () => {
  it("returns unique userIds in first-seen order", () => {
    expect(extractMentions("hi <@usr_a> and <@usr_b> and <@usr_a>")).toEqual(["usr_a", "usr_b"]);
  });
  it("isMentioned matches the specific user", () => {
    expect(isMentioned("<@usr_a>", "usr_a")).toBe(true);
    expect(isMentioned("<@usr_a>", "usr_b")).toBe(false);
  });
});

describe("extractTeamMentions (チーム単位メンション)", () => {
  it("returns unique teamIds in first-seen order", () => {
    expect(extractTeamMentions("<!team:team_hq> と <!team:team_corp> と <!team:team_hq>")).toEqual([
      "team_hq",
      "team_corp",
    ]);
  });
  it("does not confuse a person mention with a team mention", () => {
    expect(extractTeamMentions("<@usr_a>")).toEqual([]);
    expect(extractMentions("<!team:team_hq>")).toEqual([]);
  });
  it("isTeamMentioned only matches the caller's own teams", () => {
    expect(isTeamMentioned("<!team:team_hq>", ["team_hq"])).toBe(true);
    expect(isTeamMentioned("<!team:team_hq>", ["team_dev"])).toBe(false);
    expect(isTeamMentioned("<!team:team_hq>", [])).toBe(false);
    expect(isTeamMentioned("<!team:team_hq>", undefined)).toBe(false);
  });
  it("ignores a mention inside `code` / a ``` block (renders literally -> no ping)", () => {
    expect(extractTeamMentions("使い方: `<!team:team_hq>`")).toEqual([]);
    expect(extractMentions("```\n<@usr_a>\n```")).toEqual([]);
    expect(mentionsMe("`<!team:team_hq>` と書きます", "usr_a", ["team_hq"])).toBe(false);
    // コード外の本物のメンションは残る
    expect(extractTeamMentions("`<!team:team_hq>` ではなく <!team:team_dev> 宛")).toEqual(["team_dev"]);
  });

  it("mentionsMe covers both the direct and the team path", () => {
    expect(mentionsMe("<@usr_a> hi", "usr_a")).toBe(true);
    expect(mentionsMe("<!team:team_hq> hi", "usr_a", ["team_hq"])).toBe(true);
    expect(mentionsMe("<!team:team_hq> hi", "usr_a", ["team_dev"])).toBe(false);
  });
});

describe("toPlainMentions (一覧プレビュー用)", () => {
  it("replaces both token kinds with display names and falls back to the id", () => {
    const out = toPlainMentions(
      "<!team:team_hq> と <@usr_a> と <!team:gone>",
      (id) => (id === "usr_a" ? "佐藤 花子" : undefined),
      (id) => (id === "team_hq" ? "統括チーム" : undefined),
    );
    expect(out).toBe("@統括チーム と @佐藤 花子 と @gone");
  });
});

describe("detectMentionTrigger", () => {
  it("detects an in-progress mention at the caret", () => {
    const text = "hello @jo";
    const trig = detectMentionTrigger(text, text.length);
    expect(trig).toEqual({ query: "jo", start: 6 });
  });
  it("returns null when a space closed the trigger", () => {
    expect(detectMentionTrigger("hello @jo done", "hello @jo done".length)).toBeNull();
  });
  it("returns null when @ is mid-word (email-like)", () => {
    expect(detectMentionTrigger("a@b", 3)).toBeNull();
  });
});

describe("applyMention", () => {
  it("replaces the trigger with an encoded mention token", () => {
    const text = "hi @jo";
    const trig = detectMentionTrigger(text, text.length)!;
    const out = applyMention(text, text.length, trig, "usr_jones");
    expect(out.text).toBe("hi <@usr_jones> ");
    expect(out.caret).toBe(out.text.length);
  });

  it("inserts a <!team:…> token when the picked candidate is a team", () => {
    const text = "hi @統括";
    const trig = detectMentionTrigger(text, text.length)!;
    const out = applyMention(text, text.length, trig, { kind: "team", id: "team_hq", label: "統括チーム" });
    expect(out.text).toBe("hi <!team:team_hq> ");
    expect(out.caret).toBe(out.text.length);
  });

  it("mentionToken encodes each candidate kind", () => {
    expect(mentionToken({ kind: "user", id: "usr_a", label: "A" })).toBe("<@usr_a>");
    expect(mentionToken({ kind: "team", id: "team_hq", label: "統括チーム" })).toBe("<!team:team_hq>");
    expect(mentionToken("usr_a")).toBe("<@usr_a>");
  });
});
