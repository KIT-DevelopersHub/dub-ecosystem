// #2 offboarding orchestration (退任). Composes the identity-local one-shot with the
// cross-service steps (member在籍更新・Email Routing削除) into a single OffboardOutcome
// that records each step's result so the UI can show PARTIAL success (one step failing
// never hides the others). Idempotent: safe to re-run (identity is idempotent server-
// side; a missing member / address simply reports "skipped").
import type { identity, common, member } from "@dub/types";
import type { OffboardUserResult, EmailRoutingAddress } from "../contracts/pending";

export type OffboardCrossStep = "member-status" | "email-routing";
export interface OffboardStepReport {
  step: "identity" | OffboardCrossStep;
  status: "done" | "skipped" | "failed";
  detail: string;
}
export interface OffboardOutcome {
  ok: boolean; // false if any step failed
  identity: OffboardUserResult | null;
  steps: OffboardStepReport[];
}

/** Minimal API surface the orchestrator needs (a subset of RosterApi) — keeps it unit-
 *  testable with a small fake. */
export interface OffboardApi {
  offboardUser(userId: common.UserId): Promise<OffboardUserResult>;
  getMemberByIdentity(identityUserId: common.UserId): Promise<{ member: member.Member | null }>;
  patchMember(memberId: string, patch: member.UpdateMemberRequest): Promise<member.Member>;
  listEmailAddresses(): Promise<common.Paginated<EmailRoutingAddress>>;
  deleteEmailAddress(id: string): Promise<void>;
}

function reason(e: unknown): string {
  if (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  return "failed";
}

/**
 * Retire `user` in one action. The identity step runs FIRST and is fatal (if it throws,
 * e.g. LAST_ADMIN, nothing else runs and the error propagates). The cross-service steps
 * are best-effort and independent: each records done/skipped/failed and never aborts the
 * others. `retireStatus` is the member在籍state a linked member is moved to (default
 * "declined" = 退任扱い; the record is kept for the 組織図, not deleted).
 */
export async function runOffboard(
  api: OffboardApi,
  user: Pick<identity.IdentityUser, "id" | "email">,
  retireStatus: member.MemberStatus = "declined",
): Promise<OffboardOutcome> {
  // 1) identity-local one-shot (fatal on throw).
  const identity = await api.offboardUser(user.id);
  const steps: OffboardStepReport[] = [
    { step: "identity", status: "done", detail: `セッション失効・ロール剥奪(${identity.revokedAssignments})・利用停止` },
  ];

  // 2) member在籍更新 (best-effort).
  try {
    const { member: linked } = await api.getMemberByIdentity(user.id);
    if (!linked) {
      steps.push({ step: "member-status", status: "skipped", detail: "紐付くメンバーなし" });
    } else if (linked.status === retireStatus) {
      steps.push({ step: "member-status", status: "skipped", detail: "既に退任状態" });
    } else {
      await api.patchMember(linked.id, { status: retireStatus, version: linked.version });
      steps.push({ step: "member-status", status: "done", detail: `「${linked.name}」を退任に更新` });
    }
  } catch (e) {
    steps.push({ step: "member-status", status: "failed", detail: reason(e) });
  }

  // 3) Email Routing削除 (best-effort): drop the rule whose address == the user's email.
  try {
    const { items } = await api.listEmailAddresses();
    const match = items.find((a) => a.address.toLowerCase() === user.email.toLowerCase());
    if (!match) {
      steps.push({ step: "email-routing", status: "skipped", detail: "該当アドレスなし" });
    } else {
      await api.deleteEmailAddress(match.id);
      steps.push({ step: "email-routing", status: "done", detail: match.address });
    }
  } catch (e) {
    steps.push({ step: "email-routing", status: "failed", detail: reason(e) });
  }

  return { ok: steps.every((s) => s.status !== "failed"), identity, steps };
}
