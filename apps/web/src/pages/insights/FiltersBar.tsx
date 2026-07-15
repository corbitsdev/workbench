import { humanizeKey } from "./metrics";
import type { ActorFilter } from "./overview-derivations";
import { selectClass } from "./time-range";

export function FiltersBar({
  kinds,
  kindFilter,
  onKindFilter,
  actorFilter,
  onActorFilter,
  showKindFilter = true,
  showActorFilter = true,
}: {
  kinds: string[];
  kindFilter: string;
  onKindFilter: (value: string) => void;
  actorFilter: ActorFilter;
  onActorFilter: (value: ActorFilter) => void;
  /** Hide the kind selector where it has no effect on the surrounding view
   * (e.g. the People tab, which is not scoped by workflow kind). */
  showKindFilter?: boolean;
  /** Hide the actor selector where it has no effect on the surrounding view
   * (e.g. the Workflows tab, which is not scoped by actor). */
  showActorFilter?: boolean;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid="filters-bar"
    >
      {showKindFilter && (
        <label className="flex items-center gap-1.5 text-[11px] text-text-3">
          Kind
          <select
            data-testid="kind-filter"
            value={kindFilter}
            onChange={(e) => onKindFilter(e.target.value)}
            className={selectClass()}
          >
            <option value="all">All kinds</option>
            {kinds.map((kind) => (
              <option key={kind} value={kind}>
                {humanizeKey(kind)}
              </option>
            ))}
          </select>
        </label>
      )}
      {showActorFilter && (
        <label className="flex items-center gap-1.5 text-[11px] text-text-3">
          Actor
          <select
            data-testid="actor-filter"
            value={actorFilter}
            onChange={(e) => onActorFilter(e.target.value as ActorFilter)}
            className={selectClass()}
          >
            <option value="all">Everyone</option>
            <option value="me">Just me</option>
            <option value="others">Others</option>
          </select>
        </label>
      )}
    </div>
  );
}
