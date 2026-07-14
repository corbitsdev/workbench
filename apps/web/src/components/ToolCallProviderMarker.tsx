import type { ToolCall } from "@workbench/chat";
import { providerKeyForToolLogo } from "../lib/tool-providers";
import { ProviderLogo } from "./ProviderLogo";

type ToolCallRef = Pick<ToolCall, "name" | "arguments">;

/**
 * Brand mark for an external tool row in chat. Falls back to the generic glyph
 * when the brands API or provider map has no SVG for the resolved provider.
 */
export function ToolCallProviderMarker({ call }: { call: ToolCallRef }) {
  const providerKey = providerKeyForToolLogo(call.name, call.arguments);
  if (providerKey === null) return null;
  return (
    <span
      data-testid="tool-provider-logo"
      className="flex h-4 w-4 shrink-0 items-center justify-center"
    >
      <ProviderLogo providerName={providerKey} size={16} className="h-4 w-4" />
    </span>
  );
}