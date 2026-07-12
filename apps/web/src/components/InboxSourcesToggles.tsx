import { useInboxSources, useUpdateInboxSource } from "../hooks/use-preference-settings";
import { SourceTogglesList } from "./SourceTogglesList";

/**
 * Renders a toggle per inbox source the caller's tenant has a configured
 * credential for. Driven entirely by `GET /me/inbox-sources` — independent
 * of `BriefSourcesToggles`: toggling a source here never changes whether it
 * feeds the daily brief, and vice versa. Sources without a configured
 * credential never render.
 */
export function InboxSourcesToggles() {
  const query = useInboxSources();
  const update = useUpdateInboxSource();

  if (query.isPending || query.isError) {
    return null;
  }

  return (
    <SourceTogglesList
      heading="In your inbox"
      controlIdPrefix="inbox-source"
      sources={query.data}
      onToggle={(key, enabled) => update.mutate({ key, enabled })}
    />
  );
}
