// Echo-loop suppression. Pure predicates.
//
// Two write paths can echo back to us:
//  1. Our own writes into task-service surface as task.* domain events whose
//     actorId is transcribed from x-dub-caller -> "service:github-sync".
//  2. Our own writes into GitHub surface as webhooks whose sender is our App.
//
// (8-N6 remains open: whether task-service actually transcribes x-dub-caller into
//  the event actorId. This predicate encodes the agreed convention regardless.)

export const SELF_SERVICE_ACTOR = "service:github-sync";

/** A task.* domain event caused by our own write -> drop it. */
export function isSelfCausedEvent(actorId: string | null): boolean {
  return actorId === SELF_SERVICE_ACTOR;
}

/**
 * A GitHub webhook whose sender is our own App -> drop it.
 * `senderLogin` comes from the raw payload `sender.login`; `selfLogins` are the
 * bot/app identities we write as (e.g. "dub-sync[bot]").
 */
export function isSelfCausedWebhook(
  senderLogin: string | null | undefined,
  selfLogins: readonly string[],
): boolean {
  if (!senderLogin) return false;
  const s = senderLogin.toLowerCase();
  return selfLogins.some((l) => l.toLowerCase() === s);
}
