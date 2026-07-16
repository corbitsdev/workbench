import type {
  InferenceOptions,
  ReactorCapabilities,
  ReactorDirector,
  ReactorInboundEvent,
  ReactorState,
} from "@intx/types/runtime";
import {
  mergeInferenceOptions,
  resolveInferenceOptionsFromDials,
  type ResolvedInferenceDials,
} from "./inference-params";

export function wrapCapabilitiesWithInferenceParams(
  capabilities: ReactorCapabilities,
  dials: ResolvedInferenceDials | undefined,
): ReactorCapabilities {
  if (dials === undefined) return capabilities;
  const patch = resolveInferenceOptionsFromDials(dials);
  if (Object.keys(patch).length === 0) return capabilities;

  return {
    ...capabilities,
    infer: (options?: InferenceOptions) =>
      capabilities.infer(mergeInferenceOptions(options, patch)),
  };
}

export function wrapDirectorWithInferenceParams(
  director: ReactorDirector,
  dials: ResolvedInferenceDials | undefined,
): ReactorDirector {
  if (dials === undefined) return director;
  return {
    async decide(
      event: ReactorInboundEvent,
      state: ReactorState,
      capabilities: ReactorCapabilities,
    ) {
      const caps = wrapCapabilitiesWithInferenceParams(capabilities, dials);
      return director.decide(event, state, caps);
    },
  };
}
