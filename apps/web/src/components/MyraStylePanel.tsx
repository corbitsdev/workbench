import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge, cn } from "@workbench/ui";
import {
  myraPreferencesKey,
  putMyraPreferences,
  useMyraPreferences,
  useMyraStyleAxes,
  type MyraPreferences,
  type MyraPreferencesUpdate,
  type StyleAxis,
  type StyleAxisOption,
} from "../lib/myra-variants";

/**
 * A style-axis preference field is either a global column (personality,
 * emojiUse, uiType) or one of a per-surface pair (…Chat / …Triage) for the
 * three usage dials. This maps each catalog axis id to the preference
 * field(s) it reads and writes.
 */
type FieldKey = keyof Omit<
  MyraPreferences,
  | "chat"
  | "triage"
  | "pinnedSkillIds"
  | "toolCatalog"
  | "disabledCatalogPackages"
  | "disabledToolNames"
>;

function fieldsForAxis(
  axisId: StyleAxis["id"],
): { global: FieldKey } | { chat: FieldKey; triage: FieldKey } {
  switch (axisId) {
    case "personality":
      return { global: "personality" };
    case "emojiUse":
      return { global: "emojiUse" };
    case "uiType":
      return { global: "uiType" };
    case "artifactUsage":
      return { chat: "artifactUsageChat", triage: "artifactUsageTriage" };
    case "toolUsage":
      return { chat: "toolUsageChat", triage: "toolUsageTriage" };
    case "skillUsage":
      return { chat: "skillUsageChat", triage: "skillUsageTriage" };
  }
}

const APPLIES_NOTE =
  "Style choices apply the next time a Myra starts — new threads, future inbox routine runs, and existing threads after they next wake.";

interface MutationVars {
  readonly field: FieldKey;
  readonly value: string | null;
}

interface OptionRowProps {
  readonly option: StyleAxisOption;
  readonly isDefault: boolean;
  readonly selected: boolean;
  readonly onSelect: () => void;
}

function OptionRow({ option, isDefault, selected, onSelect }: OptionRowProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      className={cn(
        "flex w-full flex-col gap-1 rounded-[10px] border p-3 text-left transition-colors active:scale-[0.97]",
        selected
          ? "border-orange bg-orange/5"
          : "border-border bg-page hover:bg-surface",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-text">{option.label}</span>
        {isDefault && <Badge tone="neutral">Default</Badge>}
        {selected && <Badge tone="positive">Selected</Badge>}
      </div>
      <p className="text-xs text-text-3">{option.description}</p>
    </button>
  );
}

interface AxisRadioGroupProps {
  readonly axis: StyleAxis;
  readonly labelId: string;
  readonly selectedId: string;
  readonly onSelect: (optionId: string) => void;
}

function AxisRadioGroup({
  axis,
  labelId,
  selectedId,
  onSelect,
}: AxisRadioGroupProps) {
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelId}
      className="flex flex-col gap-2"
      onKeyDown={(event) => {
        let delta = 0;
        if (event.key === "ArrowDown" || event.key === "ArrowRight") {
          delta = 1;
        } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
          delta = -1;
        }
        if (delta === 0) return;
        event.preventDefault();
        const index = axis.options.findIndex((o) => o.id === selectedId);
        const next =
          axis.options[
            (index + delta + axis.options.length) % axis.options.length
          ];
        if (next !== undefined) onSelect(next.id);
      }}
    >
      {axis.options.map((option) => (
        <OptionRow
          key={option.id}
          option={option}
          isDefault={option.id === axis.defaultOptionId}
          selected={option.id === selectedId}
          onSelect={() => onSelect(option.id)}
        />
      ))}
    </div>
  );
}

interface MyraStylePanelProps {
  readonly tenantId: string | null;
}

