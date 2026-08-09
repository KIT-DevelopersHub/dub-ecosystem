// JSON-LD builders (design §2-2 Seo/JsonLd, §7 test-point 2: Event schema on LPs).
// Pure functions returning schema.org objects; serialized into <script type="application/ld+json">.

export interface OrganizationJsonLdInput {
  name: string;
  url: string;
  logo?: string;
  sameAs?: string[];
}

export interface EventJsonLdInput {
  name: string;
  url: string;
  startDate: string;
  endDate?: string;
  description?: string;
  locationName?: string;
  locationAddress?: string;
  status?: "announced" | "open" | "closed" | "finished";
  image?: string;
}

export function organizationJsonLd(input: OrganizationJsonLdInput): Record<string, unknown> {
  const node: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: input.name,
    url: input.url,
  };
  if (input.logo) node.logo = input.logo;
  if (input.sameAs && input.sameAs.length > 0) node.sameAs = input.sameAs;
  return node;
}

const STATUS_TO_SCHEMA: Record<NonNullable<EventJsonLdInput["status"]>, string> = {
  announced: "https://schema.org/EventScheduled",
  open: "https://schema.org/EventScheduled",
  closed: "https://schema.org/EventScheduled",
  finished: "https://schema.org/EventScheduled",
};

export function eventJsonLd(input: EventJsonLdInput): Record<string, unknown> {
  const node: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Event",
    name: input.name,
    url: input.url,
    startDate: input.startDate,
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    eventStatus: STATUS_TO_SCHEMA[input.status ?? "announced"],
  };
  if (input.endDate) node.endDate = input.endDate;
  if (input.description) node.description = input.description;
  if (input.image) node.image = input.image;
  if (input.locationName) {
    node.location = {
      "@type": "Place",
      name: input.locationName,
      ...(input.locationAddress ? { address: input.locationAddress } : {}),
    };
  }
  return node;
}

/** Escape "</script>" so a JSON-LD payload cannot break out of its tag. */
export function serializeJsonLd(node: Record<string, unknown>): string {
  return JSON.stringify(node).replace(/</g, "\\u003c");
}
