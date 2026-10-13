import { describe, expect, it } from "vitest";
import type { Migration } from "@dub/db";
import { nextSchemaFix } from "../src/schema-sync";
import { collectMigrations } from "../src/collect";

const m = (id: string, up: string): Migration => ({ namespace: "lp", id, up }) as Migration;

const create = m("0001_a", "CREATE TABLE IF NOT EXISTS a (id TEXT PRIMARY KEY);");
const plainCreate = m("0002_b", "CREATE TABLE b (id TEXT);");
const addCol = m("0003_a_name", "ALTER TABLE a ADD COLUMN name TEXT;");
const createAndAdd = m("0004_c", "CREATE TABLE c (id TEXT);\nALTER TABLE c ADD COLUMN x TEXT;");
const rename = m("0005_rename", "CREATE TABLE IF NOT EXISTS d (id TEXT);\nALTER TABLE a RENAME COLUMN name TO title;");

describe("nextSchemaFix", () => {
  it("returns null when nothing is missing", () => {
    expect(nextSchemaFix([create], [], [])).toBeNull();
  });

  it("picks the first file that creates a missing table", () => {
    expect(nextSchemaFix([create, plainCreate], ["b"], [])).toEqual({ kind: "apply", migration: plainCreate });
  });

  it("picks the file that adds a missing column", () => {
    expect(nextSchemaFix([create, addCol], [], ["a.name"])).toEqual({ kind: "apply", migration: addCol });
  });

  it("allows ADD COLUMN on a table the same file creates", () => {
    expect(nextSchemaFix([createAndAdd], ["c"], [])).toEqual({ kind: "apply", migration: createAndAdd });
  });

  it("blocks a file whose ADD COLUMN target already exists", () => {
    const both = m("0006_both", "CREATE TABLE IF NOT EXISTS e (id TEXT);\nALTER TABLE a ADD COLUMN name TEXT;");
    expect(nextSchemaFix([both], ["e"], [])).toMatchObject({ kind: "blocked" });
  });

  it("blocks a plain CREATE TABLE of a table that exists", () => {
    const mixed = m("0007_mixed", "CREATE TABLE IF NOT EXISTS f (id TEXT);\nCREATE TABLE b (id TEXT);");
    expect(nextSchemaFix([mixed], ["f"], [])).toMatchObject({ kind: "blocked" });
  });

  it("blocks destructive files", () => {
    expect(nextSchemaFix([rename], ["d"], [])).toMatchObject({ kind: "blocked" });
  });

  it("blocks when no file adds the missing column", () => {
    expect(nextSchemaFix([create], [], ["a.ghost"])).toMatchObject({ kind: "blocked" });
  });

  it("applies lp_publish from the real migrations (staging2 2026-10-13)", () => {
    const fix = nextSchemaFix(collectMigrations(), ["lp_publish"], []);
    expect(fix).toMatchObject({ kind: "apply", migration: { namespace: "lp" } });
  });
});
