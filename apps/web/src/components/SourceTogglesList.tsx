import { Toggle } from "@workbench/settings";

interface ToggleableSource {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly enabled: boolean;
}

interface SourceTogglesListProps {
  /** Section heading, e.g. "In your daily brief" or "In your inbox". */
  readonly heading: string;
  /** Prefix for each toggle's DOM id, kept unique across sibling groups
   * (e.g. `brief-source` vs `inbox-source`) so two groups on the same page
   * never collide. */
  readonly controlIdPrefix: string;
  readonly sources: readonly ToggleableSource[];
  readonly onToggle: (key: string, enabled: boolean) => void;
}

/**
 * Renders one toggle per source, shared by the brief-source and inbox-source
 * groups (see `BriefSourcesToggles` / `InboxSourcesToggles`) so the two
 * independent dimensions render identically without duplicating markup.
 */
export function SourceTogglesList({
  heading,
  controlIdPrefix,
  sources,
  onToggle,
}: SourceTogglesListProps) {
  if (sources.length === 0) {
    return null;
  }

  return (
    <div className="mt-4 flex flex-col gap-1 border-t border-border pt-4">
      <h3 className="mb-1 text-sm font-semibold text-text">{heading}</h3>
      {sources.map((source) => {
        const controlId = `${controlIdPrefix}-${source.key}`;
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
                onCheckedChange={(checked) => onToggle(source.key, checked)}
              />
            </div>
            <p className="text-xs text-text-3">{source.description}</p>
          </div>
        );
      })}
    </div>
  );
}
