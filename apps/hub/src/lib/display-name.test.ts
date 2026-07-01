import { describe, expect, it, mock } from "bun:test";
import { updateDisplayName, type AuthUserUpdater } from "./display-name";

describe("updateDisplayName", () => {
  it("forwards the name and request headers to the auth updateUser API", async () => {
    const updateUser = mock(
      async (_args: { body: { name: string }; headers: Headers }) => ({}),
    );
    const auth = { api: { updateUser } } as unknown as AuthUserUpdater;
    const headers = new Headers({ cookie: "session=abc" });

    await updateDisplayName(auth, "Sawyer Cutler", headers);

    expect(updateUser).toHaveBeenCalledTimes(1);
    expect(updateUser.mock.calls[0]![0]).toEqual({
      body: { name: "Sawyer Cutler" },
      headers,
    });
  });
});
