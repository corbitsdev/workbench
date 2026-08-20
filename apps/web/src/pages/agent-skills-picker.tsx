// The skills a hand-authored agent pins: a checkbox list over the
// workbench's real skill registry (`../skills-api.ts`). Shared between
// the create-agent dialog and the detail panel's inline editor so both
// attach against the same list.
//
// A registry that fails to load says so. It never renders as "no skills
// yet", because attaching nothing because the read failed and attaching
// nothing because there is nothing are very different outcomes.

import { useEffect, useState } from "react";

import { listSkills, type SkillSummary } from "../skills-api";

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly skills: readonly SkillSummary[] }
  | { readonly status: "error"; readonly message: string };

export function AgentSkillsPicker({
  tenantId,
  selected,
  onChange,
  idPrefix,
  disabled = false,
}: {
  readonly tenantId: string;
  readonly selected: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
  readonly idPrefix: string;
  readonly disabled?: boolean;
}) {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    listSkills(tenantId)
      .then((skills) => {
        if (!cancelled) setState({ status: "ready", skills });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  function toggle(name: string) {
    onChange(
      selected.includes(name)
        ? selected.filter((existing) => existing !== name)
        : [...selected, name],
    );
  }

  if (state.status === "loading") {
    return <p className="text-sm text-muted-foreground">Loading skills…</p>;
  }

  if (state.status === "error") {
    return (
      <p className="text-sm text-danger-foreground" role="alert">
        Could not load skills: {state.message}
      </p>
    );
  }

  const visibleNames = new Set(state.skills.map((skill) => skill.name));
  // A pin can outlive its skill's visibility — the author made it
  // private, it was renamed, or it was discarded — leaving a name in
  // `selected` with no matching registry entry. Render those as
  // removable rows rather than silently dropping them, so the picker
  // can always reach a saveable state.
  const staleNames = selected.filter((name) => !visibleNames.has(name));

  if (state.skills.length === 0 && staleNames.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No skills yet — create one from Settings → Skills, then attach it here.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {staleNames.map((name) => {
        const id = `${idPrefix}-skill-stale-${name}`;
        return (
          <div key={id} className="flex items-start gap-2 text-sm">
            <span className="flex flex-1 flex-col">
              <span className="font-medium">{name}</span>
              <span className="text-xs text-danger-foreground">
                No longer available — its author may have made it private,
                renamed it, or discarded it.
              </span>
            </span>
            <button
              type="button"
              className="text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
              disabled={disabled}
              onClick={() => toggle(name)}
            >
              Remove
            </button>
          </div>
        );
      })}
      {state.skills.map((skill) => {
        const id = `${idPrefix}-skill-${skill.name}`;
        return (
          <label
            key={skill.assetId}
            htmlFor={id}
            className="flex items-start gap-2 text-sm"
          >
            <input
              id={id}
              type="checkbox"
              className="mt-0.5 size-4 rounded-none border border-input accent-[var(--primary)]"
              checked={selected.includes(skill.name)}
              disabled={disabled}
              onChange={() => toggle(skill.name)}
            />
            <span className="flex flex-col">
              <span className="font-medium">{skill.name}</span>
              {skill.description !== "" && (
                <span className="text-xs text-muted-foreground">
                  {skill.description}
                </span>
              )}
            </span>
          </label>
        );
      })}
    </div>
  );
}
