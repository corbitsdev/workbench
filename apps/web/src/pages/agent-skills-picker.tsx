// The skills a hand-authored agent carries: a checkbox list over this
// browser's skills registry (`../skills-session.ts`, CL-5990 — there is
// no hub skill registry yet). Shared between the create-agent dialog and
// the detail panel's inline editor so both attach against the same list
// and the same "no skills yet" empty state.

import { useSessionSkills } from "../skills-session";

export function AgentSkillsPicker({
  selected,
  onChange,
  idPrefix,
  disabled = false,
}: {
  readonly selected: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
  readonly idPrefix: string;
  readonly disabled?: boolean;
}) {
  const skills = useSessionSkills();

  function toggle(name: string) {
    onChange(
      selected.includes(name)
        ? selected.filter((existing) => existing !== name)
        : [...selected, name],
    );
  }

  if (skills.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No skills yet — create one from Settings → Skills, then attach it here.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {skills.map((skill) => {
        const id = `${idPrefix}-skill-${skill.id}`;
        return (
          <label
            key={skill.id}
            htmlFor={id}
            className="flex items-start gap-2 text-sm"
          >
            <input
              id={id}
              type="checkbox"
              className="mt-0.5 size-4 rounded-sm border border-input accent-[var(--primary)]"
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
