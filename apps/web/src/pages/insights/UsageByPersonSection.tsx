import type { UsageByPersonRow } from "../../lib/hub-api";
import { SectionLabel } from "./section-label";
import { SortablePersonTable } from "./SortablePersonTable";
import { CaveatNote } from "./stats";

export function UsageByPersonSection({
  people,
  tokenCaveat,
}: {
  people: UsageByPersonRow[];
  tokenCaveat: string | null;
}) {
  return (
    <div className="flex flex-col gap-3">
      <SectionLabel>Usage by person</SectionLabel>
      {tokenCaveat !== null && <CaveatNote>{tokenCaveat}</CaveatNote>}
      <SortablePersonTable people={people} />
      <p className="text-[11px] text-text-3">Excludes shared agents</p>
    </div>
  );
}
