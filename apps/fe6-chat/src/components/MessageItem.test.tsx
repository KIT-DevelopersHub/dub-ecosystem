import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Message } from "../api/contract";
import { MessageItem } from "./MessageItem";

const ME = "usr_me";
const OTHER = "usr_other";
function msg(over: Partial<Message> = {}): Message {
  return {
    id: "msg_a",
    channelId: "chn",
    authorId: OTHER,
    body: "hello",
    threadRootId: null,
    replyCount: 0,
    reactions: [],
    attachments: [],
    editedAt: null,
    deletedAt: null,
    version: 1,
    createdAt: "2026-08-09T01:00:00Z",
    ...over,
  };
}

describe("MessageItem authorization UI", () => {
  it("shows edit + delete to the author", () => {
    render(<MessageItem message={msg({ authorId: ME })} currentUserId={ME} canModerate={false} />);
    expect(screen.getByTestId("fe6-timeline-edit")).toBeInTheDocument();
    expect(screen.getByTestId("fe6-timeline-delete")).toBeInTheDocument();
  });

  it("hides both from a non-author non-moderator", () => {
    render(<MessageItem message={msg()} currentUserId={ME} canModerate={false} />);
    expect(screen.queryByTestId("fe6-timeline-edit")).toBeNull();
    expect(screen.queryByTestId("fe6-timeline-delete")).toBeNull();
  });

  it("lets a moderator delete but never edit others' messages", () => {
    render(<MessageItem message={msg()} currentUserId={ME} canModerate={true} />);
    expect(screen.queryByTestId("fe6-timeline-edit")).toBeNull();
    expect(screen.getByTestId("fe6-timeline-delete")).toBeInTheDocument();
  });

  it("renders a redacted tombstone for deleted messages", () => {
    render(<MessageItem message={msg({ deletedAt: "2026-08-09T02:00:00Z", body: "" })} currentUserId={ME} canModerate={true} />);
    expect(screen.getByTestId("fe6-timeline-deleted")).toBeInTheDocument();
    expect(screen.queryByTestId("fe6-timeline-body")).toBeNull();
    expect(screen.queryByTestId("fe6-timeline-delete")).toBeNull();
  });

  it("renders a system post (authorId=null) without crashing and shows no author affordances", () => {
    // Regression: chat-service system posts carry authorId=null; the avatar/name
    // path used to call null.trim() and crash the whole /chat screen.
    render(<MessageItem message={msg({ authorId: null })} currentUserId={ME} canModerate={true} />);
    expect(screen.getByTestId("fe6-timeline-body")).toBeInTheDocument();
    expect(screen.getByText("システム")).toBeInTheDocument();
    expect(screen.queryByTestId("fe6-timeline-edit")).toBeNull();
    expect(screen.queryByTestId("fe6-timeline-delete")).toBeNull(); // system posts are not moderatable
  });

  it("renders a mention with the resolved display name", () => {
    render(
      <MessageItem
        message={msg({ body: `hi <@${ME}>` })}
        currentUserId={ME}
        canModerate={false}
        resolveUser={(id) => (id === ME ? { id: ME, displayName: "Me", avatarUrl: null } : undefined)}
      />,
    );
    expect(screen.getByText("@Me")).toBeInTheDocument();
  });
});
