import { useMutation, useQueryClient } from "@tanstack/react-query";
import { cn } from "@workbench/ui";
import {
  inferenceCapabilitiesForModel,
  myraPreferencesKey,
  putMyraPreferences,
  selectedVariantId,
  useMyraInferenceCapabilities,
  useMyraPreferences,
  useMyraVariants,
  type ModelInferenceCapabilities,
  type MyraPreferences,
  type MyraPreferencesUpdate,
  type MyraVariant,
} from "../lib/myra-variants";

type Surface = "chat" | "triage";

type DialField =
  | "creativeChat"
  | "thinkingChat"
  | "creativeTriage"
  | "thinkingTriage";

const GROUPS: readonly {
  key: Surface;
  kind: MyraVariant["kind"];
  title: string;
  creativeField: DialField;
  thinkingField: DialField;
}[] = [
  {
    key: "chat",
    kind: "chat",
    title: "Myra chat",
    creativeField: "creativeChat",
    thinkingField: "thinkingChat",
  },
  {
    key: "triage",
    kind: "triage",
    title: "Inbox automation",
    creativeField: "creativeTriage",
    thinkingField: "thinkingTriage",
  },
];

const APPLIES_NOTE =
  "Inference dials apply on the next Myra launch for that surface — new threads and future inbox runs.";

function dialLabel(kind: ModelInferenceCapabilities["creative"]): string {
  switch (kind) {
    case "reasoning_effort":
      return "Reasoning depth";
    case "temperature":
      return "Creative";
    case "thinking_toggle":
      return "Thinking";
    case "thinking_effort":
      return "Thinking depth";
    default:
      return "";
  }
}

interface DialSliderProps {
  readonly label: string;
  readonly value: number | null;
  readonly disabled?: boolean;
  readonly onChange: (value: number | null) => void;
}

function DialSlider({ label, value, disabled, onChange }: DialSliderProps) {
  const display = value ?? 50;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-text">{label}</span>
        <button
          type="button"
          className="text-xs text-text-3 underline-offset-2 hover:underline"
          disabled={disabled}
          onClick={() => onChange(null)}
        >
          {value === null ? "Model default" : "Reset to default"}
        </button>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        disabled={disabled}
        value={display}
        onChange={(e) => onChange(Number(e.target.value))}
        className={cn("w-full", disabled && "opacity-50")}
      />
      <span className="font-mono text-xs text-text-3">
        {value === null ? "default" : value}
      </span>
    </div>
  );
}

interface MyraInferenceDialsPanelProps {
  readonly tenantId: string | null;
}

export function MyraInferenceDialsPanel({
  tenantId,
}: MyraInferenceDialsPanelProps) {
  const queryClient = useQueryClient();
  const variantsQuery = useMyraVariants(tenantId);
  const preferencesQuery = useMyraPreferences(tenantId);
  const capabilitiesQuery = useMyraInferenceCapabilities(tenantId);

  const mutation = useMutation<
    MyraPreferences,
    Error,
    MyraPreferencesUpdate,
    { previous: MyraPreferences | undefined }
  >({
    mutationFn: (body) => {
      if (tenantId === null) throw new Error("tenantId is required");
      return putMyraPreferences(tenantId, body);
    },
    onMutate: async (body) => {
      await queryClient.cancelQueries({
        queryKey: myraPreferencesKey(tenantId),
      });
      const previous = queryClient.getQueryData<MyraPreferences>(
        myraPreferencesKey(tenantId),
      );
      if (previous !== undefined) {
        queryClient.setQueryData<MyraPreferences>(
          myraPreferencesKey(tenantId),
          {
            ...previous,
            ...body,
          },
        );
      }
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData<MyraPreferences>(
          myraPreferencesKey(tenantId),
          context.previous,
        );
      }
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
          Select a workbench to tune inference dials.
        </p>
      </div>
    );
  }

  if (
    variantsQuery.isPending ||
    preferencesQuery.isPending ||
    capabilitiesQuery.isPending
  ) {
    return (
      <div className="h-40 animate-pulse rounded-xl border border-border bg-surface" />
    );
  }

  if (
    variantsQuery.isError ||
    preferencesQuery.isError ||
    capabilitiesQuery.isError
  ) {
    return (
      <div className="rounded-xl border border-border bg-surface p-5">
        <p className="text-sm text-text-2">
          Couldn&apos;t load inference settings. Refresh to try again.
        </p>
      </div>
    );
  }

  const variants = variantsQuery.data;
  const preferences = preferencesQuery.data;
  const capabilities = capabilitiesQuery.data;

  const patchDial = (field: DialField, value: number | null) => {
    mutation.mutate({ [field]: value } as MyraPreferencesUpdate);
  };

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-text-3">{APPLIES_NOTE}</p>
      {GROUPS.map((group) => {
        const groupVariants = variants.filter((v) => v.kind === group.kind);
        const selectedId = selectedVariantId(
          groupVariants,
          preferences[group.key],
        );
        const variant = groupVariants.find((v) => v.id === selectedId);
        const caps =
          variant === undefined
            ? undefined
            : inferenceCapabilitiesForModel(variant.model, capabilities);
        const showCreative = caps !== undefined && caps.creative !== "hidden";
        const showThinking = caps !== undefined && caps.thinking !== "hidden";
        const creativeLabel =
          caps === undefined ? "" : dialLabel(caps.creative);
        const thinkingLabel =
          caps === undefined ? "" : dialLabel(caps.thinking);

        return (
          <section
            key={group.key}
            className="rounded-xl border border-border bg-surface p-5"
          >
            <h3 className="text-base font-semibold text-text">{group.title}</h3>
            {variant === undefined ? (
              <p className="mt-2 text-sm text-text-3">No variant selected.</p>
            ) : caps === undefined ? (
              <p className="mt-2 text-sm text-text-3">
                {variant.displayName} ({variant.model}) has no tunable inference
                dials in this workbench yet.
              </p>
            ) : (
              <div className="mt-4 flex flex-col gap-4">
                <p className="text-xs text-text-3">
                  Controls for {variant.displayName}{" "}
                  <span className="font-mono">{variant.model}</span>
                  {caps.temperatureThinkingExclusive
                    ? " — temperature and thinking cannot be combined for this model."
                    : null}
                </p>
                {showCreative && (
                  <DialSlider
                    label={creativeLabel}
                    value={preferences[group.creativeField]}
                    onChange={(v) => patchDial(group.creativeField, v)}
                  />
                )}
                {showThinking && (
                  <DialSlider
                    label={thinkingLabel}
                    value={preferences[group.thinkingField]}
                    onChange={(v) => patchDial(group.thinkingField, v)}
                  />
                )}
              </div>
            )}
            {mutation.isError && (
              <p className="mt-3 text-sm text-red">
                Couldn&apos;t save. Try again.
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}
