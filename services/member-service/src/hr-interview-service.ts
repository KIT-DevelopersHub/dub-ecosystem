// 面談の日程調整のビジネスロジック (HTTP 非依存)。
//
// 流れ: 申し込み → 招待 (未送信) を作る → 選べる候補が設定数以上なら案内メールを送る → 応募者が URL で
// 日程を選ぶ → 面談確定。候補が足りない間は招待を保留し、枠の追加・設定変更・次の申し込みのたびに見直す。
// 無料枠の Cron は埋まっているので定期実行はしない。送れなかった分は次の契機か、人事の「今すぐ送る」で送る。
import { DubError, errors } from "@dub/errors";
import { hrInterview } from "@dub/types";
import type { ApplicantRow } from "./hr-repo";
import { errBookingClosed, type HrService } from "./hr-service";
import type { InviteRow, SlotRow, HrInterviewRepo } from "./hr-interview-repo";
import { buildBookedNotify, renderBookedMail, renderInviteMail } from "./hr-interview-mail";
import type { MemberService, ReqCtx } from "./service";
import type { AppDeps } from "./types";

export const PUBLIC_INTERVIEW_BOOKING_ACTOR = "system:public-hr-interview-booking";

/** 一度に送る上限。人事の操作は送信を待つので、画面の timeout に収まる数にする。超えた分は次の契機に回す。 */
const RELEASE_BATCH = 10;
/** 公開フォームから任意の宛先へ送れるので、Resend の無料枠 (100 通/日) を食い潰されないよう 24 時間で区切る。 */
const DAILY_INVITE_CAP = 30;
const DAY_MS = 86_400_000;

const errSlotNotFound = (id: string): DubError => new DubError("HR_SLOT_NOT_FOUND", `Slot not found: ${id}`, { status: 404 });
const errSlotDuplicate = (): DubError => new DubError("HR_SLOT_DUPLICATE", "You already have a slot at this time", { status: 409 });
const errSlotBooked = (id: string): DubError => new DubError("HR_SLOT_BOOKED", `Slot ${id} is booked; release it first`, { status: 409 });
const errSlotTaken = (): DubError => new DubError("HR_SLOT_TAKEN", "This slot is no longer available", { status: 409 });
const errInviteNotFound = (): DubError => new DubError("HR_INVITE_NOT_FOUND", "Invite not found", { status: 404 });
const errMailFailed = (): DubError => new DubError("HR_INVITE_SEND_FAILED", "Could not send the mail", { status: 502, retryable: true });

export type HrInterviewDeps = Pick<
  AppDeps,
  "orgId" | "now" | "hrRepo" | "newHrId" | "sendHrMail" | "notifyInterviewer" | "appBaseUrl" | "defer"
> & { hrInterviewRepo: HrInterviewRepo };

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function failureCode(err: unknown): string {
  return err instanceof DubError ? err.code : "send_failed";
}

export class HrInterviewService {
  constructor(
    private readonly deps: HrInterviewDeps,
    private readonly hrSvc: HrService,
    private readonly members: MemberService,
  ) {}

  private get repo(): HrInterviewRepo {
    return this.deps.hrInterviewRepo;
  }

  /** 候補の見直しに使う範囲。少し前までの枠も一覧に残す。 */
  private slots(): Promise<SlotRow[]> {
    const since = new Date(Date.parse(this.deps.now()) - DAY_MS).toISOString();
    return this.repo.listSlots(this.deps.orgId, since);
  }

  private async minOpenSlots(): Promise<number> {
    return (await this.repo.getMinOpenSlots(this.deps.orgId)) ?? hrInterview.DEFAULT_MIN_OPEN_SLOTS;
  }

  private async applicantMap(): Promise<Map<string, ApplicantRow>> {
    return new Map((await this.deps.hrRepo.listApplicants(this.deps.orgId)).map((a) => [a.id, a]));
  }

