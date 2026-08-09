// capabilities — UI show/hide from the server-returned capabilities array
// (design §1, §6: "UI は capabilities に従い出し分けのみ", myPermissions は廃止).
// The client NEVER decides authorization; it only mirrors what the BFF grants.
import type { identity } from "@dub/types";

export type Capability = identity.PermissionKey;

/** Does the resource's capability set include `key`? (default deny.) */
export function can(capabilities: readonly Capability[], key: Capability): boolean {
  return capabilities.includes(key);
}

/** S4 action editing / S3 event editing gate. */
export function canEditEvent(capabilities: readonly Capability[]): boolean {
  return can(capabilities, "event:write");
}

/** S5 task status change gate. */
export function canWriteTask(capabilities: readonly Capability[]): boolean {
  return can(capabilities, "task:write");
}
