// Offline SlackSource — reads infra/d1/fixtures/slack/*.json (or any directory with
// the same file-naming convention) instead of calling the Slack Web API. This is what
// makes the importer's dry-run mode work with zero network access / no token: the same
// `runSlackImport` orchestration in slackImportRun.ts runs unmodified against either
// this or the live `slackClient.ts`-backed source.
//
// File naming convention (mirrors the Slack API method each file stands in for):
//   users.json                                  <- users.list            (members[])
//   channels.json                                <- conversations.list    (channels[])
//   history-<channelId>.json                     <- conversations.history (messages[])
//   replies-<channelId>-<threadTs>.json          <- conversations.replies (messages[])
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { SlackChannel, SlackMessage, SlackUser } from "./slackImport";
import type { SlackSource } from "./slackImportRun";

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function createFixtureSlackSource(dir: string): SlackSource {
  return {
    async listUsers(): Promise<SlackUser[]> {
      return readJson<SlackUser[]>(join(dir, "users.json"));
    },
    async listChannels(): Promise<SlackChannel[]> {
      return readJson<SlackChannel[]>(join(dir, "channels.json"));
    },
    async historyForChannel(channelId: string): Promise<SlackMessage[]> {
      const path = join(dir, `history-${channelId}.json`);
      if (!existsSync(path)) return [];
      return readJson<SlackMessage[]>(path);
    },
    async repliesForThread(channelId: string, threadTs: string): Promise<SlackMessage[]> {
      const path = join(dir, `replies-${channelId}-${threadTs}.json`);
      if (!existsSync(path)) return [];
      return readJson<SlackMessage[]>(path);
    },
  };
}
