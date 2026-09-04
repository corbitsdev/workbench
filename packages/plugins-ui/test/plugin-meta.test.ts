import { expect, test } from "bun:test";
import { Stack } from "@corbits/icons";
import { connectorDescriptors } from "@corbits/connections/registry";
import {
  CONNECTOR_REGISTRY,
  MCP_PRESETS,
} from "@workbench/templates/connectors";

import { pluginCategory, pluginIcon, pluginOutcome } from "../src/plugin-meta";
import { isNativePluginCatalogDescriptor } from "../src/plugins-gallery";

test("manus is a productivity plugin whose outcome names tasks and slide-deck files", () => {
  expect(pluginCategory("manus")).toBe("Productivity");
  expect(pluginOutcome("manus", "Manus")).toBe(
    "Lets agents run Manus tasks and retrieve files — including slide decks.",
  );
  expect(pluginIcon("manus")).toBe(Stack);
});

test("every catalog entry used by the gallery has an explicit category", () => {
  for (const preset of MCP_PRESETS) {
    expect(pluginCategory(preset.slug)).toBeDefined();
  }
  for (const descriptor of connectorDescriptors(CONNECTOR_REGISTRY).filter(
    isNativePluginCatalogDescriptor,
  )) {
    expect(pluginCategory(descriptor.id)).toBeDefined();
  }
});

test("categories preserve connector ID assignments and cover added presets", () => {
  expect(pluginCategory("slack")).toBe("Communication");
  expect(pluginCategory("zoom")).toBe("Communication");
  expect(pluginCategory("google")).toBe("Productivity");
  expect(pluginCategory("canva")).toBe("Productivity");
  expect(pluginCategory("attio")).toBe("Sales & customer");
  expect(pluginCategory("hubspot")).toBe("Sales & customer");
  expect(pluginCategory("github-mcp")).toBe("Engineering");
  expect(pluginCategory("github")).toBe("Engineering");
  expect(pluginCategory("exa")).toBe("Research & data");
  expect(pluginCategory("unknown-plugin")).toBeUndefined();
});
