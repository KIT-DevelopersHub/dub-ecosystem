// STUB for @dub/ui/icons (FE1 not yet built). Closed IconName union (Lucide subset)
// + a minimal <Icon>. Replace this module with the real `@dub/ui/icons` import when
// FE1 ships; the IconName union is the contract FeatureModule.nav depends on.

export type IconName =
  | "home"
  | "calendar"
  | "check-square"
  | "bell"
  | "message-square"
  | "shield"
  | "settings"
  | "users"
  | "file"
  | "alert-triangle"
  | "log-out";

const GLYPH: Record<IconName, string> = {
  home: "H",
  calendar: "C",
  "check-square": "T",
  bell: "N",
  "message-square": "M",
  shield: "A",
  settings: "S",
  users: "U",
  file: "F",
  "alert-triangle": "!",
  "log-out": "X",
};

export function Icon({ name, testId }: { name: IconName; testId?: string }): JSX.Element {
  return (
    <span aria-hidden="true" data-icon={name} data-testid={testId}>
      {GLYPH[name]}
    </span>
  );
}
