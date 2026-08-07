// Static-markup rendering for the chat surface's pieces, following the same
// convention as test/pages.test.tsx: no live backing, fixture props in,
// honest markup out.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { Channel, MessageItem } from "../src/api";
import { Composer } from "../src/composer";
import {
  canSubmitNewChannel,
  newChannelPayload,
} from "../src/new-channel-dialog";
import { ChatSidebar } from "../src/sidebar";
import { ChannelTimeline } from "../src/timeline";

/** The floor: no rendered text may ever contain a raw identifier. */
const RAW_ID_PATTERN = /\b(prn_|ins_|tnt_)[a-z0-9]/i;

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

  test("hides the Channels heading when there are channels but no pinned channels", () => {
    const markup = renderToStaticMarkup(
      <ChatSidebar
        channels={[]}
        chats={[channel({ id: "c2", title: "DM with Ada", kind: "chat" })]}
        activeChannelId="c2"
        onSelect={() => undefined}
        onNewChannel={() => undefined}
      />,
    );
    expect(markup).not.toContain("Channels");
    expect(markup).toContain("Chats");
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

  test("badges a chat row by its fixed agent, never a raw address", () => {
    const markup = renderToStaticMarkup(
      <ChatSidebar
        channels={[]}
        chats={[
          channel({
            id: "c2",
            title: "echo",
            kind: "chat",
            participants: [
              { address: "ins_cd03d8e3@agents.example", handle: "echo" },
            ],
          }),
        ]}
        activeChannelId="c2"
        onSelect={() => undefined}
        onNewChannel={() => undefined}
      />,
    );
    expect(markup).toContain("Agent");
    expect(markup).not.toMatch(RAW_ID_PATTERN);
  });

  test("shows no agent badge on a channel row", () => {
    const markup = renderToStaticMarkup(
      <ChatSidebar
        channels={[channel({ id: "c1", title: "General" })]}
        chats={[]}
        activeChannelId="c1"
        onSelect={() => undefined}
        onNewChannel={() => undefined}
      />,
    );
    expect(markup).not.toContain("Agent");
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

  test("falls back to a deterministic 'Member' label with no name and no matching participant", () => {
    const withSender: MessageItem[] = [
      {
        id: "m5",
        createdAt: "2026-01-01T00:04:00.000Z",
        parts: [{ kind: "text", text: "hi" }],
        sender: { name: null, address: "prn_a1b2c3@agents.example" },
      },
    ];
    const markup = renderToStaticMarkup(<ChannelTimeline items={withSender} />);
    expect(markup).toContain("Member");
    expect(markup).not.toMatch(RAW_ID_PATTERN);
  });

  test("falls back to 'Member' for any unmatched sender address, agent-shaped or not", () => {
    const withSender: MessageItem[] = [
      {
        id: "m5b",
        createdAt: "2026-01-01T00:04:30.000Z",
        parts: [{ kind: "text", text: "hi" }],
        sender: { name: null, address: "ins_unknown1@agents.example" },
      },
    ];
    const markup = renderToStaticMarkup(<ChannelTimeline items={withSender} />);
    expect(markup).toContain("Member");
    expect(markup).not.toMatch(RAW_ID_PATTERN);
  });

  test("shows a matching participant's friendly handle over the raw local part, badged as an agent", () => {
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
    expect(markup).toContain("@echo");
    expect(markup).toContain("Agent");
    expect(markup).not.toMatch(RAW_ID_PATTERN);
  });

  test("renders the signed-in user's own message as 'You'", () => {
    const withSender: MessageItem[] = [
      {
        id: "m7",
        createdAt: "2026-01-01T00:06:00.000Z",
        parts: [{ kind: "text", text: "hi" }],
        sender: { name: null, address: "prn_self1@agents.example" },
      },
    ];
    const markup = renderToStaticMarkup(
      <ChannelTimeline
        items={withSender}
        currentUser={{ principalId: "prn_self1" }}
      />,
    );
    expect(markup).toContain("You");
    expect(markup).not.toMatch(RAW_ID_PATTERN);
  });

  test("renders an event part as a friendly humanized line", () => {
    const markup = renderToStaticMarkup(<ChannelTimeline items={items} />);
    expect(markup).toContain("member joined");
    expect(markup).not.toContain("member.joined");
  });

  test("renders the signed-in user's own bubble right-aligned, others left-aligned", () => {
    const bothSenders: MessageItem[] = [
      {
        id: "m-own",
        createdAt: "2026-01-01T00:10:00.000Z",
        parts: [{ kind: "text", text: "mine" }],
        sender: { name: null, address: "prn_self1@agents.example" },
      },
      {
        id: "m-other",
        createdAt: "2026-01-01T00:11:00.000Z",
        parts: [{ kind: "text", text: "theirs" }],
        sender: { name: null, address: "prn_other1@agents.example" },
      },
    ];
    const markup = renderToStaticMarkup(
      <ChannelTimeline
        items={bothSenders}
        currentUser={{ principalId: "prn_self1" }}
      />,
    );
    expect(markup).toContain('data-own="true"');
    expect(markup).toContain('data-own="false"');
  });

  test("inserts a day divider between items on different calendar days", () => {
    const acrossDays: MessageItem[] = [
      {
        id: "d1",
        createdAt: "2026-01-01T23:59:00.000Z",
        parts: [{ kind: "text", text: "before midnight" }],
      },
      {
        id: "d2",
        createdAt: "2026-01-02T00:01:00.000Z",
        parts: [{ kind: "text", text: "after midnight" }],
      },
    ];
    const markup = renderToStaticMarkup(<ChannelTimeline items={acrossDays} />);
    expect(markup).toContain("chat-day-divider");
  });

  test("renders an agent-joined event by the joining agent's handle, never its address", () => {
    const joinItems: MessageItem[] = [
      {
        id: "m8",
        createdAt: "2026-01-01T00:07:00.000Z",
        parts: [
          {
            kind: "event",
            event: "channel.agent-joined",
            data: {
              address: "ins_newagent1@agents.example",
              definitionId: "wfd_echo",
              invitedBy: "prn_inviter1",
            },
          },
        ],
      },
    ];
    const markup = renderToStaticMarkup(
      <ChannelTimeline
        items={joinItems}
        participants={[
          { address: "ins_newagent1@agents.example", handle: "echo" },
        ]}
      />,
    );
    expect(markup).toContain("@echo joined");
    expect(markup).not.toMatch(RAW_ID_PATTERN);
  });

  test("renders any other part kind as a labeled fallback block, never the raw payload", () => {
    const markup = renderToStaticMarkup(<ChannelTimeline items={items} />);
    expect(markup).toContain("[tool-trace]");
    expect(markup).toContain("Unsupported content");
    expect(markup).not.toContain("search");
    expect(markup).not.toContain('"q"');
  });

  test("shows the empty timeline state with no messages", () => {
    const markup = renderToStaticMarkup(<ChannelTimeline items={[]} />);
    expect(markup).toContain("No messages yet");
  });
});

describe("Composer", () => {
  test("disables send while the draft is empty", () => {
    const markup = renderToStaticMarkup(
      <Composer agents={[]} onSend={() => Promise.resolve(true)} />,
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
        onSend={() => Promise.resolve(true)}
      />,
    );
    expect(markup).not.toContain("@undefined");
  });
});

// `NewChannelDialog` itself renders through `@corbits/react-ui`'s Radix
// `Dialog.Portal`, which needs a real DOM container and produces no markup
// under `renderToStaticMarkup` — same reason `InviteAgentDialog` has never
// had a render test here. Its create-eligibility and payload-shaping logic
// is pulled out as pure functions instead (mirrors `nextMessagesState` and
// `draftAfterSend`) and tested directly.
describe("canSubmitNewChannel / newChannelPayload (the new-chat create flow)", () => {
  test("a channel needs a name", () => {
    expect(canSubmitNewChannel("channel", "", null)).toBe(false);
    expect(canSubmitNewChannel("channel", "  ", null)).toBe(false);
    expect(canSubmitNewChannel("channel", "Ops", null)).toBe(true);
  });

  test("a chat needs an agent picked, not a name", () => {
    expect(canSubmitNewChannel("chat", "", null)).toBe(false);
    expect(canSubmitNewChannel("chat", "", "wfd_echo")).toBe(true);
    expect(canSubmitNewChannel("chat", "My chat", null)).toBe(false);
  });

  test("a channel's payload never carries a definitionId", () => {
    expect(newChannelPayload("channel", "Ops", null)).toEqual({
      kind: "channel",
      name: "Ops",
    });
    expect(newChannelPayload("channel", "  ", null)).toBeNull();
  });

  test("a chat's payload includes the picked definitionId with no name when none was typed", () => {
    expect(newChannelPayload("chat", "", "wfd_echo")).toEqual({
      kind: "chat",
      definitionId: "wfd_echo",
    });
  });

  test("a chat's payload includes a typed name alongside the definitionId, never guessing one when blank", () => {
    expect(newChannelPayload("chat", "My research chat", "wfd_echo")).toEqual({
      kind: "chat",
      definitionId: "wfd_echo",
      name: "My research chat",
    });
  });

  test("a chat with no agent picked yields no payload at all", () => {
    expect(newChannelPayload("chat", "My research chat", null)).toBeNull();
  });
});

describe("no raw identifiers on screen", () => {
  test("across the whole workspace's fixture surface — channels, an agent participant, an unknown sender, and a join event", () => {
    const channels: Channel[] = [
      channel({ id: "c1", title: "General" }),
      channel({ id: "c2", title: "", kind: "chat" }),
    ];
    const participants = [
      { address: "ins_cd03d8e3@agents.example", handle: "echo" },
      { address: "prn_teammate1@agents.example", handle: "ada" },
    ];
    const messageItems: MessageItem[] = [
      {
        id: "m1",
        createdAt: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "text", text: "hello there" }],
        sender: { name: null, address: "ins_cd03d8e3@agents.example" },
      },
      {
        id: "m2",
        createdAt: "2026-01-01T00:01:00.000Z",
        parts: [{ kind: "text", text: "hi all" }],
        sender: { name: null, address: "prn_unknown1@agents.example" },
      },
      {
        id: "m3",
        createdAt: "2026-01-01T00:02:00.000Z",
        parts: [
          {
            kind: "event",
            event: "channel.agent-joined",
            data: {
              address: "ins_cd03d8e3@agents.example",
              definitionId: "wfd_echo",
              invitedBy: "prn_inviter1",
            },
          },
        ],
      },
    ];

    const markup = [
      renderToStaticMarkup(
        <ChatSidebar
          channels={channels}
          chats={[]}
          activeChannelId="c1"
          onSelect={() => undefined}
          onNewChannel={() => undefined}
        />,
      ),
      renderToStaticMarkup(
        <ChannelTimeline
          items={messageItems}
          participants={participants}
          currentUser={{ principalId: "prn_teammate1" }}
        />,
      ),
      renderToStaticMarkup(
        <Composer
          agents={[
            {
              id: "ins_cd03d8e3@agents.example",
              handle: "echo",
              label: "Echo",
            },
          ]}
          onSend={() => Promise.resolve(true)}
        />,
      ),
    ].join("\n");

    expect(markup).not.toMatch(RAW_ID_PATTERN);
    expect(markup).toContain("Untitled channel");
    expect(markup).toContain("@echo joined");
  });
});
