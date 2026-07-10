import { humanizeKey } from "./metrics";
import type { ActorFilter } from "./overview-derivations";
import { selectClass } from "./time-range";

export function FiltersBar({
  kinds,
  kindFilter,
  onKindFilter,
  actorFilter,
  onActorFilter,
}: {
  kinds: string[];
  kindFilter: string;
  onKindFilter: (value: string) => void;
  actorFilter: ActorFilter;
  onActorFilter: (value: ActorFilter) => void;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid="filters-bar"
    >
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
    </div>
  );
}