  async overview(): Promise<hrInterview.InterviewOverview> {
    const [slots, invites, applicants, minOpenSlots] = await Promise.all([
      this.slots(),
      this.repo.listInvites(this.deps.orgId),
      this.applicantMap(),
      this.minOpenSlots(),
    ]);
    const slotHolders = new Set(slots.map((s) => s.applicantId));
    const inviteViews: hrInterview.InterviewInvite[] = [];
    for (const i of invites) {
      const a = applicants.get(i.applicantId);
      if (!a) continue; // 削除済みの応募者
      const booked = slotHolders.has(a.id) || a.stage === "interview_set";
      if (!booked && a.stage !== "scheduling") continue; // 辞退・面談済みなど、もう日程調整の対象ではない人
      const status: hrInterview.InterviewInviteStatus = booked ? "booked" : i.sentAt ? "sent" : "held";
      inviteViews.push({
        id: i.id,
        applicantId: a.id,
        applicantName: a.name,
        email: a.email,
        status,
        sentAt: i.sentAt,
        lastError: i.lastError,
        createdAt: i.createdAt,
      });
    }
    return {
      settings: { minOpenSlots },
      openSlotCount: hrInterview.publicSlots(slots, this.deps.now()).length,
      heldCount: inviteViews.filter((i) => i.status === "held").length,
      slots: slots.map(({ orgId: _o, createdAt: _c, ...s }) => ({
        ...s,
        applicantName: s.applicantId ? (applicants.get(s.applicantId)?.name ?? null) : null,
      })),
      invites: inviteViews,
    };
  }

  async addSlot(ctx: ReqCtx, body: hrInterview.AddInterviewSlotRequest): Promise<hrInterview.InterviewOverview> {
    const b = (body ?? {}) as Partial<hrInterview.AddInterviewSlotRequest>;
    const startMs = typeof b.startAt === "string" ? Date.parse(b.startAt) : Number.NaN;
    if (Number.isNaN(startMs)) throw errors.validationFailed([{ field: "startAt", reason: "invalid" }]);
    if (startMs <= Date.parse(this.deps.now())) throw errors.validationFailed([{ field: "startAt", reason: "in_the_past" }]);
    const duration = b.durationMinutes as (typeof hrInterview.SLOT_DURATIONS_MINUTES)[number];
    if (!hrInterview.SLOT_DURATIONS_MINUTES.includes(duration)) {
      throw errors.validationFailed([{ field: "durationMinutes", reason: "invalid" }]);
    }
    const endAt = new Date(startMs + duration * 60_000).toISOString();
    const startAt = new Date(startMs).toISOString();
    const overlaps = (await this.slots()).some((s) => s.interviewerId === ctx.userId && s.startAt < endAt && s.endAt > startAt);
    if (overlaps) throw errSlotDuplicate();
    const name = (await this.members.listGoogleEmails([ctx.userId])).items[0]?.name ?? "担当者";
    const added = await this.repo.addSlot({
      id: this.deps.newHrId("hsl"),
      orgId: this.deps.orgId,
      startAt,
      endAt,
      interviewerId: ctx.userId,
      interviewerName: name,
      applicantId: null,
      bookedAt: null,
      createdAt: this.deps.now(),
    });
    if (!added) throw errSlotDuplicate();
    await this.releaseHeld(ctx);
    return this.overview();
  }

  private async loadSlot(id: string): Promise<SlotRow> {
    const slot = await this.repo.getSlot(id);
    if (!slot || slot.orgId !== this.deps.orgId) throw errSlotNotFound(id);
    return slot;
  }

  async removeSlot(id: string): Promise<hrInterview.InterviewOverview> {
    await this.loadSlot(id);
    if (!(await this.repo.deleteOpenSlot(id))) throw errSlotBooked(id);
    return this.overview();
  }

  /** 予約を取り消して枠を空きに戻す。応募者は同じ URL で選び直せる。 */
  async releaseBooking(ctx: ReqCtx, id: string): Promise<hrInterview.InterviewOverview> {
    const slot = await this.loadSlot(id);
    if (slot.applicantId && (await this.repo.releaseSlot(id, slot.applicantId))) {
      await this.hrSvc.cancelInterview(ctx, slot.applicantId, `面談の予約を取り消しました（${hrInterview.formatSlotJst(slot)}）`);
      await this.releaseHeld(ctx);
    }
    return this.overview();
  }

