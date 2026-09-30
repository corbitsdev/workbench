import { ModelProviderPlugin } from "@intx/types";

import { PROVIDER_OPTIONS } from "../onboarding/provider-connect-step";
import type { Provider } from "./credentials-api";

/** Model providers only: MCP servers and hub-internal credentials hang off
 * providers with other plugins and are managed elsewhere. */
export function inferenceProviders(providers: readonly Provider[]): readonly Provider[] {
  return providers.filter((provider) => ModelProviderPlugin.allows(provider.plugin));
}

/** The picker's label when the row was created from it, else the row's own name. */
export function providerLabel(provider: Provider | undefined): string {
  if (provider === undefined) return "Provider";
  const name = provider.name.toLowerCase();
  const option = PROVIDER_OPTIONS.find((candidate) => candidate.label.toLowerCase() === name);
  return option?.label ?? provider.name;
}
