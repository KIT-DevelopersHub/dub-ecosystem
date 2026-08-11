// RolePicker — layer ② composite. Wraps the @dub/ui FormField + Select to turn a
// list of roles into a labeled dropdown, so every screen that assigns a role
// (invite, assign, filter) stops rebuilding `roleOptions` by hand.
import { FormField, Select, type SelectOption } from "@dub/ui";

export interface RoleOption {
  id: string;
  name: string;
}

export interface RolePickerProps {
  value: string;
  onChange: (roleId: string) => void;
  /** Roles to offer (data-injected, e.g. from `useRoles()`). */
  roles: readonly RoleOption[] | undefined;
  label?: string;
  id?: string;
  testId?: string;
  placeholder?: string;
  /** Prepend an empty "none" option (value ""). Use for optional role fields. */
  includeNone?: boolean;
  noneLabel?: string;
  error?: string;
  disabled?: boolean;
}

export function RolePicker({
  value,
  onChange,
  roles,
  label = "ロール",
  id = "role-picker",
  testId,
  placeholder,
  includeNone = false,
  noneLabel = "なし",
  error,
  disabled,
}: RolePickerProps): JSX.Element {
  const options: SelectOption[] = [
    ...(includeNone ? [{ value: "", label: noneLabel }] : []),
    ...(roles?.map((r) => ({ value: r.id, label: r.name })) ?? []),
  ];

  return (
    <FormField label={label} htmlFor={id} error={error}>
      <Select
        id={id}
        value={value}
        options={options}
        onChange={onChange}
        {...(placeholder ? { placeholder } : {})}
        {...(disabled ? { disabled } : {})}
        {...(testId ? { testId } : {})}
      />
    </FormField>
  );
}
