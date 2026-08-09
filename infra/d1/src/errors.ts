// Seed-specific error codes — SCREAMING_SNAKE `<SERVICE>_<REASON>` (theme-3 D7).
// Emitted as @dub/errors DubError with an explicit status (open ErrorCode union).
export type SeedErrorCode =
  | "SEED_ENV_FORBIDDEN" // seed/reset targeted a prod database (database_name = dub-core)
  | "SEED_FIXTURE_CONFLICT"; // a fixed fixture id collides with existing non-seed data

// Prod database name — the single guard source (not env self-report; theme-12).
export const PROD_DB_NAME = "dub-core";
