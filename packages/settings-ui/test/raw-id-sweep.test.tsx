// The UI floor's raw-id sweep: render every settings section's presentational
// view with a full, realistic fixture — a bench, a channel, and a user each
// carrying a uuid-like id — and assert none of those ids ever reach visible
// text. Attribute values (an `<option value>`, a `key`) are not the floor's
// concern the way visible text is, so the sweep strips markup down to text
// content before searching it, the same way a person reading the screen
// would never see a `value=` attribute either.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AccountSectionView } from "../src/account-section";
import { BenchSectionView } from "../src/bench-section";
import { ChannelEditorView, ChannelPicker } from "../src/chat-section";
import { contextWindowLabel } from "../src/context-window";

const CHANNEL_ID = "3c1b1a2e-8b4f-4c8d-9a3e-9c2f1e6a7b1d";
const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function visibleText(markup: string): string {
  return markup.replace(/<[^>]*>/g, " ");
}

describe("raw-id sweep", () => {
  test("BenchSectionView renders only the bench's name and slug, never a uuid", () => {
    const markup = renderToStaticMarkup(
      <BenchSectionView
        name="Launch team"
        slug="launch-team"
        dirty={false}
        saving={false}
        error={null}
        savedAt={null}
        onNameChange={() => undefined}
        onSave={() => undefined}
        onReset={() => undefined}
      />,
    );
    expect(UUID_PATTERN.test(visibleText(markup))).toBe(false);
  });

  test("ChannelPicker never renders a channel's raw id as visible text", () => {
    const markup = renderToStaticMarkup(
      <ChannelPicker
        channels={[
          {
            id: CHANNEL_ID,
            title: "General",
            kind: "channel",
            pinned: true,
            participants: [],
          },
        ]}
        selectedId={CHANNEL_ID}
        onSelect={() => undefined}
      />,
    );
    expect(visibleText(markup)).not.toContain(CHANNEL_ID);
    expect(UUID_PATTERN.test(visibleText(markup))).toBe(false);
  });

  test("ChannelEditorView renders only the channel's name, never a uuid", () => {
    const markup = renderToStaticMarkup(
      <ChannelEditorView
        name="General"
        pinned
        contextWindowInput="20"
        contextWindowLabel={contextWindowLabel(20)}
        dirty={false}
        saving={false}
        error={null}
        savedAt={null}
        onNameChange={() => undefined}
        onPinnedChange={() => undefined}
        onContextWindowChange={() => undefined}
        onSave={() => undefined}
        onReset={() => undefined}
      />,
    );
    expect(visibleText(markup)).not.toContain(CHANNEL_ID);
    expect(UUID_PATTERN.test(visibleText(markup))).toBe(false);
  });

  test("AccountSectionView renders only the user's name and email, never a uuid", () => {
    const markup = renderToStaticMarkup(
      <AccountSectionView
        name="Ada Lovelace"
        email="ada@example.com"
        emailVerified={true}
      />,
    );
    expect(UUID_PATTERN.test(visibleText(markup))).toBe(false);
  });
});
