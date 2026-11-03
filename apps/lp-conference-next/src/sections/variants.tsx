import type { ComponentProps, ComponentType } from "react";
import { About } from "@/components/About";
import { Apply } from "@/components/Apply";
import { Contact } from "@/components/Contact";
import { Crowdfunding } from "@/components/Crowdfunding";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { Program } from "@/components/Program";
import { Vision } from "@/components/Vision";
import type { LP_SECTION_REGISTRY, LpSectionId } from "./registry";

/** セクションごとの props（同じセクションのバリアントは同じ props を受け取る）。 */
export interface SectionProps {
  header: ComponentProps<typeof Header>;
  join: ComponentProps<typeof Apply>;
  program: ComponentProps<typeof Program>;
  about: ComponentProps<typeof About>;
  crowdfunding: ComponentProps<typeof Crowdfunding>;
  vision: ComponentProps<typeof Vision>;
  contact: ComponentProps<typeof Contact>;
  footer: ComponentProps<typeof Footer>;
}

type VariantId<S extends LpSectionId> = keyof (typeof LP_SECTION_REGISTRY)[S]["variants"];
type VariantMap = { [S in LpSectionId]: { [V in VariantId<S>]: ComponentType<SectionProps[S]> } };

/**
 * セクション → バリアント → コンポーネント。登録簿（@dub/types LP_SECTION_REGISTRY）と satisfies で
 * 突き合わせるので、登録簿にあるバリアントがここに無い・ここにしか無い、はどちらも typecheck で落ちる。
 * バリアントを足す: 1) components/sections/... に部品を作る 2) 登録簿の variants に足す 3) ここに足す。
 */
export const SECTION_VARIANTS = {
  header: { a: Header },
  join: { a: Apply },
  program: { a: Program },
  about: { a: About },
  crowdfunding: { a: Crowdfunding },
  vision: { a: Vision },
  contact: { a: Contact },
  footer: { a: Footer },
} satisfies VariantMap;
