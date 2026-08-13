-- namespace: task | owner: task-service (#5).
-- My Tasks hub: the "issued by me" (依頼) lens lists tasks by requester across
-- events (GET /tasks?createdById=<self>). Index created_by so that scan stays
-- fast at 300-person scale, mirroring the existing assignee index.
CREATE INDEX idx_task_tasks_created_by ON task_tasks(created_by, status);
