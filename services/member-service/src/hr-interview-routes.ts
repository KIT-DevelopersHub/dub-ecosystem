// 面談の日程調整のルート (app.ts から registerHrInterviewRoutes で1行登録)。
// 認可はここに書かない: 各ルートの規則は policy-table.ts の行。
//   /members/hr/interviews*                  人事アプリの画面 (閲覧 + hr:read / 編集 + hr:write)
//   /members/internal/hr/interview-booking/* 公開ページ (gateway の PUBLIC ルートが s2s で転送・INTERNAL)
import type { Context, Hono } from "hono";
import type { RequestContext } from "@dub/http";
import { errors } from "@dub/errors";
import type { hrInterview } from "@dub/types";
import { PUBLIC_INTERVIEW_BOOKING_ACTOR, type HrInterviewService } from "./hr-interview-service";
import type { ReqCtx } from "./service";

function requestIdOf(c: Context): string {
  const ctx = c.get("dubCtx") as RequestContext | undefined;
  return ctx?.requestId ?? c.req.header("x-dub-request-id") ?? "";
}

function reqCtx(c: Context): ReqCtx {
  const userId = c.get("userId") as string | undefined;
  if (!userId) throw errors.unauthenticated("x-dub-user-id absent");
  return { requestId: requestIdOf(c), userId };
}

async function readJson<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw errors.validationFailed([{ field: "body", reason: "invalid_json" }]);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerHrInterviewRoutes(app: Hono<any>, svc: HrInterviewService): void {
  // ---- 人事アプリ: 面談タブ ----
  app.get("/members/hr/interviews", async (c) => c.json(await svc.overview()));
  app.put("/members/hr/interviews/settings", async (c) => {
    return c.json(await svc.saveSettings(reqCtx(c), await readJson<hrInterview.SaveInterviewSettingsRequest>(c)));
  });
  app.post("/members/hr/interviews/slots", async (c) => {
    return c.json(await svc.addSlots(reqCtx(c), await readJson<hrInterview.AddInterviewSlotsRequest>(c)), 201);
  });
  app.post("/members/hr/interviews/slots/delete", async (c) => {
    return c.json(await svc.removeSlots(await readJson<hrInterview.RemoveInterviewSlotsRequest>(c)));
  });
  app.delete("/members/hr/interviews/slots/:id", async (c) => c.json(await svc.removeSlot(c.req.param("id"))));
  app.post("/members/hr/interviews/slots/:id/release", async (c) => c.json(await svc.releaseBooking(reqCtx(c), c.req.param("id"))));
  app.post("/members/hr/interviews/invites/:id/send", async (c) => c.json(await svc.sendInvite(reqCtx(c), c.req.param("id"))));

  // ---- 公開ページ (gateway POST /api/v1/public/hr-interview-booking/* → ここ, s2s のみ) ----
  app.post("/members/internal/hr/interview-booking/view", async (c) => {
    const b = await readJson<hrInterview.PublicBookingViewRequest>(c);
    return c.json(await svc.view(b.token));
  });
  app.post("/members/internal/hr/interview-booking/book", async (c) => {
    const b = await readJson<hrInterview.PublicBookingRequest>(c);
    const ctx = { requestId: requestIdOf(c), userId: PUBLIC_INTERVIEW_BOOKING_ACTOR };
    return c.json(await svc.book(ctx, b.token, b.slotId));
  });
}
