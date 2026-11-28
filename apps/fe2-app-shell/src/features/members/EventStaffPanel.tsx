// 運営メンバー per event — the selected event's staff bar and its dialog. The roster is ONE
// org-wide list; a person joins an event's 運営メンバー in two ways:
//   1. 参加届 for that event (/participate?event=<id>) — reflected by an admin in 参加届.
//   2. 「このイベントに招待」 here — only people who already have an account (identity link).
//      They join at once (no accept step yet) and get 「〇〇の運営に招待されました」.
// 班 are picked per event with switches. All writes are optimistic (先に反映 → 失敗で戻す).
import { useState } from "react";
import { Button, Modal, Switch, TextField } from "@dub/ui";
import type { member } from "@dub/types";
import { useEventTitle } from "../../lib/eventTarget.tsx";
import { PUBLIC_PARTICIPATION_PATH } from "../participation/prefillLink.ts";
import { useInviteToEvent, useToggleEventStaff } from "./hooks.ts";
import type { MembersOverview, OrgMember } from "./contracts.ts";
import styles from "./members.module.css";

/** Stable marker for verify:live. */
export const EVENT_STAFF_MARKER = "members-event-staff";

/** この イベントの 参加届 URL (公開フォーム)。 */
export function eventParticipationPath(eventId: string): string {
  return `${PUBLIC_PARTICIPATION_PATH}?event=${encodeURIComponent(eventId)}`;
}

/** Bar + dialog, shown only while an event is selected and its staff is loaded. */
export function EventStaffSection({
  scoped,
  canEdit,
}: {
  scoped: { eventId: string | null; staff: member.EventStaff | undefined; full: MembersOverview | undefined };
  canEdit: boolean;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (!scoped.eventId || !scoped.staff || !scoped.full) return null;
  return (
    <>
      <EventStaffBar eventId={scoped.eventId} staff={scoped.staff} full={scoped.full} onEdit={() => setOpen(true)} />
      <EventStaffDialog
        open={open}
        onClose={() => setOpen(false)}
        eventId={scoped.eventId}
        staff={scoped.staff}
        full={scoped.full}
        canEdit={canEdit}
      />
    </>
  );
}

export function EventStaffBar({
  eventId,
  staff,
  full,
  onEdit,
}: {
  eventId: string;
  staff: member.EventStaff;
  full: MembersOverview;
  onEdit: () => void;
}): JSX.Element {
  const title = useEventTitle(eventId) ?? "選択中のイベント";
  const live = new Set(full.members.map((m) => m.id));
  const people = staff.personIds.filter((id) => live.has(id)).length;
  const teams = staff.teamIds.length;
  return (
    <div className={styles.eventStaffBar} data-testid={EVENT_STAFF_MARKER}>
      <div className={styles.eventStaffText}>
        <span className={styles.eventStaffTitle}>「{title}」の運営メンバー {people}人・班 {teams}</span>
        <span className={styles.eventStaffHint}>
          このイベントの参加届を出した人と、招待した人が並びます。アカウントのある人は「このイベントに招待」から入れられます。
        </span>
      </div>
      <Button variant="secondary" onClick={onEdit} testId={`${EVENT_STAFF_MARKER}-edit`}>
        このイベントに招待
      </Button>
    </div>
  );
}

export function EventStaffDialog({
  open,
  onClose,
  eventId,
  staff,
  full,
  canEdit,
}: {
  open: boolean;
  onClose: () => void;
  eventId: string;
  staff: member.EventStaff;
  full: MembersOverview;
  canEdit: boolean;
}): JSX.Element {
  const toggle = useToggleEventStaff();
  const invite = useInviteToEvent();
  const [q, setQ] = useState("");
  const knownTitle = useEventTitle(eventId);
  const title = knownTitle ?? "選択中のイベント";
  const people = new Set(staff.personIds);
  const teams = new Set(staff.teamIds);
  const needle = q.trim();
  const matches = (m: OrgMember) => needle === "" || m.name.includes(needle) || (m.roleTitle ?? "").includes(needle);
  const label = (m: OrgMember) => (m.roleTitle ? `${m.name}（${m.roleTitle}）` : m.name);
  const current = full.members.filter((m) => people.has(m.id));
  // 招待できるのは アカウントのある (identity に紐付いた) 在籍の人で、まだこのイベントに居ない人だけ。
  const candidates = full.members
    .filter((m) => m.identityUserId && m.status !== "declined" && !people.has(m.id))
    .filter(matches);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`「${title}」に招待`}
      size="lg"
      testId={`${EVENT_STAFF_MARKER}-dialog`}
      footer={
        <Button variant="primary" onClick={onClose} testId={`${EVENT_STAFF_MARKER}-done`}>
          閉じる
        </Button>
      }
    >
      <section className={styles.eventStaffSection}>
        <h3 className={styles.eventStaffSectionTitle}>このイベントに招待</h3>
        <p className={styles.eventStaffHint}>
          アカウントのある人だけ招待できます。招待するとすぐこのイベントの運営メンバーに入り、本人に通知が届きます。
          アカウントの無い人には、このイベントの参加届（
          <a href={eventParticipationPath(eventId)} target="_blank" rel="noreferrer" data-testid={`${EVENT_STAFF_MARKER}-participate-link`}>
            {eventParticipationPath(eventId)}
          </a>
          ）を送ってください。
        </p>
        <TextField id="event-staff-search" value={q} onChange={setQ} placeholder="名前・担当で絞り込み" testId={`${EVENT_STAFF_MARKER}-search`} />
        {candidates.length === 0 ? (
          <p className={styles.eventStaffHint} data-testid={`${EVENT_STAFF_MARKER}-no-candidates`}>
            招待できる人はいません（アカウントのある人は全員このイベントに入っています）。
          </p>
        ) : (
          <ul className={styles.eventStaffRows}>
            {candidates.map((m) => (
              <li key={m.id} className={styles.eventStaffRow}>
                <span>{label(m)}</span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!canEdit || (invite.isPending && invite.variables?.personId === m.id)}
                  onClick={() => invite.mutate({ eventId, eventTitle: knownTitle ?? "", personId: m.id, name: m.name })}
                  testId={`${EVENT_STAFF_MARKER}-invite-${m.id}`}
                >
                  招待
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className={styles.eventStaffSection}>
        <h3 className={styles.eventStaffSectionTitle}>このイベントの運営メンバー（{current.length}）</h3>
        {current.length === 0 ? (
          <p className={styles.eventStaffHint}>まだ誰もいません。</p>
        ) : (
          <ul className={styles.eventStaffRows}>
            {current.map((m) => (
              <li key={m.id} className={styles.eventStaffRow} data-testid={`${EVENT_STAFF_MARKER}-staff-${m.id}`}>
                <span>{label(m)}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!canEdit}
                  onClick={() => toggle.mutate({ eventId, kind: "person", id: m.id, on: false })}
                  testId={`${EVENT_STAFF_MARKER}-remove-${m.id}`}
                >
                  外す
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className={styles.eventStaffSection}>
        <h3 className={styles.eventStaffSectionTitle}>班（{teams.size}）</h3>
        <div className={styles.eventStaffList}>
          {full.teams.map((t) => (
            <Switch
              key={t.id}
              id={`event-staff-team-${t.id}`}
              testId={`${EVENT_STAFF_MARKER}-team-${t.id}`}
              label={t.name}
              checked={teams.has(t.id)}
              disabled={!canEdit}
              onChange={(on) => toggle.mutate({ eventId, kind: "team", id: t.id, on })}
            />
          ))}
        </div>
      </section>
    </Modal>
  );
}
