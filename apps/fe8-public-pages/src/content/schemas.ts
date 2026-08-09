// Content Collections schemas — the SINGLE SOURCE OF TRUTH for FE8 content
// (design §2-3/§3: repo Content Collections are canonical; no public GET API).
// Kept framework-agnostic (imports `zod` directly, not `astro:content`) so unit
// tests validate content without the Astro runtime. config.ts wraps these.
//
// NOTE(design §2-3): EventContent.status is FE8's DISPLAY vocabulary and is
// deliberately distinct from event-service EventPhase (no double-canonicalization).

import { z } from "zod";

export const eventStatusValues = ["announced", "open", "closed", "finished"] as const;

export const timetableRowSchema = z.object({
  time: z.string().min(1),
  title: z.string().min(1),
  speaker: z.string().optional(),
  track: z.string().optional(),
});

export const speakerSchema = z.object({
  name: z.string().min(1),
  org: z.string().optional(),
  avatarUrl: z.string().optional(),
  bio: z.string().optional(),
});

export const sponsorTierSchema = z.object({
  tier: z.string().min(1),
  sponsors: z
    .array(
      z.object({
        name: z.string().min(1),
        logoUrl: z.string().min(1),
        url: z.string().url().optional(),
      }),
    )
    .default([]),
});

export const eventSchema = z.object({
  title: z.string().min(1),
  status: z.enum(eventStatusValues),
  dateStart: z.string().min(1),
  dateEnd: z.string().optional(),
  venue: z.object({
    name: z.string().min(1),
    address: z.string().optional(),
    mapUrl: z.string().url().optional(),
  }),
  summary: z.string().min(1),
  timetable: z.array(timetableRowSchema).optional(),
  speakers: z.array(speakerSchema).optional(),
  sponsorTiers: z.array(sponsorTierSchema).optional(),
  registrationUrl: z.string().url().optional(),
  ogImage: z.string().optional(),
});

export const newsSchema = z.object({
  title: z.string().min(1),
  publishedAt: z.string().min(1),
  summary: z.string().optional(),
});

export const sponsorTierValues = ["platinum", "gold", "silver", "bronze", "custom"] as const;

export const sponsorPlanSchema = z.object({
  tier: z.enum(sponsorTierValues),
  label: z.string().min(1),
  priceJpy: z.number().int().nonnegative().nullable(),
  benefits: z.array(z.string().min(1)).min(1),
  capacity: z.number().int().positive().optional(),
  order: z.number().int().default(0),
});

export type EventContentData = z.infer<typeof eventSchema>;
export type NewsContentData = z.infer<typeof newsSchema>;
export type SponsorPlanData = z.infer<typeof sponsorPlanSchema>;
