// demo transport: 人事の「面談」タブと公開の日程選択 (member-service /members/hr/interviews* と
// gateway /public/hr-interview-booking/* の demo)。メールは実際には送らない。面談日程調整中の応募者を
// 招待として見せ、候補が足りていれば「送信済み」にする。公開ページは /interview-book#t=demo で
// 最初の未予約の応募者として開ける。seed: 3 候補 (既定の 5 候補に足りず保留が見える)。
import { hrInterview, type hr } from "@dub/types";

const ME = "usr_demo";
const TOKEN = "demo";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function problem(code: string, status: number): Response {
  return json({ error: { code, message: code, retryable: false } }, status);
}

export function createHrInterviewsDemoStore(deps: {
  listApplicants: () => Promise<hr.ListApplicantsResponse>;
  confirmInterview: (id: string, interviewAt: string) => Promise<void>;
  cancelInterview: (id: string) => Promise<void>;
}) {
  let minOpenSlots = hrInterview.DEFAULT_MIN_OPEN_SLOTS;
  let seq = 0;
  const sent = new Map<string, string>(); // applicantId -> sentAt
  const slots: hrInterview.InterviewSlot[] = [];

  function addSlot(
    startAt: string,
    durationMinutes: number,
    who: { id: string; name: string } = { id: ME, name: "デモ 人事" },
    booking: { applicantId: string; applicantName: string } | null = null,
  ): void {
    slots.push({
      id: `hsl_demo_${++seq}`,
      startAt,
      endAt: new Date(Date.parse(startAt) + durationMinutes * 60_000).toISOString(),
      interviewerId: who.id,
      interviewerName: who.name,
      applicantId: booking?.applicantId ?? null,
      applicantName: booking?.applicantName ?? null,
      bookedAt: booking ? new Date().toISOString() : null,
    });
    slots.sort((a, b) => (a.startAt < b.startAt ? -1 : 1));
  }

  // 日本時間で置く (マス目は日本時間で並ぶ)。自分の空き 3 つ = 候補 3 (既定の 5 に足りず保留が見える)。
  const jstMidnight = Math.floor((Date.now() + 9 * 3_600_000) / 86_400_000) * 86_400_000 - 9 * 3_600_000;
  const at = (days: number, hour: number, minute = 0) =>
    new Date(jstMidnight + days * 86_400_000 + (hour * 60 + minute) * 60_000).toISOString();
  // 候補 3 = 自分の 2 日後・5 日後 14:00 + 他の人の 3 日後 14:00 (佐藤・鈴木の 2 人が同じ時刻 = 1 候補)。
  // 他の人の枠はマス目に名前が薄く出る。予約済みは候補に数えない。
  const SATO = { id: "usr_demo_sato", name: "佐藤 花子" };
  const SUZUKI = { id: "usr_demo_suzuki", name: "鈴木 一郎" };
  for (const days of [2, 5]) addSlot(at(days, 14), 30);
  addSlot(at(3, 14), 30, SATO);
  addSlot(at(3, 14), 30, SUZUKI);
  addSlot(at(2, 16), 30, SUZUKI, { applicantId: "app_demo_booked_other", applicantName: "小林 陽菜" });
  addSlot(at(2, 16, 30), 30, SATO, { applicantId: "app_demo_booked_other2", applicantName: "中村 蓮" });
  // 面談確定 (予約済み) の 宇野 蒼。「面談結果を登録」を試す相手。
  addSlot(at(3, 18), 30, { id: ME, name: "デモ 人事" }, { applicantId: "app_demo_3", applicantName: "宇野 蒼" });

  const openSlots = () => hrInterview.publicSlots(slots, new Date().toISOString());

  async function targets(): Promise<hr.ApplicantListItem[]> {
    return (await deps.listApplicants()).applicants.filter((a) => a.source?.startsWith("面談申し込みフォーム"));
  }

  async function overview(): Promise<hrInterview.InterviewOverview> {
    const applicants = await targets();
    const now = new Date().toISOString();
    if (openSlots().length >= minOpenSlots) {
      for (const a of applicants) if (a.stage === "scheduling" && !sent.has(a.id)) sent.set(a.id, now);
    }
    const invites = applicants
      .filter((a) => a.stage === "scheduling" || a.stage === "interview_set")
      .map((a): hrInterview.InterviewInvite => {
        const status = a.stage === "interview_set" ? "booked" : sent.has(a.id) ? "sent" : "held";
        return {
          id: `hin_${a.id}`,
          applicantId: a.id,
          applicantName: a.name,
          email: a.email,
          status,
          sentAt: sent.get(a.id) ?? null,
          lastError: null,
          createdAt: a.createdAt,
        };
      });
    return {
      settings: { minOpenSlots },
      openSlotCount: openSlots().length,
      heldCount: invites.filter((i) => i.status === "held").length,
      slots: slots.map((s) => ({ ...s })),
      invites,
    };
  }

  async function bookingFor(): Promise<hr.ApplicantListItem | null> {
    const applicants = await targets();
    // 予約済みの枠のうち、人事 demo の応募者のもの (他の人の seed の予約は応募者の画面の対象外)。
    const booked = slots.find((s) => s.applicantId !== null && applicants.some((a) => a.id === s.applicantId));
    return applicants.find((a) => a.id === booked?.applicantId) ?? applicants.find((a) => a.stage === "scheduling") ?? null;
  }

  async function view(): Promise<Response> {
    const a = await bookingFor();
    if (!a) return problem("HR_INVITE_NOT_FOUND", 404);
    const booked = slots.find((s) => s.applicantId === a.id);
    if (booked) {
      const { id, startAt, endAt } = booked;
      return json({ state: "booked", applicantName: a.name, slots: [], booked: { id, startAt, endAt } });
    }
    return json({ state: "open", applicantName: a.name, slots: openSlots(), booked: null });
  }

  async function handle(method: string, pathname: string, body: any): Promise<Response | null> {
    if (pathname === "/api/v1/public/hr-interview-booking/view" && method === "POST") {
      return body?.token === TOKEN ? view() : problem("HR_INVITE_NOT_FOUND", 404);
    }
    if (pathname === "/api/v1/public/hr-interview-booking/book" && method === "POST") {
      const a = await bookingFor();
      if (body?.token !== TOKEN || !a) return problem("HR_INVITE_NOT_FOUND", 404);
      const slot = slots.find((s) => s.id === body?.slotId);
      if (!slot || slot.applicantId) return problem("HR_SLOT_TAKEN", 409);
      slot.applicantId = a.id;
      slot.applicantName = a.name;
      slot.bookedAt = new Date().toISOString();
      await deps.confirmInterview(a.id, slot.startAt);
      return view();
    }
    if (!pathname.startsWith("/api/v1/members/hr/interviews")) return null;
    const rest = pathname.slice("/api/v1/members/hr/interviews".length);
    if (rest === "" && method === "GET") return json(await overview());
    if (rest === "/settings" && method === "PUT") {
      if (!hrInterview.isValidMinOpenSlots(body?.minOpenSlots)) return problem("VALIDATION_FAILED", 400);
      minOpenSlots = body.minOpenSlots;
      return json(await overview());
    }
    if (rest === "/slots" && method === "POST") {
      const items: hrInterview.NewInterviewSlot[] = Array.isArray(body?.slots) ? body.slots : [];
      if (items.length === 0 || items.some((i) => Date.parse(i.startAt) <= Date.now())) return problem("VALIDATION_FAILED", 400);
      for (const it of items) {
        const start = Date.parse(it.startAt);
        const end = start + it.durationMinutes * 60_000;
        const overlap = slots.some((s) => s.interviewerId === ME && Date.parse(s.startAt) < end && Date.parse(s.endAt) > start);
        if (!overlap) addSlot(new Date(start).toISOString(), it.durationMinutes);
      }
      return json(await overview(), 201);
    }
    if (rest === "/slots/delete" && method === "POST") {
      const ids = new Set<string>(Array.isArray(body?.ids) ? body.ids : []);
      for (let i = slots.length - 1; i >= 0; i--) if (ids.has(slots[i]!.id) && !slots[i]!.applicantId) slots.splice(i, 1);
      return json(await overview());
    }
    const slotMatch = /^\/slots\/([^/]+)(\/release)?$/.exec(rest);
    if (slotMatch) {
      const slot = slots.find((s) => s.id === decodeURIComponent(slotMatch[1]!));
      if (!slot) return problem("HR_SLOT_NOT_FOUND", 404);
      if (slotMatch[2] && method === "POST") {
        if (slot.applicantId) await deps.cancelInterview(slot.applicantId);
        Object.assign(slot, { applicantId: null, applicantName: null, bookedAt: null });
        return json(await overview());
      }
      if (!slotMatch[2] && method === "DELETE") {
        if (slot.applicantId) return problem("HR_SLOT_BOOKED", 409);
        slots.splice(slots.indexOf(slot), 1);
        return json(await overview());
      }
    }
    const inviteMatch = /^\/invites\/hin_([^/]+)\/send$/.exec(rest);
    if (inviteMatch && method === "POST") {
      sent.set(decodeURIComponent(inviteMatch[1]!), new Date().toISOString());
      return json(await overview());
    }
    return null;
  }

  return { handle };
}
