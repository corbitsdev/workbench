import type { ToolDefinition } from "@intx/types/runtime";

export type SumbleFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export type SumbleToolsConfig = {
  apiKey: string;
  baseUrl?: string;
  fetcher?: SumbleFetch;
};

export type SideEffect = "read" | "write";

export type SumbleToolSpec = {
  definition: ToolDefinition;
  kind: "string" | "structured";
  sideEffect: SideEffect;
  run: (
    config: SumbleToolsConfig,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<string | Record<string, unknown>>;
};
