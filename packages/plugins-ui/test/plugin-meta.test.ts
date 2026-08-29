import { expect, test } from "bun:test";
import { Stack } from "@corbits/icons";

import { pluginCategory, pluginIcon, pluginOutcome } from "../src/plugin-meta";

test("manus is a Productivity plugin whose outcome names tasks and slide-deck files", () => {
  expect(pluginCategory("manus")).toBe("Productivity");
  expect(pluginOutcome("manus", "Manus")).toBe(
    "Lets agents run Manus tasks and retrieve files — including slide decks.",
  );
  expect(pluginIcon("manus")).toBe(Stack);
});
