import type { ComponentType } from "react";
import { LP_SECTION_REGISTRY, type LpSectionId } from "./registry";
import { SECTION_VARIANTS, type SectionProps } from "./variants";

/**
 * 1 セクションの全バリアントを SSG で描いておく。どれを見せるかは <html> の data-lp-s-<id> と
 * siteConfigCss() の CSS が決める（属性が無ければ既定のバリアント）。包みは display:contents。
 */
export function SectionSlot<S extends LpSectionId>({ id, props }: { id: S; props: SectionProps[S] }) {
  const variants = SECTION_VARIANTS[id] as Record<string, ComponentType<SectionProps[S]>>;
  const def = LP_SECTION_REGISTRY[id];
  return (
    <div data-lp-slot={id}>
      {Object.keys(def.variants).map((v) => {
        const Variant = variants[v]!;
        return (
          <div key={v} data-lp-variant={v}>
            <Variant {...props} />
          </div>
        );
      })}
    </div>
  );
}
