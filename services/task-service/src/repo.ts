// Task persistence over the @dub/db namespace-scoped DbClient (task_* only).
// The interface is the test seam; D1TaskRepo is the production implementation.
import type { DbClient } from "@dub/db";
import type { task, common } from "@dub/types";

// snake-cased D1 row for task_tasks.
export interface TaskRow {
  id: string;
  event_id: string | null;
  title: string;
  description: string | null;
  status: task.TaskStatus;
  priority: task.TaskPriority;
  assignee_id: string | null;
  team_id: string | null;
  parent_id: string | null;
  wbs: string | null;
  start_at: string | null;
  due_at: string | null;
  origin: task.TaskOrigin;
  version: number;
  due_soon_notified_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export function rowToTask(r: TaskRow): task.Task {
  return {
    id: r.id,
    eventId: r.event_id,
    title: r.title,
    description: r.description,
    status: r.status,
    priority: r.priority,
    assigneeId: r.assignee_id,
    teamId: r.team_id,
    parentTaskId: r.parent_id,
    wbs: r.wbs,
    createdBy: r.created_by,
    startAt: r.start_at,
    dueAt: r.due_at,
    origin: r.origin,
    version: r.version,
    archivedAt: r.archived_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface InsertTaskInput {
  id: common.TaskId;
  eventId: common.EventId | null;
  title: string;
  description: string | null;
  status: task.TaskStatus;
  priority: task.TaskPriority;
  assigneeId: common.UserId | null;
  teamId?: common.TeamId | null;
  parentId?: common.TaskId | null;
  wbs?: string | null;
  startAt?: common.ISODateTime | null;
  dueAt: common.ISODateTime | null;
  origin: task.TaskOrigin;
  createdBy: common.UserId;
  now: common.ISODateTime;
}

// Column-level patch (only provided keys are written). null clears a nullable column.
export interface TaskPatch {
  title?: string;
  description?: string | null;
  status?: task.TaskStatus;
  priority?: task.TaskPriority;
  assigneeId?: common.UserId | null;
  teamId?: common.TeamId | null;
  parentId?: common.TaskId | null;
  wbs?: string | null;
  startAt?: common.ISODateTime | null;
  dueAt?: common.ISODateTime | null;
}

export interface ListFilter {
  eventId?: string;
  assigneeId?: string;
  /** WBS/team scope (task_tasks.team_id). Powers the gantt team filter. */
  teamId?: string;
  /** Requester filter (task_tasks.created_by). Powers the "issued by me" lens. */
  createdById?: string;
  statuses?: task.TaskStatus[];
  includeArchived: boolean;
  limit: number;
  cursorId?: string; // decoded (last seen id)
}

export interface DueSoonRow {
  taskId: common.TaskId;
  eventId: common.EventId | null;
  dueAt: common.ISODateTime;
}

// snake-cased D1 row for task_attachments.
export interface AttachmentRow {
  id: string;
  task_id: string;
  kind: task.TaskAttachmentKind;
  name: string;
  url: string;
  file_id: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  created_by: string;
  created_at: string;
  archived_at: string | null;
}

export function rowToAttachment(r: AttachmentRow): task.TaskAttachment {
  return {
    id: r.id,
    taskId: r.task_id,
    kind: r.kind,
    name: r.name,
    url: r.url,
    fileId: r.file_id,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

export interface InsertAttachmentInput {
  id: string;
  taskId: common.TaskId;
  kind: task.TaskAttachmentKind;
  name: string;
  url: string;
  fileId: common.FileId | null;
  mimeType: string | null;
  sizeBytes: number | null;
  createdBy: common.UserId;
  now: common.ISODateTime;
}

// ── send / receive: task_requests + task_cross_links (send-receive PR5) ───────
// snake-cased D1 row for task_requests.
export interface TaskRequestRow {
  id: string;
  event_id: string | null;
  from_user_id: string;
  to_user_id: string;
  from_team_id: string | null;
  to_team_id: string | null;
  title: string;
  description: string | null;
  priority: task.TaskPriority;
  due_at: string | null;
  source_task_id: string | null;
  state: task.TaskRequestState;
  decline_reason: string | null;
  created_task_id: string | null;
  version: number;
  created_at: string;
  decided_at: string | null;
  updated_at: string;
}

export function rowToTaskRequest(r: TaskRequestRow): task.TaskRequest {
  return {
    id: r.id,
    eventId: r.event_id,
    fromUserId: r.from_user_id,
    toUserId: r.to_user_id,
    fromTeamId: r.from_team_id,
    toTeamId: r.to_team_id,
    title: r.title,
    description: r.description,
    priority: r.priority,
    dueAt: r.due_at,
    sourceTaskId: r.source_task_id,
    state: r.state,
    declineReason: r.decline_reason,
    createdTaskId: r.created_task_id,
    version: r.version,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    updatedAt: r.updated_at,
  };
}

export interface InsertTaskRequestInput {
  id: string; // treq_ ULID
  eventId: common.EventId | null;
  fromUserId: common.UserId;
  toUserId: common.UserId;
  fromTeamId: common.TeamId | null;
  toTeamId: common.TeamId | null;
  title: string;
  description: string | null;
  priority: task.TaskPriority;
  dueAt: common.ISODateTime | null;
  sourceTaskId: common.TaskId | null;
  now: common.ISODateTime;
}

/** Terminal transition of a request (accept / decline / cancel). Only provided keys
 *  are written; `state` + `decidedAt` are always set and `version` is bumped. */
export interface TaskRequestDecision {
  state: task.TaskRequestState; // accepted | declined | cancelled
  declineReason?: string | null;
  createdTaskId?: common.TaskId | null;
  toTeamId?: common.TeamId | null;
}

export interface ListRequestsFilter {
  box: "incoming" | "outgoing";
  userId: string; // the caller — incoming ⇒ to_user_id, outgoing ⇒ from_user_id
  states?: task.TaskRequestState[];
  eventId?: string;
  limit: number;
  cursorId?: string;
}

// snake-cased D1 row for task_cross_links.
export interface TaskCrossLinkRow {
  id: string;
  request_id: string;
  requester_task_id: string;
  requestee_task_id: string;
  event_id: string | null;
  created_at: string;
}

export function rowToCrossLink(r: TaskCrossLinkRow): task.TaskCrossLink {
  return {
    id: r.id,
    requestId: r.request_id,
    requesterTaskId: r.requester_task_id,
    requesteeTaskId: r.requestee_task_id,
    eventId: r.event_id,
    createdAt: r.created_at,
  };
}

export interface InsertCrossLinkInput {
  id: string; // txl_ ULID
  requestId: string;
  requesterTaskId: common.TaskId;
  requesteeTaskId: common.TaskId;
  eventId: common.EventId | null;
  now: common.ISODateTime;
}

export interface TaskRepo {
  insert(input: InsertTaskInput): Promise<task.Task>;
  getById(id: string, includeArchived?: boolean): Promise<task.Task | null>;
  list(filter: ListFilter): Promise<{ items: task.Task[]; nextCursor: string | null }>;
  /** Optimistic update; returns false on version mismatch (or already archived). */
  update(id: string, patch: TaskPatch, expectedVersion: number, now: string): Promise<boolean>;
  /** Soft-delete (archive) a live task; false if not found / already archived. */
  archive(id: string, now: string): Promise<boolean>;
  /** Count of LIVE (non-archived) tasks whose direct parent is `parentId`. Guards
   *  delete: a task with live children must not be archived (else the children are
   *  orphaned and the read model silently re-parents them). */
  countLiveChildren(parentId: string): Promise<number>;
  /** Distinct owning-team ids of the LIVE (non-archived) direct children of `parentId`
   *  (`null` = a child with no team). Guards a parent's team change: a parent must not be
   *  moved to a team that differs from any of its children (親子は同一チーム). */
  liveChildrenTeams(parentId: string): Promise<Array<common.TeamId | null>>;
  /** Restore (un-archive) a soft-deleted task — the inverse of `archive`, used by
   *  the gantt "削除を元に戻す" (undo). False if not found / already live. Everything
   *  else (parent_id, assignee, dependency rows) is untouched by archive, so a plain
   *  clear of archived_at brings the task back with all its relations intact. */
  restore(id: string, now: string): Promise<boolean>;
  /** Bulk-archive every live task of an event (event.archived compensation). */
  archiveByEvent(eventId: string, now: string): Promise<common.TaskId[]>;
  getDependsOn(taskId: string): Promise<common.TaskId[]>;
  /**
   * Dependencies scoped to a single "bucket": either an event (eventId) or the
   * unlinked bucket (eventId === null → tasks with event_id IS NULL). Dependencies
   * are only valid within the same bucket, so an unlinked task can only depend on
   * other unlinked tasks (and vice-versa).
   */
  listDependenciesByEvent(eventId: string | null): Promise<task.TaskDependency[]>;
  /** Every live (non-archived) task in a bucket with its `team_id` — the valid dependsOn
   *  target set plus the team each belongs to. The dependency门番 (ADR-0007) compares
   *  `team_id` to reject cross-team edges; ids alone come from `.map(t => t.id)`. */
  listLiveTasksByEvent(eventId: string | null): Promise<Array<{ id: common.TaskId; teamId: common.TeamId | null }>>;
  /** Version-checked full replace of a task's dependsOn edges. */
  replaceDependencies(
    taskId: string,
    dependsOnIds: string[],
    expectedVersion: number,
    now: string,
  ): Promise<{ ok: boolean; added: common.TaskId[]; removed: common.TaskId[] }>;
  /** Find + mark tasks whose due_at is within [now, now+window] and not yet notified. */
  scanDueSoon(nowMs: number, windowMs: number, now: string): Promise<DueSoonRow[]>;
  /** Append an attachment (file/url) to a task. */
  addAttachment(input: InsertAttachmentInput): Promise<task.TaskAttachment>;
  /** A task's live (non-archived) attachments, newest first. */
  listAttachments(taskId: string): Promise<task.TaskAttachment[]>;
  /** Soft-delete one attachment; false if not found / already archived. */
  archiveAttachment(taskId: string, attachmentId: string, now: string): Promise<boolean>;

  // ── send / receive: task requests + cross-links ────────────────────────────
  /** Create a pending cross-team request (send-receive). */
  insertRequest(input: InsertTaskRequestInput): Promise<task.TaskRequest>;
  /** One request by id, or null. */
  getRequestById(id: string): Promise<task.TaskRequest | null>;
  /** Cursor-paged incoming/outgoing requests for a user, optional state/event filter. */
  listRequests(filter: ListRequestsFilter): Promise<{ items: task.TaskRequest[]; nextCursor: string | null }>;
  /** Optimistic-locked terminal transition (accept/decline/cancel). Only moves a
   *  `pending` row; returns false on version mismatch or a non-pending state. */
  decideRequest(
    id: string,
    decision: TaskRequestDecision,
    expectedVersion: number,
    now: string,
  ): Promise<boolean>;
  /** Create the arrow-less cross-link joining requester + requestee tasks. */
  insertCrossLink(input: InsertCrossLinkInput): Promise<task.TaskCrossLink>;
  /** Every cross-link in an event (same shape as listDependenciesByEvent). */
  listCrossLinksByEvent(eventId: string): Promise<task.TaskCrossLink[]>;
}

export function encodeCursor(id: string): string {
  return btoa(id);
}
export function decodeCursor(cursor: string): string {
  try {
    return atob(cursor);
  } catch {
    return "";
  }
}

const ALL_COLUMNS =
  "id, event_id, title, description, status, priority, assignee_id, team_id, parent_id, wbs, start_at, due_at, origin, version, due_soon_notified_at, created_by, created_at, updated_at, archived_at";

export function createD1TaskRepo(db: DbClient): TaskRepo {
  return {
    async insert(input: InsertTaskInput): Promise<task.Task> {
      await db.run(
        `INSERT INTO task_tasks (${ALL_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, NULL)`,
        input.id,
        input.eventId,
        input.title,
        input.description,
        input.status,
        input.priority,
        input.assigneeId,
        input.teamId ?? null,
        input.parentId ?? null,
        input.wbs ?? null,
        input.startAt ?? null,
        input.dueAt,
        input.origin,
        input.createdBy,
        input.now,
        input.now,
      );
      const row = await db.first<TaskRow>(`SELECT ${ALL_COLUMNS} FROM task_tasks WHERE id = ?`, input.id);
      if (!row) throw new Error("insert readback failed");
      return rowToTask(row);
    },

    async getById(id: string, includeArchived = false): Promise<task.Task | null> {
      const sql = includeArchived
        ? `SELECT ${ALL_COLUMNS} FROM task_tasks WHERE id = ?`
        : `SELECT ${ALL_COLUMNS} FROM task_tasks WHERE id = ? AND archived_at IS NULL`;
      const row = await db.first<TaskRow>(sql, id);
      return row ? rowToTask(row) : null;
    },

    async list(filter: ListFilter): Promise<{ items: task.Task[]; nextCursor: string | null }> {
      const where: string[] = [];
      const binds: unknown[] = [];
      if (!filter.includeArchived) where.push("archived_at IS NULL");
      if (filter.eventId) {
        where.push("event_id = ?");
        binds.push(filter.eventId);
      }
      if (filter.assigneeId) {
        where.push("assignee_id = ?");
        binds.push(filter.assigneeId);
      }
      if (filter.teamId) {
        where.push("team_id = ?");
        binds.push(filter.teamId);
      }
      if (filter.createdById) {
        where.push("created_by = ?");
        binds.push(filter.createdById);
      }
      if (filter.statuses && filter.statuses.length > 0) {
        where.push(`status IN (${filter.statuses.map(() => "?").join(",")})`);
        binds.push(...filter.statuses);
      }
      if (filter.cursorId) {
        where.push("id < ?");
        binds.push(filter.cursorId);
      }
      const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
      const rows = await db.all<TaskRow>(
        `SELECT ${ALL_COLUMNS} FROM task_tasks ${clause} ORDER BY id DESC LIMIT ?`,
        ...binds,
        filter.limit + 1,
      );
      const hasMore = rows.length > filter.limit;
      const page = hasMore ? rows.slice(0, filter.limit) : rows;
      const last = page[page.length - 1];
      return {
        items: page.map(rowToTask),
        nextCursor: hasMore && last ? encodeCursor(last.id) : null,
      };
    },

    async update(id: string, patch: TaskPatch, expectedVersion: number, now: string): Promise<boolean> {
      const sets: string[] = [];
      const binds: unknown[] = [];
      const col = (name: string, value: unknown): void => {
        sets.push(`${name} = ?`);
        binds.push(value);
      };
      if (patch.title !== undefined) col("title", patch.title);
      if (patch.description !== undefined) col("description", patch.description);
      if (patch.status !== undefined) col("status", patch.status);
      if (patch.priority !== undefined) col("priority", patch.priority);
      if (patch.assigneeId !== undefined) col("assignee_id", patch.assigneeId);
      if (patch.teamId !== undefined) col("team_id", patch.teamId);
      if (patch.parentId !== undefined) col("parent_id", patch.parentId);
      if (patch.wbs !== undefined) col("wbs", patch.wbs);
      if (patch.startAt !== undefined) col("start_at", patch.startAt);
      if (patch.dueAt !== undefined) col("due_at", patch.dueAt);
      col("updated_at", now);
      sets.push("version = version + 1");
      const res = await db.run(
        `UPDATE task_tasks SET ${sets.join(", ")} WHERE id = ? AND version = ? AND archived_at IS NULL`,
        ...binds,
        id,
        expectedVersion,
      );
      return res.meta.changes > 0;
    },

    async archive(id: string, now: string): Promise<boolean> {
      const res = await db.run(
        `UPDATE task_tasks SET archived_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND archived_at IS NULL`,
        now,
        now,
        id,
      );
      return res.meta.changes > 0;
    },

    async countLiveChildren(parentId: string): Promise<number> {
      const row = await db.first<{ n: number }>(
        `SELECT COUNT(*) AS n FROM task_tasks WHERE parent_id = ? AND archived_at IS NULL`,
        parentId,
      );
      return row?.n ?? 0;
    },

    async liveChildrenTeams(parentId: string): Promise<Array<common.TeamId | null>> {
      const rows = await db.all<{ team_id: string | null }>(
        `SELECT DISTINCT team_id FROM task_tasks WHERE parent_id = ? AND archived_at IS NULL`,
        parentId,
      );
      return rows.map((r) => (r.team_id ?? null) as common.TeamId | null);
    },

    async restore(id: string, now: string): Promise<boolean> {
      const res = await db.run(
        `UPDATE task_tasks SET archived_at = NULL, updated_at = ?, version = version + 1 WHERE id = ? AND archived_at IS NOT NULL`,
        now,
        id,
      );
      return res.meta.changes > 0;
    },

    async archiveByEvent(eventId: string, now: string): Promise<common.TaskId[]> {
      const live = await db.all<{ id: string }>(
        `SELECT id FROM task_tasks WHERE event_id = ? AND archived_at IS NULL`,
        eventId,
      );
      if (live.length === 0) return [];
      await db.run(
        `UPDATE task_tasks SET archived_at = ?, updated_at = ?, version = version + 1 WHERE event_id = ? AND archived_at IS NULL`,
        now,
        now,
        eventId,
      );
      return live.map((r) => r.id);
    },

    async getDependsOn(taskId: string): Promise<common.TaskId[]> {
      const rows = await db.all<{ depends_on_id: string }>(
        `SELECT depends_on_id FROM task_dependencies WHERE task_id = ?`,
        taskId,
      );
      return rows.map((r) => r.depends_on_id);
    },

    async listDependenciesByEvent(eventId: string | null): Promise<task.TaskDependency[]> {
      const rows =
        eventId === null
          ? await db.all<{ task_id: string; depends_on_id: string }>(
              `SELECT d.task_id, d.depends_on_id FROM task_dependencies d
               JOIN task_tasks t ON d.task_id = t.id
               WHERE t.event_id IS NULL`,
            )
          : await db.all<{ task_id: string; depends_on_id: string }>(
              `SELECT d.task_id, d.depends_on_id FROM task_dependencies d
               JOIN task_tasks t ON d.task_id = t.id
               WHERE t.event_id = ?`,
              eventId,
            );
      return rows.map((r) => ({ taskId: r.task_id, dependsOnId: r.depends_on_id }));
    },

    async listLiveTasksByEvent(
      eventId: string | null,
    ): Promise<Array<{ id: common.TaskId; teamId: common.TeamId | null }>> {
      const rows =
        eventId === null
          ? await db.all<{ id: string; team_id: string | null }>(
              `SELECT id, team_id FROM task_tasks WHERE event_id IS NULL AND archived_at IS NULL`,
            )
          : await db.all<{ id: string; team_id: string | null }>(
              `SELECT id, team_id FROM task_tasks WHERE event_id = ? AND archived_at IS NULL`,
              eventId,
            );
      return rows.map((r) => ({ id: r.id, teamId: r.team_id }));
    },

    async replaceDependencies(
      taskId: string,
      dependsOnIds: string[],
      expectedVersion: number,
      now: string,
    ): Promise<{ ok: boolean; added: common.TaskId[]; removed: common.TaskId[] }> {
      const existing = await this.getDependsOn(taskId);
      const nextSet = new Set(dependsOnIds);
      const prevSet = new Set(existing);
      const added = [...nextSet].filter((x) => !prevSet.has(x));
      const removed = [...prevSet].filter((x) => !nextSet.has(x));

      const bump = await db.run(
        `UPDATE task_tasks SET version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND archived_at IS NULL`,
        now,
        taskId,
        expectedVersion,
      );
      if (bump.meta.changes === 0) return { ok: false, added: [], removed: [] };

      const stmts = [{ sql: `DELETE FROM task_dependencies WHERE task_id = ?`, binds: [taskId] }];
      for (const dep of nextSet) {
        stmts.push({
          sql: `INSERT INTO task_dependencies (task_id, depends_on_id, created_at) VALUES (?, ?, ?)`,
          binds: [taskId, dep, now],
        });
      }
      await db.batch(stmts);
      return { ok: true, added, removed };
    },

    async scanDueSoon(nowMs: number, windowMs: number, now: string): Promise<DueSoonRow[]> {
      const windowEnd = new Date(nowMs + windowMs).toISOString();
      const nowIsoStr = new Date(nowMs).toISOString();
      const rows = await db.all<{ id: string; event_id: string | null; due_at: string }>(
        `SELECT id, event_id, due_at FROM task_tasks
         WHERE archived_at IS NULL AND due_at IS NOT NULL AND due_soon_notified_at IS NULL
           AND status NOT IN ('done','cancelled')
           AND due_at >= ? AND due_at <= ?`,
        nowIsoStr,
        windowEnd,
      );
      if (rows.length === 0) return [];
      const stmts = rows.map((r) => ({
        sql: `UPDATE task_tasks SET due_soon_notified_at = ? WHERE id = ? AND due_soon_notified_at IS NULL`,
        binds: [now, r.id] as unknown[],
      }));
      await db.batch(stmts);
      return rows.map((r) => ({ taskId: r.id, eventId: r.event_id, dueAt: r.due_at }));
    },

    async addAttachment(input: InsertAttachmentInput): Promise<task.TaskAttachment> {
      await db.run(
        `INSERT INTO task_attachments
           (id, task_id, kind, name, url, file_id, mime_type, size_bytes, created_by, created_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        input.id,
        input.taskId,
        input.kind,
        input.name,
        input.url,
        input.fileId,
        input.mimeType,
        input.sizeBytes,
        input.createdBy,
        input.now,
      );
      const row = await db.first<AttachmentRow>(
        `SELECT id, task_id, kind, name, url, file_id, mime_type, size_bytes, created_by, created_at, archived_at
         FROM task_attachments WHERE id = ?`,
        input.id,
      );
      if (!row) throw new Error("attachment insert readback failed");
      return rowToAttachment(row);
    },

    async listAttachments(taskId: string): Promise<task.TaskAttachment[]> {
      const rows = await db.all<AttachmentRow>(
        `SELECT id, task_id, kind, name, url, file_id, mime_type, size_bytes, created_by, created_at, archived_at
         FROM task_attachments
         WHERE task_id = ? AND archived_at IS NULL
         ORDER BY created_at DESC, id DESC`,
        taskId,
      );
      return rows.map(rowToAttachment);
    },

    async archiveAttachment(taskId: string, attachmentId: string, now: string): Promise<boolean> {
      const res = await db.run(
        `UPDATE task_attachments SET archived_at = ?
         WHERE id = ? AND task_id = ? AND archived_at IS NULL`,
        now,
        attachmentId,
        taskId,
      );
      return res.meta.changes > 0;
    },

    // ── send / receive: task requests + cross-links ──────────────────────────
    async insertRequest(input: InsertTaskRequestInput): Promise<task.TaskRequest> {
      await db.run(
        `INSERT INTO task_requests
           (id, event_id, from_user_id, to_user_id, from_team_id, to_team_id, title,
            description, priority, due_at, source_task_id, state, decline_reason,
            created_task_id, version, created_at, decided_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, 1, ?, NULL, ?)`,
        input.id,
        input.eventId,
        input.fromUserId,
        input.toUserId,
        input.fromTeamId,
        input.toTeamId,
        input.title,
        input.description,
        input.priority,
        input.dueAt,
        input.sourceTaskId,
        input.now,
        input.now,
      );
      const row = await db.first<TaskRequestRow>(`SELECT * FROM task_requests WHERE id = ?`, input.id);
      if (!row) throw new Error("insertRequest readback failed");
      return rowToTaskRequest(row);
    },

    async getRequestById(id: string): Promise<task.TaskRequest | null> {
      const row = await db.first<TaskRequestRow>(`SELECT * FROM task_requests WHERE id = ?`, id);
      return row ? rowToTaskRequest(row) : null;
    },

    async listRequests(
      filter: ListRequestsFilter,
    ): Promise<{ items: task.TaskRequest[]; nextCursor: string | null }> {
      const where: string[] = [];
      const binds: unknown[] = [];
      where.push(filter.box === "incoming" ? "to_user_id = ?" : "from_user_id = ?");
      binds.push(filter.userId);
      if (filter.states && filter.states.length > 0) {
        where.push(`state IN (${filter.states.map(() => "?").join(",")})`);
        binds.push(...filter.states);
      }
      if (filter.eventId) {
        where.push("event_id = ?");
        binds.push(filter.eventId);
      }
      if (filter.cursorId) {
        where.push("id < ?");
        binds.push(filter.cursorId);
      }
      const rows = await db.all<TaskRequestRow>(
        `SELECT * FROM task_requests WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`,
        ...binds,
        filter.limit + 1,
      );
      const hasMore = rows.length > filter.limit;
      const page = hasMore ? rows.slice(0, filter.limit) : rows;
      const last = page[page.length - 1];
      return {
        items: page.map(rowToTaskRequest),
        nextCursor: hasMore && last ? encodeCursor(last.id) : null,
      };
    },

    async decideRequest(
      id: string,
      decision: TaskRequestDecision,
      expectedVersion: number,
      now: string,
    ): Promise<boolean> {
      const sets = ["state = ?", "decided_at = ?", "updated_at = ?", "version = version + 1"];
      const binds: unknown[] = [decision.state, now, now];
      if (decision.declineReason !== undefined) {
        sets.push("decline_reason = ?");
        binds.push(decision.declineReason);
      }
      if (decision.createdTaskId !== undefined) {
        sets.push("created_task_id = ?");
        binds.push(decision.createdTaskId);
      }
      if (decision.toTeamId !== undefined) {
        sets.push("to_team_id = ?");
        binds.push(decision.toTeamId);
      }
      // Only a still-pending row may transition (guards double-accept / lost updates).
      const res = await db.run(
        `UPDATE task_requests SET ${sets.join(", ")}
         WHERE id = ? AND version = ? AND state = 'pending'`,
        ...binds,
        id,
        expectedVersion,
      );
      return res.meta.changes > 0;
    },

    async insertCrossLink(input: InsertCrossLinkInput): Promise<task.TaskCrossLink> {
      await db.run(
        `INSERT INTO task_cross_links
           (id, request_id, requester_task_id, requestee_task_id, event_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        input.id,
        input.requestId,
        input.requesterTaskId,
        input.requesteeTaskId,
        input.eventId,
        input.now,
      );
      const row = await db.first<TaskCrossLinkRow>(`SELECT * FROM task_cross_links WHERE id = ?`, input.id);
      if (!row) throw new Error("insertCrossLink readback failed");
      return rowToCrossLink(row);
    },

    async listCrossLinksByEvent(eventId: string): Promise<task.TaskCrossLink[]> {
      const rows = await db.all<TaskCrossLinkRow>(
        `SELECT * FROM task_cross_links WHERE event_id = ? ORDER BY id DESC`,
        eventId,
      );
      return rows.map(rowToCrossLink);
    },
  };
}
