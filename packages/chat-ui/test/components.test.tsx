// Static-markup rendering for the chat surface's pieces, following the same
// convention as test/pages.test.tsx: no live backing, fixture props in,
// honest markup out.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { Channel, MessageItem } from "../src/api";
import { Composer } from "../src/composer";
import { ChatSidebar } from "../src/sidebar";
import { ChannelTimeline } from "../src/timeline";

const channel = (overrides: Partial<Channel>): Channel => ({
  id: "c1",
  title: "General",
  kind: "channel",
  pinned: true,
  participants: [],
  ...overrides,
});

describe("ChatSidebar", () => {
  test("renders channels and chats under their own sections", () => {
    const markup = renderToStaticMarkup(
      <ChatSidebar
        channels={[channel({ id: "c1", title: "General" })]}
        chats={[channel({ id: "c2", title: "DM with Ada", kind: "chat" })]}
        activeChannelId="c1"
        onSelect={() => undefined}
        onNewChannel={() => undefined}
      />,
    );
    expect(markup).toContain("Channels");
    expect(markup).toContain("Chats");
    expect(markup).toContain("General");
    expect(markup).toContain("DM with Ada");
  });

  test("marks the active channel current", () => {
    const markup = renderToStaticMarkup(
      <ChatSidebar
        channels={[channel({ id: "c1" })]}
        chats={[]}
        activeChannelId="c1"
        onSelect={() => undefined}
        onNewChannel={() => undefined}
      />,
    );
    expect(markup).toContain('aria-current="true"');
  });

  test("shows the empty state with no channels or chats", () => {
    const markup = renderToStaticMarkup(
      <ChatSidebar
        channels={[]}
        chats={[]}
        activeChannelId={null}
        onSelect={() => undefined}
        onNewChannel={() => undefined}
      />,
    );
    expect(markup).toContain("No channels yet");
  });
});

describe("ChannelTimeline", () => {
  const items: MessageItem[] = [
    {
      id: "m1",
      createdAt: "2026-01-01T00:00:00.000Z",
      parts: [{ kind: "text", text: "hello there" }],
    },
    {
      id: "m2",
      createdAt: "2026-01-01T00:01:00.000Z",
      parts: [{ kind: "event", event: "member.joined", data: {} }],
    },
    {
      id: "m3",
      createdAt: "2026-01-01T00:02:00.000Z",
      parts: [
        {
          kind: "tool-trace",
          name: "search",
          input: { q: "x" },
          status: "success",
        },
      ],
    },
  ];

  test("renders a text part as a bubble", () => {
    const markup = renderToStaticMarkup(<ChannelTimeline items={items} />);
    expect(markup).toContain("hello there");
  });

  test("shows the sender's name when present", () => {
    const withSender: MessageItem[] = [
      {
        id: "m4",
        createdAt: "2026-01-01T00:03:00.000Z",
        parts: [{ kind: "text", text: "hi" }],
        sender: { name: "Researcher", address: "researcher@agents.example" },
      },
    ];
    const markup = renderToStaticMarkup(<ChannelTimeline items={withSender} />);
    expect(markup).toContain("Researcher");
  });

  test("falls back to the sender's address local part with no name and no matching participant", () => {
    const withSender: MessageItem[] = [
      {
        id: "m5",
        createdAt: "2026-01-01T00:04:00.000Z",
        parts: [{ kind: "text", text: "hi" }],
        sender: { name: null, address: "researcher@agents.example" },
      },
    ];
    const markup = renderToStaticMarkup(<ChannelTimeline items={withSender} />);
    expect(markup).toContain("researcher");
  });

  test("shows a matching participant's friendly handle over the raw local part", () => {
    const withSender: MessageItem[] = [
      {
        id: "m6",
        createdAt: "2026-01-01T00:05:00.000Z",
        parts: [{ kind: "text", text: "hi" }],
        sender: { name: null, address: "ins_cd03d8e3@agents.example" },
      },
    ];
    const markup = renderToStaticMarkup(
      <ChannelTimeline
        items={withSender}
        participants={[
          { address: "ins_cd03d8e3@agents.example", handle: "echo" },
        ]}
      />,
    );
    expect(markup).toContain("echo");
    expect(markup).not.toContain("ins_cd03d8e3");
  });

  test("renders an event part as an inline line", () => {
    const markup = renderToStaticMarkup(<ChannelTimeline items={items} />);
    expect(markup).toContain("member.joined");
  });

  test("renders any other part kind as a labeled fallback block", () => {
    const markup = renderToStaticMarkup(<ChannelTimeline items={items} />);
    expect(markup).toContain("[tool-trace]");
  });

  test("shows the empty timeline state with no messages", () => {
    const markup = renderToStaticMarkup(<ChannelTimeline items={[]} />);
    expect(markup).toContain("No messages yet");
  });
});

describe("Composer", () => {
  test("disables send while the draft is empty", () => {
    const markup = renderToStaticMarkup(
      <Composer agents={[]} onSend={() => undefined} />,
    );
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>/);
  });

  test("accepts mention candidates keyed by handle and label", () => {
    const markup = renderToStaticMarkup(
      <Composer
        agents={[
          {
            id: "researcher@agents.example",
            handle: "researcher",
            label: "Researcher",
          },
        ]}
        onSend={() => undefined}
      />,
    );
    expect(markup).not.toContain("@undefined");
  });
});
