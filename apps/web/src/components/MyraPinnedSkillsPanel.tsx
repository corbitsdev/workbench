import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge, cn, LibrarySearchInput, skillTitle } from "@workbench/ui";
import { Pin, PinOff } from "lucide-react";
import { useMemo, useState } from "react";
import {
  useSkillLibrary,
  type SkillLibraryItem,
} from "../hooks/use-skills";
import {
  myraPreferencesKey,
  putMyraPreferences,
  useMyraPreferences,
  type MyraPreferences,
} from "../lib/myra-variants";

/** Must match {@link MAX_PINNED_MYRA_SKILLS} in @workbench/myra (hub enforces). */
const MAX_PINNED_SKILLS = 10;

const APPLIES_NOTE =
  "Pinned skills are indexed in the system prompt for new chat threads and inbox automation (name and short description only — not the full skill text). Existing threads keep the prompt they started with.";

interface MyraPinnedSkillsPanelProps {
  readonly tenantId: string | null;
}

function matchesQuery(skill: SkillLibraryItem, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    skill.name.toLowerCase().includes(needle) ||
    skillTitle(skill).toLowerCase().includes(needle) ||
    (skill.description ?? "").toLowerCase().includes(needle)
  );
}

export function MyraPinnedSkillsPanel({ tenantId }: MyraPinnedSkillsPanelProps) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const skillsQuery = useSkillLibrary(tenantId);
  const preferencesQuery = useMyraPreferences(tenantId);

  const mutation = useMutation<
    MyraPreferences,
    Error,
    string[],
    { previous: MyraPreferences | undefined }
  >({
    mutationFn: async (pinnedSkillIds) => {
      if (!tenantId) throw new Error("No tenant");
      return putMyraPreferences(tenantId, { pinnedSkillIds });
    },
    onMutate: async (pinnedSkillIds) => {
      if (!tenantId) return { previous: undefined };
      await queryClient.cancelQueries({ queryKey: myraPreferencesKey(tenantId) });
      const previous = queryClient.getQueryData<MyraPreferences>(
        myraPreferencesKey(tenantId),
      );
      if (previous) {
        queryClient.setQueryData<MyraPreferences>(myraPreferencesKey(tenantId), {
          ...previous,
          pinnedSkillIds,
        });
      }
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (tenantId && ctx?.previous) {
        queryClient.setQueryData(myraPreferencesKey(tenantId), ctx.previous);
      }
    },
    onSettled: () => {
      if (tenantId) {
        void queryClient.invalidateQueries({
          queryKey: myraPreferencesKey(tenantId),
        });
      }
    },
  });

  const pinnedSet = useMemo(() => {
    const ids = preferencesQuery.data?.pinnedSkillIds ?? [];
    return new Set(ids);
  }, [preferencesQuery.data?.pinnedSkillIds]);

  const pinnedOrder = preferencesQuery.data?.pinnedSkillIds ?? [];

  const filtered = useMemo(() => {
    const q = query.trim();
    const library = skillsQuery.data ?? [];
    const pinnedFirst = [
      ...pinnedOrder
        .map((id) => library.find((s) => s.id === id))
        .filter((s): s is SkillLibraryItem => s !== undefined),
      ...library.filter((s) => !pinnedSet.has(s.id)),
    ];
    return pinnedFirst.filter((s) => matchesQuery(s, q));
  }, [skillsQuery.data, query, pinnedOrder, pinnedSet]);

  const togglePin = (skillId: string) => {
    if (!tenantId || mutation.isPending) return;
    const current = preferencesQuery.data?.pinnedSkillIds ?? [];
    let next: string[];
    if (pinnedSet.has(skillId)) {
      next = current.filter((id) => id !== skillId);
    } else {
      if (current.length >= MAX_PINNED_SKILLS) return;
      next = [...current, skillId];
    }
    mutation.mutate(next);
  };

  if (!tenantId) {
    return (
      <p className="text-sm text-text-3">Select a workspace to pin skills.</p>
    );
  }

  if (skillsQuery.isLoading || preferencesQuery.isLoading) {
    return (
      <div className="h-40 animate-pulse rounded-xl border border-border bg-surface" />
    );
  }

  if (skillsQuery.isError || preferencesQuery.isError) {
    return (
      <p className="text-sm text-text-2">
        Couldn't load skills or preferences. Refresh to try again.
      </p>
    );
  }

  const atCap = pinnedOrder.length >= MAX_PINNED_SKILLS;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-3">{APPLIES_NOTE}</p>
      <p className="text-xs text-text-3">
        {pinnedOrder.length} / {MAX_PINNED_SKILLS} pinned
      </p>
      <LibrarySearchInput
        label="Search skills"
        placeholder="Search tenant library and your private skills"
        value={query}
        onChange={setQuery}
      />
      {mutation.isError && (
        <p className="text-sm text-red">Couldn't save pins — try again.</p>
      )}
      <ul className="flex flex-col gap-2">
        {filtered.map((skill) => {
          const pinned = pinnedSet.has(skill.id);
          const disabled = !pinned && atCap;
          return (
            <li key={skill.id}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => togglePin(skill.id)}
                className={cn(
                  "flex w-full items-start gap-3 rounded-[10px] border p-3 text-left transition-colors",
                  pinned
                    ? "border-orange bg-orange/5"
                    : "border-border bg-page hover:bg-surface",
                  disabled && "cursor-not-allowed opacity-50",
                )}
              >
                <span className="mt-0.5 text-text-3" aria-hidden>
                  {pinned ? <Pin className="size-4" /> : <PinOff className="size-4" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-text">
                      {skillTitle(skill)}
                    </span>
                    {skill.scope === "private" && (
                      <Badge tone="neutral">Private</Badge>
                    )}
                    {pinned && <Badge tone="positive">Pinned</Badge>}
                  </span>
                  {skill.description && (
                    <span className="mt-1 block text-xs text-text-3 line-clamp-2">
                      {skill.description}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {filtered.length === 0 && (
        <p className="text-sm text-text-3">No skills match your search.</p>
      )}
    </div>
  );
}