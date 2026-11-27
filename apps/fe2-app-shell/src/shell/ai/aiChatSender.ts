// The AI side panel's send function is injected, so turning the AI on is a wiring change only:
// when AI_CHAT_AVAILABLE flips to true, the event context is sent to the event question API
// (#888, POST /api/v1/events/:id/ask). While it is false nothing here is called.
import type { event } from "@dub/types";
import { AI_CHAT_AVAILABLE } from "@dub/app-ui";
import type { EventApi } from "@dub/fe3-event-action";
import type { AiPanelTarget } from "./aiPanelContext.ts";

export type AiPanelSender = (question: string) => Promise<event.AskEventResponse>;

export function createEventAskSender(eventApi: EventApi, eventId: string): AiPanelSender {
  return (question) => eventApi.askEvent(eventId, { question });
}

/** The sender for the current context, or undefined while the AI chat is closed / not wired. */
export function pickAiPanelSender(
  target: AiPanelTarget,
  eventApi: EventApi | undefined,
  available: boolean = AI_CHAT_AVAILABLE,
): AiPanelSender | undefined {
  if (!available || !eventApi || target.kind !== "event") return undefined;
  return createEventAskSender(eventApi, target.eventId);
}
