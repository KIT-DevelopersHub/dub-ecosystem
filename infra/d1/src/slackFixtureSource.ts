// Offline SlackSource — reads infra/d1/fixtures/slack/*.json (or any directory with
// the same file-naming convention) instead of calling the Slack Web API. This is what
// makes the importer's dry-run mode work with zero network access / no token: the same
// `runSlackImport` orchestration (@dub/slack-import) runs unmodified against either
// this or the live Slack client.
//
// File naming convention (mirrors the Slack API method each file stands in for):
//   users.json                                  <- users.list            (members[])
//   channels.json                                <- conversations.list    (channels[])
//   history-<channelId>.json                     <- conversations.history (messages[])
//   replies-<channelId>-<threadTs>.json          <- conversations.replies (messages[])
//   members-<channelId>.json                     <- conversations.members (members[])
//   bookmarks-<channelId>.json                   <- bookmarks.list        (bookmarks[])
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { SlackBookmark, SlackChannel, SlackMessage, SlackSource, SlackUser } from "@dub/slack-import";

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readOptional<T>(path: string): T[] {
  return existsSync(path) ? readJson<T[]>(path) : [];
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
      return readOptional<SlackMessage>(join(dir, `history-${channelId}.json`));
    },
    async repliesForThread(channelId: string, threadTs: string): Promise<SlackMessage[]> {
      return readOptional<SlackMessage>(join(dir, `replies-${channelId}-${threadTs}.json`));
    },
    async membersOfChannel(channelId: string): Promise<string[]> {
      return readOptional<string>(join(dir, `members-${channelId}.json`));
    },
    async bookmarksForChannel(channelId: string): Promise<SlackBookmark[]> {
      return readOptional<SlackBookmark>(join(dir, `bookmarks-${channelId}.json`));
    },
  };
}
