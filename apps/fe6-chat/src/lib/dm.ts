// DM labelling: a DM has no name of its own — Slack shows "the other side", which
// differs per viewer. Pure so the sidebar, header and composer agree on one label.
import type { common, identity } from "@dub/types";
import type { Channel } from "../api/contract";

/** Participants other than me. Empty for a self-only DM (the system notice DM). */
export function dmPeerIds(channel: Channel, me: common.UserId): common.UserId[] {
  return (channel.memberIds ?? []).filter((id) => id !== me);
}

/**
 * Display label for a channel. Non-DMs keep their name. A DM joins its peers'
 * display names; null = a peer is still resolving (render a skeleton, never a raw
 * user id). A DM with no peers (older server, or the system notice DM) keeps its
 * stored name.
 */
export function channelLabel(
  channel: Channel,
  me: common.UserId,
  resolve: (id: common.UserId) => identity.UserSummary | undefined,
): string | null {
  if (channel.type !== "dm") return channel.name;
  const peers = dmPeerIds(channel, me);
  if (peers.length === 0) return channel.name;
  const names = peers.map((id) => resolve(id)?.displayName);
  if (names.some((n) => !n)) return null;
  return names.join("、");
}

/** Prefix shown before a channel label in the composer / settings ("#general" vs "佐藤 花子"). */
export function channelHandle(channel: Channel, label: string): string {
  return channel.type === "dm" ? label : `#${label}`;
}
