// 運営メンバー per event — the selected event's staff bar and the dialog that picks this
// event's 運営メンバー / 班 from the ONE org-wide roster (people are never duplicated).
// Toggles are optimistic (先に反映 → 失敗で戻す). Shown only while an event is selected.
import { useState } from "react";
import { Button, Modal, Switch, TextField } from "@dub/ui";
import type { member } from "@dub/types";
import { useEventTitle } from "../../lib/eventTarget.tsx";
import { useToggleEventStaff } from "./hooks.ts";
import type { MembersOverview } from "./contracts.ts";
import styles from "./members.module.css";

/** Stable marker for verify:live. */
export const EVENT_STAFF_MARKER = "members-event-staff";

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
          名簿は全体で 1 つです。このイベントで動く人と班を、全体の名簿から選んで表示しています。
        </span>
      </div>
      <Button variant="secondary" onClick={onEdit} testId={`${EVENT_STAFF_MARKER}-edit`}>
        全体の名簿から選ぶ
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
  const [q, setQ] = useState("");
  const title = useEventTitle(eventId) ?? "選択中のイベント";
  const people = new Set(staff.personIds);
  const teams = new Set(staff.teamIds);
  const needle = q.trim();
  const rows = full.members
    .filter((m) => m.status !== "declined")
    .filter((m) => needle === "" || m.name.includes(needle) || (m.roleTitle ?? "").includes(needle));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`「${title}」の運営メンバー`}
      size="lg"
      testId={`${EVENT_STAFF_MARKER}-dialog`}
      footer={
        <Button variant="primary" onClick={onClose} testId={`${EVENT_STAFF_MARKER}-done`}>
          閉じる
        </Button>
      }
    >
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
      <section className={styles.eventStaffSection}>
        <h3 className={styles.eventStaffSectionTitle}>メンバー（{rows.filter((m) => people.has(m.id)).length} / {rows.length}）</h3>
        <TextField id="event-staff-search" value={q} onChange={setQ} placeholder="名前・担当で絞り込み" testId={`${EVENT_STAFF_MARKER}-search`} />
        <div className={styles.eventStaffList}>
          {rows.map((m) => (
            <Switch
              key={m.id}
              id={`event-staff-person-${m.id}`}
              testId={`${EVENT_STAFF_MARKER}-person-${m.id}`}
              label={m.roleTitle ? `${m.name}（${m.roleTitle}）` : m.name}
              checked={people.has(m.id)}
              disabled={!canEdit}
              onChange={(on) => toggle.mutate({ eventId, kind: "person", id: m.id, on })}
            />
          ))}
        </div>
      </section>
    </Modal>
  );
}