export function MyraStylePanel({ tenantId }: MyraStylePanelProps) {
  const queryClient = useQueryClient();
  const axesQuery = useMyraStyleAxes(tenantId);
  const preferencesQuery = useMyraPreferences(tenantId);
  // The field whose last save failed. mutation.variables only reflects the
  // LATEST mutation, so a banner keyed off it mis-attributes an earlier
  // failure once another axis saves; this pins the error to the sub-group
  // that actually failed and clears when that field next saves.
  const [failedField, setFailedField] = useState<FieldKey | null>(null);

  const mutation = useMutation<
    MyraPreferences,
    Error,
    MutationVars,
    { previous: MyraPreferences | undefined }
  >({
    mutationFn: ({ field, value }) => {
      if (tenantId === null) throw new Error("tenantId is required");
      const body: MyraPreferencesUpdate = { [field]: value };
      return putMyraPreferences(tenantId, body);
    },
    onMutate: async ({ field, value }) => {
      await queryClient.cancelQueries({
        queryKey: myraPreferencesKey(tenantId),
      });
      const previous = queryClient.getQueryData<MyraPreferences>(
        myraPreferencesKey(tenantId),
      );
      if (previous !== undefined) {
        queryClient.setQueryData<MyraPreferences>(
          myraPreferencesKey(tenantId),
          { ...previous, [field]: value },
        );
      }
      return { previous };
    },
    onError: (_error, vars, context) => {
      setFailedField(vars.field);
      if (context?.previous !== undefined) {
        queryClient.setQueryData<MyraPreferences>(
          myraPreferencesKey(tenantId),
          context.previous,
        );
      }
    },
    onSuccess: (_data, vars) => {
      setFailedField((current) => (current === vars.field ? null : current));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: myraPreferencesKey(tenantId),
      });
    },
  });

  if (tenantId === null) {
    return (
      <div className="rounded-xl border border-border bg-surface p-5">
        <p className="text-sm text-text-2">
          Select a workbench to manage Myra's personalization.
        </p>
      </div>
    );
  }

  if (axesQuery.isPending || preferencesQuery.isPending) {
    return (
      <div className="flex flex-col gap-6">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-32 animate-pulse rounded-xl border border-border bg-surface"
          />
        ))}
      </div>
    );
  }

  if (axesQuery.isError || preferencesQuery.isError) {
    return (
      <div className="rounded-xl border border-border bg-surface p-5">
        <p className="text-sm text-text-2">
          Couldn't load your personalization settings. Refresh to try again.
        </p>
      </div>
    );
  }

  const axes = axesQuery.data;
  const preferences = preferencesQuery.data;

  const handleSelect = (axis: StyleAxis, field: FieldKey, optionId: string) => {
    const value = optionId === axis.defaultOptionId ? null : optionId;
    mutation.mutateAsync({ field, value }).catch(() => {
      // Surfaced inline via mutation.isError; onError already reverted.
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-text-3">{APPLIES_NOTE}</p>
      {axes.map((axis) => {
        const fields = fieldsForAxis(axis.id);
        const labelId = `myra-style-axis-${axis.id}`;
        const globalErrored =
          "global" in fields && failedField === fields.global;

        return (
          <section
            key={axis.id}
            aria-labelledby={labelId}
            className="rounded-xl border border-border bg-surface p-5"
          >
            <div className="mb-3">
              <h3 id={labelId} className="text-base font-semibold text-text">
                {axis.label}
              </h3>
              <p className="mt-0.5 text-sm text-text-3">{axis.description}</p>
            </div>
            {"global" in fields ? (
              <>
                <AxisRadioGroup
                  axis={axis}
                  labelId={labelId}
                  selectedId={
                    preferences[fields.global] ?? axis.defaultOptionId
                  }
                  onSelect={(optionId) =>
                    handleSelect(axis, fields.global, optionId)
                  }
                />
                {globalErrored && (
                  <p className="mt-3 text-sm text-red">
                    Couldn't save. Your previous selection is kept — try again.
                  </p>
                )}
              </>
            ) : (
              <div className="flex flex-col gap-5">
                {(
                  [
                    ["chat", "Chat", fields.chat],
                    ["triage", "Inbox routine", fields.triage],
                  ] as const
                ).map(([surface, surfaceLabel, field]) => {
                  const surfaceLabelId = `${labelId}-${surface}`;
                  const surfaceErrored = failedField === field;
                  return (
                    <div key={surface} className="flex flex-col gap-2">
                      <p
                        id={surfaceLabelId}
                        className="text-xs font-medium text-text-3"
                      >
                        {surfaceLabel}
                      </p>
                      <AxisRadioGroup
                        axis={axis}
                        labelId={surfaceLabelId}
                        selectedId={preferences[field] ?? axis.defaultOptionId}
                        onSelect={(optionId) =>
                          handleSelect(axis, field, optionId)
                        }
                      />
                      {surfaceErrored && (
                        <p className="text-sm text-red">
                          Couldn't save. Your previous selection is kept — try
                          again.
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
