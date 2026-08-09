// event-service port for eventId existence checks at repo registration time.
import type { RequestContext, ServiceClient } from "@dub/http";
import { isDubError } from "@dub/errors";
import type { event } from "@dub/types";

export interface EventExistenceClient {
  exists(ctx: RequestContext, eventId: string): Promise<boolean>;
}

export class HttpEventClient implements EventExistenceClient {
  constructor(private readonly client: ServiceClient) {}
  async exists(ctx: RequestContext, eventId: string): Promise<boolean> {
    try {
      await this.client.get<event.GetEventResponse>(ctx, `/events/${encodeURIComponent(eventId)}`);
      return true;
    } catch (err) {
      if (isDubError(err) && err.status === 404) return false;
      throw err;
    }
  }
}