  async saveSettings(ctx: ReqCtx, body: hrInterview.SaveInterviewSettingsRequest): Promise<hrInterview.InterviewOverview> {
    const minOpenSlots = (body ?? {}).minOpenSlots;
    if (!hrInterview.isValidMinOpenSlots(minOpenSlots)) throw errors.validationFailed([{ field: "minOpenSlots", reason: "invalid" }]);
    await this.repo.saveMinOpenSlots(this.deps.orgId, minOpenSlots, ctx.userId, this.deps.now());
    await this.releaseHeld(ctx);
    return this.overview();
  }

  /** 応答を待たせない処理。公開ページは gateway の timeout (5 秒) を超えられないので、メールは応答のあとに回す。 */
  private async background(ctx: ReqCtx, label: string, work: Promise<void>): Promise<void> {
    const guarded = work.catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.warn(JSON.stringify({ level: "warn", service: "member-service", msg: label, requestId: ctx.requestId, error: failureCode(err) }));
    });
    if (this.deps.defer) this.deps.defer(guarded);
    else await guarded;
  }

  /**
   * フォームの回答が応募者に結ばれたあと。招待を作れなければ回答者にも失敗を返す: 黙って進むと案内が届かないまま
   * 人事の画面にも出ない。もう一度送れば同じ応募者に結ばれ、招待が作られる。
   */
  async onApplied(ctx: ReqCtx, applicantId: string): Promise<void> {
    const applicant = await this.deps.hrRepo.getApplicant(applicantId);
    if (applicant?.stage !== "scheduling") return;
    await this.repo.addInvite({
      id: this.deps.newHrId("hin"),
      orgId: this.deps.orgId,
      applicantId,
      token: newToken(),
      attempts: 0,
      sentAt: null,
      lastError: null,
      createdAt: this.deps.now(),
    });
    await this.background(ctx, "hr interview invite failed", this.releaseHeld(ctx));
  }

  /** 招待メールを 1 通送る。設定されていない環境と送信失敗は false (招待は保留のまま)。 */
  private async trySend(ctx: ReqCtx, invite: InviteRow, applicant: ApplicantRow): Promise<boolean> {
    if (!this.deps.sendHrMail || !this.deps.appBaseUrl || !applicant.email) return false;
    const url = hrInterview.bookingUrl(this.deps.appBaseUrl, invite.token);
    try {
      await this.deps.sendHrMail(
        ctx.requestId,
        renderInviteMail(applicant.email, url),
        // 回数で区切る: 同時に走った送信は 1 通に畳まれ、失敗後や手動の再送は別の送信になる。
        `hr-interview-invite:${invite.id}:${invite.attempts}`,
      );
    } catch (err) {
      await this.repo.markInviteFailed(invite.id, failureCode(err));
      return false;
    }
    await this.repo.markInviteSent(invite.id, this.deps.now());
    return true;
  }

  /** 候補が足りていれば保留中の招待を送る。失敗し続ける宛先が順番を塞がないよう試行の少ない順に送る。 */
  private async releaseHeld(ctx: ReqCtx): Promise<void> {
    const [slots, minOpenSlots] = await Promise.all([this.slots(), this.minOpenSlots()]);
    if (hrInterview.publicSlots(slots, this.deps.now()).length < minOpenSlots) return;
    const since = new Date(Date.parse(this.deps.now()) - DAY_MS).toISOString();
    const quota = DAILY_INVITE_CAP - (await this.repo.countInvitesSentSince(this.deps.orgId, since));
    if (quota <= 0) return;
    const applicants = await this.applicantMap();
    const held = (await this.repo.listInvites(this.deps.orgId))
      // メールの無い人は送れないので順番を塞がせない (画面には保留として残る)。
      .filter((i) => {
        const a = applicants.get(i.applicantId);
        return i.sentAt === null && a?.stage === "scheduling" && a.email !== null;
      })
      .sort((a, b) => a.attempts - b.attempts || (a.createdAt < b.createdAt ? -1 : 1))
      .slice(0, Math.min(RELEASE_BATCH, quota));
    for (const invite of held) {
      // 失敗が続く時 (枠切れ・障害) に待たせ続けないよう、1 通失敗したら次の契機に回す。
      if (!(await this.trySend(ctx, invite, applicants.get(invite.applicantId) as ApplicantRow))) return;
    }
  }

  /** 人事の「今すぐ送る」「再送」。候補数の条件は見ない (人事の判断)。 */
  async sendInvite(ctx: ReqCtx, id: string): Promise<hrInterview.InterviewOverview> {
    const invite = await this.repo.getInvite(id);
    if (!invite || invite.orgId !== this.deps.orgId) throw errInviteNotFound();
    const applicant = await this.deps.hrRepo.getApplicant(invite.applicantId);
    if (!applicant || applicant.archivedAt !== null) throw errInviteNotFound();
    if (applicant.stage !== "scheduling") throw errBookingClosed();
    if (!(await this.trySend(ctx, invite, applicant))) throw errMailFailed();
    return this.overview();
  }

  private async byToken(token: unknown): Promise<{ invite: InviteRow; applicant: ApplicantRow }> {
    if (typeof token !== "string" || token.length === 0) throw errInviteNotFound();
    const invite = await this.repo.getInviteByToken(token);
    if (!invite || invite.orgId !== this.deps.orgId) throw errInviteNotFound();
    const applicant = await this.deps.hrRepo.getApplicant(invite.applicantId);
    if (!applicant || applicant.archivedAt !== null) throw errInviteNotFound();
    return { invite, applicant };
  }

  async view(token: unknown): Promise<hrInterview.PublicInterviewBooking> {
    const { applicant } = await this.byToken(token);
    const booked = await this.repo.findSlotByApplicant(applicant.id);
    const base = { applicantName: applicant.name };
    if (booked) {
      const { id, startAt, endAt } = booked;
      return { ...base, state: "booked", slots: [], booked: { id, startAt, endAt } };
    }
    if (applicant.stage !== "scheduling") return { ...base, state: "closed", slots: [], booked: null };
    return { ...base, state: "open", slots: hrInterview.publicSlots(await this.slots(), this.deps.now()), booked: null };
  }

  async book(ctx: ReqCtx, token: unknown, slotId: unknown): Promise<hrInterview.PublicInterviewBooking> {
    const { applicant } = await this.byToken(token);
    if (applicant.stage !== "scheduling") throw errBookingClosed();
    if (typeof slotId !== "string") throw errSlotTaken();
    const slot = await this.repo.getSlot(slotId);
    if (!slot || slot.orgId !== this.deps.orgId || Date.parse(slot.startAt) <= Date.parse(this.deps.now())) throw errSlotTaken();
    const bookedAt = this.deps.now();
    if (!(await this.repo.bookSlot(slot.id, applicant.id, bookedAt))) throw errSlotTaken();
    const when = hrInterview.formatSlotJst(slot);
    try {
      await this.hrSvc.confirmInterview(ctx, applicant.id, slot.startAt, `応募者が面談日程を予約しました（${when}・担当 ${slot.interviewerName}）`);
    } catch (err) {
      await this.repo.releaseSlot(slot.id, applicant.id); // 応募者を動かせなかった = 確定していないので枠を返す
      throw err;
    }
    await this.background(ctx, "hr interview booked follow-up failed", this.afterBooked(ctx, applicant, { ...slot, bookedAt }));
    return this.view(token);
  }

  /** 確認メールと担当者への通知。予約は確定済みなので失敗しても応募者には成功を返す。 */
  private async afterBooked(ctx: ReqCtx, applicant: ApplicantRow, slot: SlotRow & { bookedAt: string }): Promise<void> {
    const tasks: Promise<void>[] = [];
    if (this.deps.sendHrMail && applicant.email) {
      tasks.push(
        this.deps.sendHrMail(
          ctx.requestId,
          renderBookedMail(applicant.name, applicant.email, slot),
          `hr-interview-booked:${slot.id}:${applicant.id}:${slot.bookedAt}`,
        ),
      );
    }
    if (this.deps.notifyInterviewer) tasks.push(this.deps.notifyInterviewer(ctx.requestId, buildBookedNotify(slot, applicant.name)));
    for (const r of await Promise.allSettled(tasks)) {
      if (r.status === "rejected") {
        // eslint-disable-next-line no-console
        console.warn(JSON.stringify({ level: "warn", service: "member-service", msg: "hr interview booked follow-up failed", slotId: slot.id, requestId: ctx.requestId, error: failureCode(r.reason) }));
      }
    }
  }
}
