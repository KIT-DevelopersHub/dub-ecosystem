// In-memory OperateClient for the "Dubを操作" component tests.
import { vi } from "vitest";
import type { CatalogEntry, ExecutionResult, OperateClient, Preview } from "../lib/operateApi.ts";

export const FAKE_CATALOG: CatalogEntry[] = [
  { id: "events.list", area: "event", method: "GET", path: "/events", kind: "read", reversible: true, risk: "low", description: "イベントの一覧を取得する", impact: "読み取りのみ。" },
  { id: "events.get", area: "event", method: "GET", path: "/events/:id", kind: "read", reversible: true, risk: "low", description: "イベント1件の詳細を取得する", hint: "version を含む", impact: "読み取りのみ。" },
  {
    id: "events.update", area: "event", method: "PATCH", path: "/events/:id", kind: "write", reversible: true, risk: "mid",
    description: "イベントのタイトル・概要・日時を更新する", impact: "{count}件のイベントの表示内容が書き換わります。",
    body: { allowed: ["description", "version"], required: ["version"] }, fieldLabels: { description: "概要" },
  },
  {
    id: "notifications.unpublish", area: "notification", method: "POST", path: "/notifications/manage/:id/unpublish", kind: "delete", reversible: true, risk: "high",
    description: "通知を削除する", impact: "{count}件の通知がメンバー全員の受信箱から消えます。",
  },
];

export function makeFakeOperateClient(over: { preview?: Preview; execute?: ExecutionResult; previewError?: Error } = {}) {
  return {
    catalog: vi.fn(async () => ({ configured: true, environment: "staging", entries: FAKE_CATALOG })),
    preview: vi.fn(async (_plan: unknown) => {
      if (over.previewError) throw over.previewError;
      return over.preview!;
    }),
    execute: vi.fn(async (_id: string, _skip: string[]) => over.execute!),
  } satisfies OperateClient;
}
