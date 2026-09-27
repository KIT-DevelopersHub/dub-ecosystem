import { describe, it, expect } from "vitest";
import {
  apiCommand,
  classifyD1Sql,
  commandFor,
  d1Command,
  D1_DB_NAME,
  extractJsonBlock,
  isDestructiveSql,
  isWrite,
  normalizeOperation,
  parsePlan,
  shellQuote,
  type Operation,
} from "./operateDub.ts";

describe("operateDub classification (safety net)", () => {
  it("classifies reads vs writes from the SQL itself", () => {
    expect(classifyD1Sql("SELECT * FROM users")).toBe("d1_read");
    expect(classifyD1Sql("  pragma table_info(users)")).toBe("d1_read");
    expect(classifyD1Sql("WITH t AS (SELECT 1) SELECT * FROM t")).toBe("d1_read");
    expect(classifyD1Sql("INSERT INTO users(id) VALUES('a')")).toBe("d1_write");
    expect(classifyD1Sql("UPDATE users SET name='x'")).toBe("d1_write");
    expect(classifyD1Sql("DELETE FROM users")).toBe("d1_write");
  });

  it("flags delete/drop/truncate as destructive", () => {
    expect(isDestructiveSql("DELETE FROM users WHERE id='a'")).toBe(true);
    expect(isDestructiveSql("DROP TABLE users")).toBe(true);
    expect(isDestructiveSql("TRUNCATE users")).toBe(true);
    expect(isDestructiveSql("INSERT INTO users(id) VALUES('a')")).toBe(false);
    expect(isDestructiveSql("UPDATE users SET name='x'")).toBe(false);
  });

  it("re-derives kind + destructive even if the planner under-classified", () => {
    // Planner LIED: says a DELETE is a harmless read. The safety net corrects it.
    const op = normalizeOperation({
      id: "op1",
      kind: "d1_read",
      title: "掃除",
      sql: "DELETE FROM users",
      destructive: false,
    });
    expect(op.kind).toBe("d1_write");
    expect(op.destructive).toBe(true);
  });

  it("isWrite: reads are false, writes/mutating API calls are true", () => {
    const read: Operation = { id: "1", kind: "d1_read", title: "", sql: "SELECT 1", destructive: false };
    const write: Operation = { id: "2", kind: "d1_write", title: "", sql: "INSERT INTO t VALUES(1)", destructive: false };
    const apiGet: Operation = { id: "3", kind: "api_call", title: "", method: "GET", url: "u", destructive: false };
    const apiPost: Operation = { id: "4", kind: "api_call", title: "", method: "POST", url: "u", destructive: false };
    expect(isWrite(read)).toBe(false);
    expect(isWrite(write)).toBe(true);
    expect(isWrite(apiGet)).toBe(false);
    expect(isWrite(apiPost)).toBe(true);
  });
});

describe("operateDub command building", () => {
  it("single-quotes and escapes for the shell", () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });

  it("d1Command targets --remote and adds --json only for reads", () => {
    const read = d1Command("SELECT 1");
    expect(read).toContain(`d1 execute ${D1_DB_NAME}`);
    expect(read).toContain("--remote");
    expect(read).toContain("--json");
    const write = d1Command("INSERT INTO t VALUES(1)");
    expect(write).toContain("--remote");
    expect(write).not.toContain("--json");
  });

  it("apiCommand builds curl with method/url/body", () => {
    const cmd = apiCommand({
      id: "1",
      kind: "api_call",
      title: "",
      method: "post",
      url: "https://x/api",
      body: '{"a":1}',
      destructive: false,
    });
    expect(cmd).toContain("curl");
    expect(cmd).toContain("-X POST");
    expect(cmd).toContain("https://x/api");
    expect(cmd).toContain('{"a":1}');
  });

  it("commandFor routes by kind", () => {
    expect(commandFor({ id: "1", kind: "d1_read", title: "", sql: "SELECT 1", destructive: false })).toContain("d1 execute");
    expect(commandFor({ id: "2", kind: "api_call", title: "", method: "GET", url: "u", destructive: false })).toContain("curl");
  });
});

describe("operateDub plan parsing", () => {
  it("extracts the LAST fenced json block", () => {
    const text = 'まず ```json\n{"a":1}\n``` 次 ```json\n{"b":2}\n```';
    expect(extractJsonBlock(text)).toBe('{"b":2}');
  });

  it("parses a valid plan and normalizes its ops", () => {
    const answer =
      "計画です:\n```json\n" +
      JSON.stringify({
        summary: "サンプル投入",
        ops: [
          { id: "r1", kind: "d1_read", title: "件数", sql: "SELECT count(*) FROM users", destructive: false },
          { id: "w1", kind: "d1_read", title: "投入", sql: "INSERT INTO users(id) VALUES('a')", destructive: false },
          { id: "x1", kind: "d1_read", title: "削除", sql: "DELETE FROM users", destructive: false },
        ],
      }) +
      "\n```";
    const res = parsePlan(answer);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.summary).toBe("サンプル投入");
    expect(res.plan.ops).toHaveLength(3);
    // Safety net applied during parse:
    expect(res.plan.ops[1]!.kind).toBe("d1_write"); // INSERT reclassified
    expect(res.plan.ops[2]!.kind).toBe("d1_write"); // DELETE reclassified
    expect(res.plan.ops[2]!.destructive).toBe(true); // DELETE = destructive
  });

  it("errors gracefully when no JSON / no ops", () => {
    expect(parsePlan("ただの文章です").ok).toBe(false);
    const noOps = parsePlan('```json\n{"summary":"x"}\n```');
    expect(noOps.ok).toBe(false);
  });
});
