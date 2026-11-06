// Role list grouping (ロール管理). Pure: derives a genre from existing role data
// (isSystem / id prefix / name prefix) so the page can render scannable sections
// without any backend change. To add a genre, add a rule to RULES and a group to
// ROLE_GROUPS — the first matching rule wins, unmatched custom roles go to "ops".

export type RoleGroupId = "system" | "ops" | "team" | "position" | "other";

export interface GroupableRole {
  id: string;
  name: string;
  isSystem: boolean;
}

export interface RoleGroupDef {
  id: RoleGroupId;
  label: string;
  /** Auto-generated groups start collapsed (they are long and rarely edited). */
  defaultOpen: boolean;
  /** Redundant name prefix shown stripped in the tab label (data keeps the real name). */
  namePrefix?: string;
}

/** Display order of the sections. */
export const ROLE_GROUPS: readonly RoleGroupDef[] = [
  { id: "system", label: "システム", defaultOpen: true },
  { id: "ops", label: "運営ロール", defaultOpen: true },
  { id: "team", label: "チーム (自動)", defaultOpen: false, namePrefix: "チーム:" },
  { id: "position", label: "役職 (自動)", defaultOpen: false, namePrefix: "役職:" },
  { id: "other", label: "その他", defaultOpen: true },
];

type Rule = { group: RoleGroupId; test: (r: GroupableRole) => boolean };

const RULES: readonly Rule[] = [
  { group: "system", test: (r) => r.isSystem },
  { group: "team", test: (r) => r.id.startsWith("role_auto_team_") || r.name.startsWith("チーム:") },
  { group: "position", test: (r) => r.id.startsWith("role_auto_position_") || r.name.startsWith("役職:") },
  { group: "other", test: (r) => /(^|[-_\s])bot$/i.test(r.name) || r.id.startsWith("role_auto_") },
];

export function roleGroupOf(role: GroupableRole): RoleGroupId {
  return RULES.find((rule) => rule.test(role))?.group ?? "ops";
}

/** Tab label: strips the group's redundant prefix ("チーム: 開発チーム" → "開発チーム"). */
export function roleDisplayName(role: GroupableRole, group: RoleGroupId = roleGroupOf(role)): string {
  const prefix = ROLE_GROUPS.find((g) => g.id === group)?.namePrefix;
  if (!prefix || !role.name.startsWith(prefix)) return role.name;
  return role.name.slice(prefix.length).trim() || role.name;
}

export interface RoleGroup<R extends GroupableRole> extends RoleGroupDef {
  roles: R[];
}

/**
 * Buckets roles into ROLE_GROUPS order, keeping the input order inside each group.
 * Every role lands in exactly one group (never hidden); empty groups are omitted.
 */
export function groupRoles<R extends GroupableRole>(roles: readonly R[]): RoleGroup<R>[] {
  const buckets = new Map<RoleGroupId, R[]>(ROLE_GROUPS.map((g) => [g.id, []]));
  for (const r of roles) buckets.get(roleGroupOf(r))!.push(r);
  return ROLE_GROUPS.map((g) => ({ ...g, roles: buckets.get(g.id)! })).filter((g) => g.roles.length > 0);
}

/** Case-insensitive name match (full name, so "チーム" finds every team role). */
export function matchesRoleQuery(role: GroupableRole, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || role.name.toLowerCase().includes(q);
}

/**
 * Confirmation copy for deleting a role: who loses it, that it cannot be undone, and — for
 * 名簿-managed roles — that the sync recreates the role while its team / 役職 still exists.
 */
export function roleDeleteMessage(role: GroupableRole & { memberCount?: number }): string {
  const count = role.memberCount ?? 0;
  const impact = count > 0 ? `付与中の ${count} 人からこのロールが外れます。` : "";
  const group = roleGroupOf(role);
  const managed =
    group === "team" || group === "position"
      ? "名簿に残っている場合は、次回の同期で権限なしのロールとして作り直されます。"
      : "";
  return `「${role.name}」を削除します。${impact}元に戻せません。${managed}`;
}
