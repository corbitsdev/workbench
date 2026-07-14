import { describe, expect, mock, test } from "bun:test";

const listAllPublicChannelsMock = mock(async () => [
  { id: "C1", name: "general", is_member: true },
  { id: "C2", name: "eng", is_member: false },
  { id: "C3", name: "random", is_member: false },
]);
const joinChannelMock = mock(
  async (_credential: unknown, channelId: string) => {
    if (channelId === "C3") throw new Error("boom");
  },
);

mock.module("./slack-api-client", () => ({
  listAllPublicChannels: listAllPublicChannelsMock,
  joinChannel: joinChannelMock,
}));

const { joinAllPublicChannels, joinNewlyCreatedChannel } = await import(
  "./slack-channel-autojoin"
);

const FAKE_CREDENTIAL = {
  botToken: "xoxb-x",
  baseUrl: "https://slack.example/api",
};

describe("joinAllPublicChannels", () => {
  test("joins every non-member public channel and tolerates a per-channel failure", async () => {
    const result = await joinAllPublicChannels(
      FAKE_CREDENTIAL,
      new AbortController().signal,
    );
    expect(result).toEqual({
      attempted: 3,
      joined: 1,
      alreadyMember: 1,
      failed: 1,
    });
    expect(joinChannelMock).toHaveBeenCalledTimes(2);
  });
});

describe("joinNewlyCreatedChannel", () => {
  test("joins the channel", async () => {
    joinChannelMock.mockClear();
    await joinNewlyCreatedChannel(
      FAKE_CREDENTIAL,
      "C-new",
      new AbortController().signal,
    );
    expect(joinChannelMock).toHaveBeenCalledTimes(1);
  });

  test("swallows a join failure rather than throwing", async () => {
    await expect(
      joinNewlyCreatedChannel(
        FAKE_CREDENTIAL,
        "C3",
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
  });
});
