// task-service port + @dub/http-backed implementation. The engine writes to
// origin=github tasks via a normal PATCH; the trust headers (x-dub-internal +
// x-dub-caller: github-sync) that pass the "protected 6 fields" guard are added
// automatically by the @dub/http ServiceClient.
import type { RequestContext, ServiceClient } from "@dub/http";
import type { task } from "@dub/types";

export interface TaskServiceClient {
  getTask(ctx: RequestContext, taskId: string): Promise<task.Task>;
  createTask(ctx: RequestContext, req: task.CreateTaskRequest): Promise<task.Task>;
  updateTask(ctx: RequestContext, taskId: string, req: task.UpdateTaskRequest): Promise<task.Task>;
}

export class HttpTaskClient implements TaskServiceClient {
  constructor(private readonly client: ServiceClient) {}
  getTask(ctx: RequestContext, taskId: string): Promise<task.Task> {
    return this.client.get<task.Task>(ctx, `/tasks/${encodeURIComponent(taskId)}`);
  }
  createTask(ctx: RequestContext, req: task.CreateTaskRequest): Promise<task.Task> {
    return this.client.post<task.Task, task.CreateTaskRequest>(ctx, `/tasks`, req);
  }
  updateTask(ctx: RequestContext, taskId: string, req: task.UpdateTaskRequest): Promise<task.Task> {
    // idempotencyKey enables safe retry on 5xx for this write.
    return this.client.patch<task.Task, task.UpdateTaskRequest>(ctx, `/tasks/${encodeURIComponent(taskId)}`, req, {
      idempotencyKey: `${taskId}:v${req.version}`,
    });
  }
}
