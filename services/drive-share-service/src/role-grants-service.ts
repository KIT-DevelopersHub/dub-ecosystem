// Role-based Drive sharing orchestration — the NON-DESTRUCTIVE, idempotent fan-out.
//
// Google Drive holds the actual permissions; this service only decides which Drive
// permissions to create/keep/delete so that "role X can <reader|commenter|writer> file
// Y" stays true, WITHOUT ever touching individual (pre-existing) shares. The safety
// mechanism is the member ledger (driveshare_role_grant_members): every row records
// whether WE created the Drive permission (created_by_us=1, safe to delete) or it
// pre-existed (created_by_us=0, never delete). Reconcile/revoke consult the ledger, so
// a hand-added individual share is invisible to us and survives.
//
// Correctness rules distilled:
//   apply (POST, upsert): additive + role-correcting. Create permissions for members
//     that have none; for members whose permission WE own, correct its role to the new
//     driveRole; NEVER modify a pre-existing permission. Departed-member cleanup is NOT
//     done here (that is reapply's job) — POST stays a pure add/upsert.
//   revoke (DELETE): delete ONLY the permissions we created, and only when no OTHER
//     grant on the same file still needs that email; then drop the grant + ledger.
//   reapply (reconcile): apply + remove departed members' permissions (our-only, guarded).
import { DubError, errors } from "@dub/errors";
import { GoogleQuotaError, NON_GOOGLE_USER_JA, type DriveShareClient } from "./drive-client";
import type { meeting } from "@dub/types";
import type { GrantMemberRow, GrantRow, RoleGrantStore } from "./role-grants-store";
import type { RoleMembership } from "./role-membership";
import { staticMemberDirectory, type MemberDirectory } from "./member-directory";
import { computeShareDrift } from "./share-drift";
import type {
  AssignableDriveRole,
  FileShareDrift,
  InvitedMember,
  RoleFileGrant,
  SharePermission,
  SkippedMember,
} from "./types";

const ASSIGNABLE: ReadonlySet<string> = new Set(["reader", "commenter", "writer"]);

export interface RoleGrantsDeps {
  drive: DriveShareClient;
  /** Request-scoped role membership for the acting user (built in the composition root). */
  roster: RoleMembership;
  /** 名簿 Gmail per member: a Dub login address (e.g. a Cloudflare Email-Routing alias) often has
   *  no Google account, which Drive refuses outright (cannotInviteNonGoogleUser). */
  directory?: MemberDirectory;
  store: RoleGrantStore;
  orgId: string;
  now: () => string;
  newId: () => string;
  /** Monotonic-enough clock for the per-call budget (injectable for tests). */
  clock?: () => number;
  /** Make sure the hourly sync is running (MeetingSyncDO), once a grant exists to follow. */
  kick?: () => Promise<void>;
  /** Fail (instead of reading "nobody has a Gmail") when the 名簿 lookup fails. Set for the paths
   *  that may take access away or that are retried on failure (role follow, reconcile). */
  strictDirectory?: boolean;
}

/** What following one membership change did (POST /internal/role-membership). */
export interface RoleFollowResult {
  grants: number;
  shared: number;
  revoked: number;
  skipped: SkippedMember[];
  /** Grants whose removals were held (role unknown or read as empty). */
  held: number;
  /** false = the per-call budget ran out; the caller retries (every step is idempotent). */
  complete: boolean;
}

/** One reconcile call over every grant (dryRun false). */
export interface RoleReconcileApplied {
  shared: number;
  revoked: number;
  skipped: SkippedMember[];
  remaining: number;
}

/** Where an unfinished background sync continues: the grant, and the last member handled. */
export interface RoleSyncResume {
  grantId: string;
  cursor: string;
}

export interface RoleSyncResult {
  grants: number;
  /** Grants that needed Drive this run. */
  touched: number;
  shared: number;
  skipped: number;
  /** null = every grant was visited. */
  resume: RoleSyncResume | null;
}

