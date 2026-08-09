// Local stand-in for FE3's `@spa/features/event-action` ActionTypeRegistry
// contract. FE3 owns it; FE4 only registers a `task_management` plugin.
export interface ActionTypePlugin {
  type: string; // "task_management"
  label: string;
  icon: string; // FE1 IconName
  /** rendered inside an action detail as a thin panel + deep-link to FE4. */
  render: (ctx: ActionPluginContext) => unknown;
}

export interface ActionPluginContext {
  eventId: string;
  actionId: string;
}
