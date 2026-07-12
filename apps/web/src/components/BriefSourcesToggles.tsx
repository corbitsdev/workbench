import { Toggle } from "@workbench/settings";
import { useBriefSources, useUpdateBriefSource } from "../hooks/use-preference-settings";

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

  if (query.isPending) {
    return null;
  }

  if (query.isError || query.data.length === 0) {
    return null;
  }

  return (
    <div className="mt-4 flex flex-col gap-1 border-t border-border pt-4">
      <h3 className="mb-1 text-sm font-semibold text-text">Brief sources</h3>
      {query.data.map((source) => {
        const controlId = `brief-source-${source.key}`;
        return (
          <div
            key={source.key}
            className="flex flex-col gap-1.5 border-b border-border py-3 last:border-b-0"
          >
            <div className="flex items-center justify-between gap-4">
              <label
                htmlFor={controlId}
                className="text-sm font-medium text-text"
              >
                {source.label}
              </label>
              <Toggle
                id={controlId}
                aria-label={source.label}
                checked={source.enabled}
                onCheckedChange={(checked) =>
                  update.mutate({ key: source.key, enabled: checked })
                }
              />
            </div>
            <p className="text-xs text-text-3">{source.description}</p>
          </div>
        );
      })}
    </div>
  );
}
