import type { IconProps, Size } from "../types";
import { iconRegistry } from "../icons";

const SIZE_PX: Record<Size, number> = { sm: 16, md: 20, lg: 24 };

/**
 * Name-resolved icon (凍結案 1-1-7). Decorative by default (`aria-hidden`); pass
 * `aria-label` to make it a meaningful image.
 */
export function Icon({ name, size = "md", testId, className, ...rest }: IconProps) {
  const Cmp = iconRegistry[name];
  const label = rest["aria-label"];
  return (
    <Cmp
      width={SIZE_PX[size]}
      height={SIZE_PX[size]}
      className={className}
      data-testid={testId}
      data-icon={name}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      focusable={false}
    />
  );
}
