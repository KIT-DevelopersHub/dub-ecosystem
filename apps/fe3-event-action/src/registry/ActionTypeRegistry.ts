// ActionTypeRegistry — FE3's public contract (frozen at P0b). Maps an action
// `kind` string to a type-specific panel/icon. Registration is static at FE2 app
// init (FE4 registers taskActionPlugin; FE6 registers none in P0a). Unknown kinds
// never break the UI — they fall back to GenericActionPanel (type-freedom
// principle: new kinds are allowed without a code change).
import type * as React from "react";
import type { event } from "@dub/types";
import type { IconName } from "../contracts/fe1";

export interface ActionPanelProps {
  event: event.DubEvent;
  action: event.DubAction;
  canWrite: boolean;
  // Payload editing is a type-specific concern (DubAction has no payload field in
  // the P0 contract); plugins own their own payload shape. Routed through the
  // FE2 createOptimisticMutation on the consuming screen.
  onPayloadChange: (patch: Record<string, unknown>) => Promise<void>;
}

export interface ActionTypePlugin {
  type: string; // matches DubAction.kind, e.g. "task_management"
  label: string;
  icon: IconName;
  Panel: React.ComponentType<ActionPanelProps>;
  // Not frozen (open item #5): no consumer in P0. Kept optional.
  CardExtra?: React.ComponentType<{ action: event.DubAction }>;
}

export interface ActionTypeRegistry {
  register(plugin: ActionTypePlugin): void;
  resolve(type: string): ActionTypePlugin; // always returns (fallback if unknown)
  list(): ActionTypePlugin[];
  has(type: string): boolean;
}

/**
 * Create a registry with a mandatory fallback plugin (GenericActionPanel). The
 * fallback is injected to avoid a registry -> component import cycle.
 */
export function createActionTypeRegistry(fallback: ActionTypePlugin): ActionTypeRegistry {
  const plugins = new Map<string, ActionTypePlugin>();

  return {
    register(plugin: ActionTypePlugin): void {
      if (plugins.has(plugin.type)) {
        // Idempotent-with-warning: last registration wins but surfaces the clash.
        console.warn(`[ActionTypeRegistry] re-registering plugin for type "${plugin.type}"`);
      }
      plugins.set(plugin.type, plugin);
    },
    resolve(type: string): ActionTypePlugin {
      return plugins.get(type) ?? fallback;
    },
    list(): ActionTypePlugin[] {
      return [...plugins.values()];
    },
    has(type: string): boolean {
      return plugins.has(type);
    },
  };
}
