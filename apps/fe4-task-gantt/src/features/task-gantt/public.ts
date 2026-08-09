// The FE4 public surface consumed by FE2 (shell registration) / FE3 (action
// plugin) / FE5. FE4 owns no backend contract — only these front-end reuse
// points (design §2-4). Route ownership uses FeatureModule (id="tasks");
// event-context routes nest-delegate under FE3's `/events/:eventId` tree.
import type { FeatureModule } from "../../contracts/spa-shell";
import type { ActionTypePlugin } from "../../contracts/event-action";

export { TaskLink, type TaskLinkProps } from "../../components/TaskLink";
export { TaskStatusBadge, type TaskStatusBadgeProps } from "../../components/TaskStatusBadge";

/** FeatureModule registered into the FE2 shell. */
export const taskModule: FeatureModule = {
  id: "tasks",
  routes: [{ path: "/me/tasks", component: () => null, requiredPermissions: ["task:read"] }],
  nav: [{ label: "マイタスク", to: "/me/tasks", icon: "list" }],
  nestedRoutes: {
    parentModuleId: "events", // FE3 `/events/:eventId`
    routes: [
      { path: "tasks", component: () => null, requiredPermissions: ["task:read"] },
      { path: "tasks/board", component: () => null, requiredPermissions: ["task:read"] },
      { path: "tasks/gantt", component: () => null, requiredPermissions: ["task:read"] },
      { path: "tasks/:taskId", component: () => null, requiredPermissions: ["task:read"] },
    ],
  },
};

/** FE3 ActionTypeRegistry plugin: type="task_management". Thin panel + deep link. */
export function taskActionPlugin(): ActionTypePlugin {
  return {
    type: "task_management",
    label: "タスク管理",
    icon: "list",
    render: () => null, // FE3 renders the summarized panel + link to /events/:eventId/tasks
  };
}
