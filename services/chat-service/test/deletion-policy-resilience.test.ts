// Resilience: chat-service must keep working (delete = default policy) even if the
// chat_settings migration (0003) has not been applied to this D1 yet — migrations are
// applied out-of-band (deploy.yml), so a fresh deploy can briefly precede the schema.
// A "no such table" on the settings read degrades to the in-code default; any OTHER
// error propagates (never silently change delete behaviour).
import { describe, it, expect } from "vitest";
import type { DbClient } from "@dub/db";
import { createD1ChatRepo } from "../src/d1-repo";

function repoWithFirst(first: () => Promise<unknown>) {
  const db = {
    first,
    all: async () => [],
    run: async () => ({ meta: { changes: 0 } }),
  } as unknown as DbClient;
  return createD1ChatRepo(db);
}

describe("getDeletionPolicy resilience (settings table missing)", () => {
  it("returns null (=> service uses the default policy) when the table does not exist", async () => {
    const repo = repoWithFirst(async () => {
      throw new Error("D1_ERROR: no such table: chat_settings");
    });
    expect(await repo.getDeletionPolicy("org_devhub")).toBeNull();
  });

  it("propagates non-'no such table' errors (never silently changes delete behaviour)", async () => {
    const repo = repoWithFirst(async () => {
      throw new Error("D1_ERROR: database is locked");
    });
    await expect(repo.getDeletionPolicy("org_devhub")).rejects.toThrow(/database is locked/);
  });
});
