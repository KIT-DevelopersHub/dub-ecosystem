// Astro Content Collections config. Schemas live in framework-agnostic schemas.ts
// (so they are unit-testable); here we only bind them to collections.
import { defineCollection } from "astro:content";
import { eventSchema, newsSchema, sponsorPlanSchema } from "./schemas";

const events = defineCollection({ type: "content", schema: eventSchema });
const news = defineCollection({ type: "content", schema: newsSchema });
const sponsorPlans = defineCollection({ type: "data", schema: sponsorPlanSchema });

export const collections = { events, news, sponsorPlans };
