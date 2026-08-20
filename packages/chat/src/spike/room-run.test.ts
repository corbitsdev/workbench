import { describe, expect, test } from "bun:test";

import { assetNameForRoom } from "./room-run";

describe("assetNameForRoom", () => {
  test("turns a room id into a name the asset service accepts", () => {
    expect(assetNameForRoom("run_5FD83CBF2F62")).toBe("spike-room-run-5fd83cbf2f62");
  });

  test("emits lowercase-kebab for every generated room id", () => {
    expect(assetNameForRoom("run_a1b2c3")).toMatch(
      /^[a-z0-9]+(-[a-z0-9]+)*$/,
    );
  });
});
