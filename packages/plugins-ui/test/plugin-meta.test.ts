import { expect, test } from "bun:test";
import { Stack } from "@corbits/icons";
import { connectorDescriptors } from "@corbits/connections/registry";
import {
  CONNECTOR_REGISTRY,
  MCP_PRESETS,
} from "@workbench/templates/connectors";

import {
  pluginCatalogCategory,
  pluginIcon,
  pluginOutcome,
} from "../src/plugin-meta";
import { isNativePluginCatalogDescriptor } from "../src/plugins-gallery";

test("manus is a work plugin whose outcome names tasks and slide-deck files", () => {
  expect(pluginCatalogCategory("manus")).toBe("work");
  expect(pluginOutcome("manus", "Manus")).toBe(
    "Lets agents run Manus tasks and retrieve files — including slide decks.",
  );
  expect(pluginIcon("manus")).toBe(Stack);
});

test("every catalog entry used by the gallery has an explicit category", () => {
  for (const preset of MCP_PRESETS) {
    expect(pluginCatalogCategory(preset.slug)).toBeDefined();
  }
  for (const descriptor of connectorDescriptors(CONNECTOR_REGISTRY).filter(
    isNativePluginCatalogDescriptor,
  )) {
    expect(pluginCatalogCategory(descriptor.id)).toBeDefined();
  }
});