export interface RoleGrantsService {
  listAll(): Promise<RoleFileGrant[]>;
  listByFile(fileId: string): Promise<RoleFileGrant[]>;
  apply(fileId: string, actingUserId: string, roleId: string, driveRole: AssignableDriveRole): Promise<RoleFileGrant>;
  revoke(fileId: string, roleId: string): Promise<void>;
  /** `cursor` = the previous response's nextCursor, to continue an unfinished run. */
  reapply(fileId: string, roleId: string, cursor?: string): Promise<RoleFileGrant>;
  /** Read-only: how the file's actual sharing differs from its role grants. */
  drift(fileId: string): Promise<FileShareDrift>;
  /** The hourly follow of role membership: share with members added since the last run. */
  syncMembers(opts: { budgetMs: number; maxWrites: number; resume?: RoleSyncResume }): Promise<RoleSyncResult>;
  /** A user joined / left these roles: bring every grant of those roles in line now. Joining shares
   *  (名簿 Gmail only, like the hourly sync); leaving deletes ONLY permissions Dub created, only when
   *  no other grant on the file still needs the address, and never when the role is unknown or reads
   *  as empty (a glitch must not unshare everyone). Throws on a transient failure (the caller reports it). */
  followRoles(roleIds: readonly string[], change: "added" | "removed", opts: { budgetMs: number; maxWrites: number }): Promise<RoleFollowResult>;
  /** Read-only, no Google call: what a full reconcile would share / revoke (ledger vs roster). */
  planReconcile(): Promise<meeting.RoleGrantReconcilePlan["drive"]>;
  /** Apply the plan within the budget (Drive is consulted per grant). Repeat while remaining > 0. */
  applyReconcile(opts: { budgetMs: number; maxWrites: number }): Promise<RoleReconcileApplied>;
}

/** A failure worth retrying later (a limit, Google or a Dub service down) — not a refusal of one address. */
export function isTransient(err: unknown): boolean {
  return err instanceof GoogleQuotaError || (err instanceof DubError && err.status >= 500);
}

/** Index a file's Drive permissions by lowercased user email (ignores anyone/domain). */
function indexUserPermsByEmail(perms: readonly SharePermission[]): Map<string, SharePermission> {
  const byEmail = new Map<string, SharePermission>();
  for (const p of perms) {
    if (p.type === "user" && p.emailAddress) byEmail.set(p.emailAddress.trim().toLowerCase(), p);
  }
  return byEmail;
}

/** The address a role member is shared at: their 名簿 Gmail, else their Dub login address. */
interface ShareTarget {
  email: string;
  hasGoogle: boolean;
}

// api-gateway cuts a request off at 15 s and Drive takes a second or more per share (and must
// not be called concurrently on one file), so one call does what fits; the SPA continues
// with the returned cursor. MAX_WRITES keeps retries inside the Workers subrequest limit.
const WRITE_BUDGET_MS = 8_000;
const MAX_WRITES_PER_CALL = 25;
/** Sorts after every email: every member is done, only departed members remain. */
const DEPARTED_PHASE_CURSOR = "~";

const NO_GMAIL_REASON =
  "Google アカウントの無いアドレスのため共有できません。名簿にこのメンバーの Gmail を登録すると、そのアドレスで共有されます。";

