// The FE4 public surface consumed by FE2 (shell registration), FE3 (action
// plugin + event-nested task routes), and FE5 (TaskLink/TaskStatusBadge reuse).
// FE4 owns no backend contract — only these front-end reuse points (design §2-4).
//
// Route ownership (design §2-5, segment ownership):
//   - `taskModule` (id="tasks") owns the standalone `/me/tasks` segment.
//   - The event-scoped task routes are NOT a second module (that would duplicate
//     FE3's `/events/:eventId` ownership and fail the registry's segment check).
//     They are exported as `eventTaskRoutes` and nest under FE3's events segment
//     via `FeatureRoute.children` — FE3 splices them into its `/events/:eventId`
//     route at app init (`mountTaskRoutesUnder`).
//
// Cross-PR integration (FE2/FE3 unmerged — mirrors kept local, not depended on):
//   import { eventFeatureModule, actionTypeRegistry, routePaths } from "@dub/fe3-event-action";
//   import { registerFeatureModules } from "@dub/fe2-app-shell";
//   // 1) nest FE4 task routes under FE3's /events/:eventId
//   const events = mountTaskRoutesUnder(eventFeatureModule.routes.find(r => r.path === routePaths.detail)!);
//   // 2) register modules with the shell, then register the action plugin
//   registerTaskActionPlugin(actionTypeRegistry);
import type { FeatureModule, FeatureRoute } from "../../contracts/spa-shell";
import type { ActionTypePlugin, ActionTypeRegistry } from "../../contracts/event-action";
import { TaskActionPanel } from "../../components/TaskActionPanel";

export { TaskLink, type TaskLinkProps } from "../../components/TaskLink";
export { TaskStatusBadge, type TaskStatusBadgeProps } from "../../components/TaskStatusBadge";
export {
  TaskRouteProvider,
  useTaskRoute,
  type TaskRouteContextValue,
} from "../../routes/taskRoutes";

// Lazy route loaders (FE2 FeatureRoute.lazy contract: () => Promise<{ Component }>).
const meTasksLazy: FeatureRoute["lazy"] = () =>
  import("../../routes/taskRoutes").then((m) => ({ Component: m.MeTasksRoute }));
const workspaceLazy: FeatureRoute["lazy"] = () =>
  import("../../routes/taskRoutes").then((m) => ({ Component: m.TaskWorkspaceRoute }));

/**
 * Event-scoped task routes — nested under FE3's `/events/:eventId` segment via
 * `FeatureRoute.children`. Paths mirror FE3 `routePaths.tasks` (+ sub-views);
 * consume `routePaths` from `@dub/fe3-event-action` at integration.
 */
export const eventTaskRoutes: FeatureRoute[] = [
  { path: "/events/:eventId/tasks", lazy: workspaceLazy, auth: "required", requiredPermissions: ["task:read"] },
  { path: "/events/:eventId/tasks/board", lazy: workspaceLazy, auth: "required", requiredPermissions: ["task:read"] },
  { path: "/events/:eventId/tasks/gantt", lazy: workspaceLazy, auth: "required", requiredPermissions: ["task:read"] },
  { path: "/events/:eventId/tasks/:taskId", lazy: workspaceLazy, auth: "required", requiredPermissions: ["task:read"] },
];

/** FeatureModule registered into the FE2 shell (owns only the `/me/tasks` segment). */
export const taskModule: FeatureModule = {
  id: "tasks",
  routes: [
    { path: "/me/tasks", lazy: meTasksLazy, auth: "required", requiredPermissions: ["task:read"] },
  ],
  nav: [{ label: "マイタスク", path: "/me/tasks", icon: "check-square", order: 20 }],
};

/**
 * Nest FE4's event-scoped task routes under an FE3 event route via
 * `FeatureRoute.children`. Pure: returns a new route (does not mutate the input).
 * FE3/FE2 call this at app init with FE3's `/events/:eventId` route.
 */
export function mountTaskRoutesUnder(eventRoute: FeatureRoute): FeatureRoute {
  return { ...eventRoute, children: [...(eventRoute.children ?? []), ...eventTaskRoutes] };
}

/**
 * FE3 ActionTypeRegistry plugin: type="task_management". Thin summary panel +
 * deep link into FE4's event tasks board (TaskActionPanel).
 */
export function taskActionPlugin(): ActionTypePlugin {
  return {
    type: "task_management",
    label: "タスク管理",
    icon: "task",
    Panel: TaskActionPanel,
  };
}

/**
 * Register the `task_management` plugin into FE3's exported `actionTypeRegistry`.
 * Called once at FE2 app init with FE3's registry singleton
 * (`import { actionTypeRegistry } from "@dub/fe3-event-action"`).
 */
export function registerTaskActionPlugin(registry: ActionTypeRegistry): void {
  registry.register(taskActionPlugin());
}
