// Local contract mirror of FE3's public `ActionTypeRegistry` surface
// (`@dub/fe3-event-action` → registry/ActionTypeRegistry). FE3 owns it; FE4 only
// registers a `task_management` plugin. This mirror is structurally identical to
// FE3's real contract so FE4 builds/tests standalone while FE3 is a parallel unit.
//
// Cross-PR integration (when FE3 ships): FE4 consumes FE3 ONLY via its package
// public export — do NOT import FE3 internal files. Swap this mirror for:
//   import {
//     type ActionTypePlugin, type ActionPanelProps, type ActionTypeRegistry,
//     actionTypeRegistry,
//   } from "@dub/fe3-event-action";
// and call `registerTaskActionPlugin(actionTypeRegistry)` at FE2 app init.
import type { ComponentType } from "react";
import type { event } from "@dub/types";

/** Closed FE1 IconName union (mirror of FE3 contracts/fe1 `IconName`). */
export type IconName =
  | "calendar"
  | "plus"
  | "edit"
  | "trash"
  | "archive"
  | "chevron-right"
  | "chevron-down"
  | "chat"
  | "drag"
  | "check"
  | "clock"
  | "user"
  | "flag"
  | "list"
  | "settings"
  | "warning"
  | "task";

/** Props FE3 hands a type-specific action panel (mirror of FE3 ActionPanelProps). */
export interface ActionPanelProps {
  event: event.DubEvent;
  action: event.DubAction;
  canWrite: boolean;
  // Payload editing is a type-specific concern (DubAction has no payload field in
  // the P0 contract); plugins own their own payload shape, routed through the FE2
  // createOptimisticMutation on the consuming screen.
  onPayloadChange: (patch: Record<string, unknown>) => Promise<void>;
}

/** A plugin FE4 registers into FE3's ActionTypeRegistry (matches DubAction.kind). */
export interface ActionTypePlugin {
  type: string; // "task_management"
  label: string;
  icon: IconName;
  Panel: ComponentType<ActionPanelProps>;
  // Not frozen (FE3 open item #5): no consumer in P0. Kept optional.
  CardExtra?: ComponentType<{ action: event.DubAction }>;
}

/** FE3's registry API (FE4 registers into it at FE2 app init). */
export interface ActionTypeRegistry {
  register(plugin: ActionTypePlugin): void;
  resolve(type: string): ActionTypePlugin; // always returns (fallback if unknown)
  list(): ActionTypePlugin[];
  has(type: string): boolean;
}
