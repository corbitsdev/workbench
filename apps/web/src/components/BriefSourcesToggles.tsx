import {
  useBriefSources,
  useUpdateBriefSource,
} from "../hooks/use-preference-settings";
import { SourceTogglesList } from "./SourceTogglesList";

/**
 * Renders a toggle per morning-brief source the caller's tenant has a
 * configured credential for. Driven entirely by `GET /me/brief-sources` —
 * a new `CREDENTIAL_PROVIDER_CATALOG` entry tagged `briefSource` appears here
 * automatically once its credential is configured, with zero changes to this
 * component. Sources without a configured credential never render.
 */
export function BriefSourcesToggles() {
  const query = useBriefSources();
  const update = useUpdateBriefSource();

  if (query.isPending || query.isError) {
    return null;
  }

  return (
    <SourceTogglesList
      heading="In your daily brief"
      controlIdPrefix="brief-source"
      sources={query.data}
      onToggle={(key, enabled) => update.mutate({ key, enabled })}
    />
  );
}