export function createRoleGrantsService(deps: RoleGrantsDeps): RoleGrantsService {
  const { drive, roster, store, orgId, now, newId } = deps;
  const directory = deps.directory ?? staticMemberDirectory();
  const clock = deps.clock ?? Date.now;

  // Same resolution as カレンダー > ミーティング invitations. One org-wide lookup per call however
  // many roles it touches (each public method starts fresh, so a membership change is seen).
  let allTargets: Promise<(ShareTarget & { roleIds: string[] })[]> | null = null;
  function loadTargets(): Promise<(ShareTarget & { roleIds: string[] })[]> {
    return (allTargets ??= (async () => {
      const users = await roster.listActiveUsers();
      const google = await directory.googleEmails(users.map((u) => u.id), deps.strictDirectory ? { strict: true } : undefined);
      return users.map((u) => {
        const gmail = google.get(u.id)?.gmail ?? null;
        return { email: (gmail ?? u.email).trim().toLowerCase(), hasGoogle: gmail !== null, roleIds: u.roleIds };
      });
    })());
  }
  async function shareTargets(roleId: string): Promise<ShareTarget[]> {
    const out = new Map<string, ShareTarget>();
    for (const t of await loadTargets()) {
      if (t.roleIds.includes(roleId) && !out.has(t.email)) out.set(t.email, { email: t.email, hasGoogle: t.hasGoogle });
    }
    return [...out.values()];
  }

  async function kickSync(): Promise<void> {
    try {
      await deps.kick?.();
    } catch (err) {
      console.warn(JSON.stringify({ service: "drive-share-service", event: "role_sync_kick_failed", message: err instanceof Error ? err.message : String(err) }));
    }
  }

  function assertAssignable(driveRole: string): asserts driveRole is AssignableDriveRole {
    if (!ASSIGNABLE.has(driveRole)) {
      throw errors.validationFailed([{ field: "driveRole", reason: "not_assignable" }], "指定できないロールです");
    }
  }

  function assertRoleId(roleId: string): void {
    if (!roleId || !roleId.trim()) {
      throw errors.validationFailed([{ field: "roleId", reason: "required" }], "ロールIDは必須です");
    }
  }

  /** Reconcile the Drive permissions for a grant against its current role membership, up to
   *  the per-request budget. Members are handled in email order; `nextCursor` (null = finished)
   *  says where the next call continues. The ledger is written member by member, so a request
   *  cut off mid-way never loses track of a permission we created. Returns the members Drive
   *  refused (partial success — one bad email never fails the whole role fan-out). */
  async function reconcile(
    grant: GrantRow,
    driveRole: AssignableDriveRole,
    opts: { removeDeparted: boolean; cursor?: string; onlyGoogle?: boolean; budgetMs?: number; maxWrites?: number; rethrowTransient?: boolean },
  ): Promise<{ skipped: SkippedMember[]; invited: InvitedMember[]; nextCursor: string | null; remaining: number; writes: number; created: number; deleted: number }> {
    const startedAt = clock();
    const budgetMs = opts.budgetMs ?? WRITE_BUDGET_MS;
    const maxWrites = opts.maxWrites ?? MAX_WRITES_PER_CALL;
    let writes = 0;
    let created = 0;
    let deleted = 0;
    const budgetSpent = (): boolean => writes >= maxWrites || clock() - startedAt >= budgetMs;

    const prev = await store.listMembers(grant.id);
    const prevByEmail = new Map(prev.map((m) => [m.email, m]));

    const allTargets = await shareTargets(grant.roleId);
    const targets = allTargets.filter((t) => !opts.onlyGoogle || t.hasGoogle);
    const emails = targets.map((t) => t.email).sort(); // already lowercased+deduped
    // Departure is judged on EVERY member: one shared at a login address (no Gmail) by hand is
    // still a member even when this run only shares at Gmail addresses.
    const emailSet = new Set(allTargets.map((t) => t.email));
    const noGmail = new Set(targets.filter((t) => !t.hasGoogle).map((t) => t.email));

    const perms = (await drive.listPermissions(grant.fileId)).permissions;
    const permByEmail = indexUserPermsByEmail(perms);

    const skipped: SkippedMember[] = [];
    const invited: InvitedMember[] = [];
    // Per-member isolation: a member Drive refuses (bad/non-Google email) is recorded in
    // `skipped` and the loop continues, so the rest of the role is still applied.
    // A login address without a 名簿 Gmail that Drive refuses → say how to fix it.
    const reasonFor = (email: string, err: unknown): string =>
      noGmail.has(email) && err instanceof DubError && err.message === NON_GOOGLE_USER_JA
        ? NO_GMAIL_REASON
        : err instanceof DubError
          ? err.message
          : "共有できませんでした。";

    const record = async (row: GrantMemberRow): Promise<void> => {
      const was = prevByEmail.get(row.email);
      if (was?.permissionId === row.permissionId && was?.createdByUs === row.createdByUs) return;
      await store.upsertMember(row);
    };
    // The row goes in BEFORE the Drive call (permission unknown yet): if the request dies in
    // between, the next run still knows the permission it finds there is ours.
    const createOurs = async (email: string): Promise<void> => {
      await store.upsertMember({ grantId: grant.id, email, permissionId: null, createdByUs: 1 });
      writes++;
      try {
        const perm = await drive.createPermission(grant.fileId, { type: "user", role: driveRole, emailAddress: email });
        // Created only via the invite fallback (no Google account) → the access is pending.
        if (perm.invited) invited.push({ email });
        await store.upsertMember({ grantId: grant.id, email, permissionId: perm.id, createdByUs: 1 });
        created++;
      } catch (err) {
        await store.deleteMember(grant.id, email);
        throw err;
      }
    };

    let nextCursor: string | null = null;
    let lastDone = opts.cursor;
    for (const email of emails) {
      if (opts.cursor !== undefined && email <= opts.cursor) continue;
      if (budgetSpent()) {
        nextCursor = lastDone ?? "";
        break;
      }
      const previous = prevByEmail.get(email);
      const live = permByEmail.get(email);

      try {
        if (previous && previous.createdByUs === 1) {
          // We own this member's permission.
          if (live && (live.id === previous.permissionId || previous.permissionId === null)) {
            // Still ours (null = a run died right after creating it) — correct the role if it
            // drifted (e.g. driveRole changed on upsert).
            if (live.role !== driveRole) {
              writes++;
              await drive.updatePermission(grant.fileId, live.id, driveRole);
            }
            await record({ grantId: grant.id, email, permissionId: live.id, createdByUs: 1 });
          } else if (live) {
            // Our recorded permission is gone but a (now pre-existing) one exists — respect it.
            await record({ grantId: grant.id, email, permissionId: live.id, createdByUs: 0 });
          } else {
            // Externally deleted — recreate ours.
            await createOurs(email);
          }
        } else if (live) {
          // Not previously ours and a permission already exists — pre-existing individual
          // share. Record it (created_by_us=0) and NEVER modify it.
          await record({ grantId: grant.id, email, permissionId: live.id, createdByUs: 0 });
        } else {
          // New member with no permission — create ours.
          await createOurs(email);
        }
      } catch (err) {
        if (opts.rethrowTransient && isTransient(err)) throw err;
        skipped.push({ email, reason: reasonFor(email, err) });
      }
      lastDone = email;
    }

    if (nextCursor === null && opts.removeDeparted) {
      for (const m of prev) {
        if (emailSet.has(m.email)) continue; // still a member
        if (budgetSpent()) {
          nextCursor = DEPARTED_PHASE_CURSOR;
          break;
        }
        try {
          const permissionId = m.permissionId ?? permByEmail.get(m.email)?.id;
          if (m.createdByUs === 1 && permissionId) {
            // Our permission, member departed — delete unless another grant still needs it.
            const held = await heldElsewhere(grant, m.email, permissionId);
            if (!held) {
              writes++;
              await drive.deletePermission(grant.fileId, permissionId);
              deleted++;
            }
          }
          // created_by_us=0 departed: just forget the row; never delete an individual share.
          await store.deleteMember(grant.id, m.email);
        } catch (err) {
          if (opts.rethrowTransient && isTransient(err)) throw err;
          skipped.push({ email: m.email, reason: reasonFor(m.email, err) });
        }
      }
    }

    const remaining = nextCursor === null ? 0 : emails.filter((e) => e > nextCursor!).length;
    console.log(JSON.stringify({ service: "drive-share-service", event: "role_grant_reconciled", grantId: grant.id, members: emails.length, writes, skipped: skipped.length, remaining, ms: clock() - startedAt }));
    return { skipped, invited, nextCursor, remaining, writes, created, deleted };
  }

  /** Does another grant on the same file still need `email`? Its ledger row may say created_by_us=0
   *  for the very permission THIS grant created (it was there first when that grant was applied).
   *  Then ownership is handed over (that row becomes ours), so the last grant to lose the member
   *  deletes it — instead of this grant unsharing someone another role still covers. */
  async function heldElsewhere(grant: GrantRow, email: string, permissionId: string): Promise<boolean> {
    if (await store.emailHeldByOtherGrant(orgId, grant.fileId, grant.id, email)) return true;
    for (const other of await store.listGrantsByFile(orgId, grant.fileId)) {
      if (other.id === grant.id) continue;
      const row = (await store.listMembers(other.id)).find((r) => r.email === email);
      if (row && (row.permissionId === permissionId || row.permissionId === null)) {
        await store.upsertMember({ grantId: other.id, email, permissionId, createdByUs: 1 });
        return true;
      }
    }
    return false;
  }

  /** Role ids that exist now. Throws when the list cannot be read or reads empty: "unknown" must
   *  never count as "deleted" on a path that takes access away. */
  async function existingRoleIds(): Promise<Set<string>> {
    const roles = await roster.listRoles();
    if (roles.length === 0) throw errors.upstreamUnavailable("identity-roster");
    return new Set(roles.map((r) => r.id));
  }

  /** May this grant lose members now? Not when its role is gone (orphan: left to an admin) or reads
   *  as empty (likelier an identity glitch than a role emptied on purpose — same rule as meetings). */
  async function removalsSafe(grant: GrantRow, roleIds: Set<string>): Promise<boolean> {
    if (!roleIds.has(grant.roleId)) return false;
    return (await shareTargets(grant.roleId)).length > 0;
  }

  async function toRoleFileGrant(
    grant: GrantRow,
    extra?: { skipped?: SkippedMember[]; invited?: InvitedMember[]; nextCursor?: string | null; remaining?: number },
  ): Promise<RoleFileGrant> {
    const [targets, members, roleName] = await Promise.all([
      shareTargets(grant.roleId),
      store.listMembers(grant.id),
      roster.roleName(grant.roleId),
    ]);
    return {
      id: grant.id,
      fileId: grant.fileId,
      roleId: grant.roleId,
      roleName: roleName ?? grant.roleId,
      driveRole: grant.driveRole,
      memberCount: targets.length,
      appliedCount: members.length,
      grantedBy: grant.grantedBy,
      grantedAt: grant.grantedAt,
      ...(extra?.skipped && extra.skipped.length > 0 ? { skipped: extra.skipped } : {}),
      ...(extra?.invited && extra.invited.length > 0 ? { invited: extra.invited } : {}),
      ...(typeof extra?.nextCursor === "string" ? { nextCursor: extra.nextCursor, remaining: extra.remaining ?? 0 } : {}),
    };
  }

  const service: RoleGrantsService = {
    async listAll(): Promise<RoleFileGrant[]> {
      allTargets = null;
      const grants = await store.listGrants(orgId);
      return Promise.all(grants.map((g) => toRoleFileGrant(g)));
    },

    async listByFile(fileId: string): Promise<RoleFileGrant[]> {
      allTargets = null;
      const grants = await store.listGrantsByFile(orgId, fileId);
      return Promise.all(grants.map((g) => toRoleFileGrant(g)));
    },

    async apply(fileId, actingUserId, roleId, driveRole): Promise<RoleFileGrant> {
      allTargets = null;
      assertRoleId(roleId);
      assertAssignable(driveRole);
      const existing = await store.getGrant(orgId, fileId, roleId);
      const ts = now();
      const grant = await store.upsertGrant({
        id: existing?.id ?? newId(),
        orgId,
        fileId,
        roleId,
        driveRole,
        grantedBy: existing?.grantedBy ?? actingUserId,
        grantedAt: existing?.grantedAt ?? ts,
        updatedAt: ts,
      });
      const res = await reconcile(grant, driveRole, { removeDeparted: false });
      await kickSync();
      return toRoleFileGrant(grant, res);
    },

    async revoke(fileId, roleId): Promise<void> {
      allTargets = null;
      assertRoleId(roleId);
      const grant = await store.getGrant(orgId, fileId, roleId);
      if (!grant) return; // idempotent
      const members = await store.listMembers(grant.id);
      for (const m of members) {
        if (m.createdByUs !== 1 || !m.permissionId) continue; // never delete pre-existing shares
        const held = await heldElsewhere(grant, m.email, m.permissionId);
        if (!held) await drive.deletePermission(fileId, m.permissionId);
      }
      await store.deleteGrant(grant.id);
    },

    async reapply(fileId, roleId, cursor): Promise<RoleFileGrant> {
      allTargets = null;
      assertRoleId(roleId);
      const grant = await store.getGrant(orgId, fileId, roleId);
      if (!grant) throw errors.notFound("driveRoleGrant", `${fileId}:${roleId}`);
      const ts = now();
      const updated = await store.upsertGrant({ ...grant, updatedAt: ts });
      const res = await reconcile(updated, updated.driveRole, { removeDeparted: true, ...(cursor !== undefined ? { cursor } : {}) });
      return toRoleFileGrant(updated, res);
    },

    async drift(fileId): Promise<FileShareDrift> {
      allTargets = null;
      const [grants, perms] = await Promise.all([store.listGrantsByFile(orgId, fileId), drive.listPermissions(fileId)]);
      const expected = await Promise.all(
        grants.map(async (g) => ({
          roleName: (await roster.roleName(g.roleId)) ?? g.roleId,
          driveRole: g.driveRole,
          emails: (await shareTargets(g.roleId)).map((t) => t.email),
        })),
      );
      return computeShareDrift(fileId, expected, perms.permissions);
    },

    // Additive only, and only at a 名簿 Gmail: nobody is watching, so it never takes access away
    // (reapply does) and never tries a login address, which could mail an invite that cannot be
    // recalled. A grant whose Gmail members are all in the ledger costs no Drive call.
    async syncMembers({ budgetMs, maxWrites, resume }): Promise<RoleSyncResult> {
      allTargets = null;
      const startedAt = clock();
      const grants = await store.listGrants(orgId);
      const result: RoleSyncResult = { grants: grants.length, touched: 0, shared: 0, skipped: 0, resume: null };
      const start = resume ? grants.findIndex((g) => g.id === resume.grantId) : 0;
      let writesLeft = maxWrites;

      for (const [i, grant] of grants.entries()) {
        if (i < start) continue;
        const cursor = resume && i === start ? resume.cursor : undefined;
        const msLeft = budgetMs - (clock() - startedAt);
        if (writesLeft <= 0 || msLeft <= 0) {
          result.resume = { grantId: grant.id, cursor: cursor ?? "" };
          break;
        }
        const recorded = new Set((await store.listMembers(grant.id)).filter((m) => m.permissionId !== null).map((m) => m.email));
        const wanted = (await shareTargets(grant.roleId)).filter((t) => t.hasGoogle);
        if (wanted.every((t) => recorded.has(t.email))) continue;

        result.touched++;
        const res = await reconcile(grant, grant.driveRole, {
          removeDeparted: false,
          onlyGoogle: true,
          budgetMs: msLeft,
          maxWrites: writesLeft,
          ...(cursor ? { cursor } : {}),
        });
        writesLeft -= res.writes;
        result.shared += res.created;
        result.skipped += res.skipped.length;
        if (res.nextCursor !== null) {
          result.resume = { grantId: grant.id, cursor: res.nextCursor };
          break;
        }
      }
      return result;
    },

    async followRoles(roleIds, change, { budgetMs, maxWrites }): Promise<RoleFollowResult> {
      allTargets = null;
      const startedAt = clock();
      const wanted = new Set(roleIds);
      const grants = (await store.listGrants(orgId)).filter((g) => wanted.has(g.roleId));
      const out: RoleFollowResult = { grants: grants.length, shared: 0, revoked: 0, skipped: [], held: 0, complete: true };
      if (grants.length === 0) return out;
      const known = change === "removed" ? await existingRoleIds() : null;
      let writesLeft = maxWrites;
      for (const grant of grants) {
        const msLeft = budgetMs - (clock() - startedAt);
        if (writesLeft <= 0 || msLeft <= 0) {
          out.complete = false;
          break;
        }
        let removeDeparted = false;
        if (known) {
          removeDeparted = await removalsSafe(grant, known);
          if (!removeDeparted) {
            out.held++;
            console.warn(JSON.stringify({ service: "drive-share-service", event: "role_follow_removal_held", grantId: grant.id, roleId: grant.roleId, roleKnown: known.has(grant.roleId) }));
          }
        }
        // Joining shares at Gmail only (like the hourly sync: a login address could mail an invite
        // nobody can recall); leaving runs the departed phase too.
        const res = await reconcile(grant, grant.driveRole, { removeDeparted, onlyGoogle: true, budgetMs: msLeft, maxWrites: writesLeft, rethrowTransient: true });
        writesLeft -= res.writes;
        out.shared += res.created;
        out.revoked += res.deleted;
        out.skipped.push(...res.skipped);
        if (res.nextCursor !== null) {
          out.complete = false;
          break;
        }
      }
      return out;
    },

    async planReconcile() {
      allTargets = null;
      const grants = await store.listGrants(orgId);
      const known = await existingRoleIds();
      const plan: meeting.RoleGrantReconcilePlan["drive"] = { grants: grants.length, toShare: [], toRevoke: [], orphanGrants: [], withoutGmail: 0 };
      const noGmail = new Set<string>();
      const ledgers = new Map<string, GrantMemberRow[]>();
      for (const g of grants) ledgers.set(g.id, await store.listMembers(g.id));
      for (const g of grants) {
        if (!known.has(g.roleId)) {
          plan.orphanGrants.push({ grantId: g.id, fileId: g.fileId, roleId: g.roleId });
          continue;
        }
        const targets = await shareTargets(g.roleId);
        const ledger = ledgers.get(g.id) ?? [];
        const recorded = new Set(ledger.filter((m) => m.permissionId !== null).map((m) => m.email));
        const item = (email: string) => ({ grantId: g.id, fileId: g.fileId, roleId: g.roleId, email, driveRole: g.driveRole });
        for (const t of targets) {
          if (!t.hasGoogle) noGmail.add(t.email);
          else if (!recorded.has(t.email)) plan.toShare.push(item(t.email));
        }
        if (targets.length === 0) continue; // removals held (see removalsSafe)
        const members = new Set(targets.map((t) => t.email));
        for (const m of ledger) {
          if (members.has(m.email) || m.createdByUs !== 1) continue;
          const held = grants.some((o) => o.id !== g.id && o.fileId === g.fileId && (ledgers.get(o.id) ?? []).some((x) => x.email === m.email));
          if (!held) plan.toRevoke.push(item(m.email));
        }
      }
      plan.withoutGmail = noGmail.size;
      return plan;
    },

    async applyReconcile({ budgetMs, maxWrites }): Promise<RoleReconcileApplied> {
      allTargets = null;
      const startedAt = clock();
      const known = await existingRoleIds();
      const out: RoleReconcileApplied = { shared: 0, revoked: 0, skipped: [], remaining: 0 };
      let writesLeft = maxWrites;
      let stopped = false;
      for (const grant of await store.listGrants(orgId)) {
        if (!known.has(grant.roleId)) continue; // orphan: reported by the plan, never touched here
        const msLeft = budgetMs - (clock() - startedAt);
        if (stopped || writesLeft <= 0 || msLeft <= 0) {
          stopped = true;
          continue;
        }
        const removeDeparted = await removalsSafe(grant, known);
        const res = await reconcile(grant, grant.driveRole, { removeDeparted, onlyGoogle: true, budgetMs: msLeft, maxWrites: writesLeft });
        writesLeft -= res.writes;
        out.shared += res.created;
        out.revoked += res.deleted;
        out.skipped.push(...res.skipped);
        if (res.nextCursor !== null) stopped = true;
      }
      if (stopped) {
        const plan = await service.planReconcile();
        out.remaining = plan.toShare.length + plan.toRevoke.length;
      }
      return out;
    },
  };
  return service;
}
