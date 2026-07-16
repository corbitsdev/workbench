import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge, cn } from "@workbench/ui";
import {
  myraPreferencesKey,
  putMyraPreferences,
  selectedVariantId,
  useMyraPreferences,
  useMyraVariants,
  type MyraPreferences,
  type MyraPreferencesUpdate,
  type MyraVariant,
} from "../lib/myra-variants";

type Surface = "chat" | "triage";

interface GroupConfig {
  readonly key: Surface;
  readonly kind: MyraVariant["kind"];
  readonly title: string;
  readonly description: string;
}

const GROUPS: readonly GroupConfig[] = [
  {
    key: "chat",
    kind: "chat",
    title: "Myra chat",
    description: "Which Myra answers when you start a new chat thread.",
  },
  {
    key: "triage",
    kind: "triage",
    title: "Inbox automation",
    description: "Which Myra runs your unattended inbox-triage automations.",
  },
];

const APPLIES_NOTE =
  "Your choice applies to new threads and future automation runs. Existing threads keep the Myra they were created with.";

function costNote(variant: MyraVariant): string | null {
  if (variant.costTier === "premium") {
    return "Highest quality, highest cost — best for hard reasoning, not everyday chat.";
  }
  return null;
}

interface MutationVars {
  readonly key: Surface;
  readonly value: string | null;
}

interface VariantRowProps {
  readonly variant: MyraVariant;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onSelect: () => void;
}

function VariantRow({
  variant,
  selected,
  disabled,
  onSelect,
}: VariantRowProps) {
  const note = costNote(variant);
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex w-full flex-col gap-1 rounded-xl border p-4 text-left transition-colors",
        selected
          ? "border-orange bg-orange/5"
          : "border-border bg-page hover:bg-surface",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-text">
          {variant.displayName}
        </span>
        <span className="font-mono text-xs text-text-3">{variant.model}</span>
        {variant.isDefault && <Badge tone="neutral">Default</Badge>}
        {selected && <Badge tone="positive">Selected</Badge>}
      </div>
      <p className="text-xs text-text-3">{variant.description}</p>
      {note !== null && <p className="text-xs text-orange-deep">{note}</p>}
    </button>
  );
}

interface MyraDefaultsPanelProps {
  readonly tenantId: string | null;
}

export function MyraDefaultsPanel({ tenantId }: MyraDefaultsPanelProps) {
  const queryClient = useQueryClient();
  const variantsQuery = useMyraVariants(tenantId);
  const preferencesQuery = useMyraPreferences(tenantId);

  const mutation = useMutation<
    MyraPreferences,
    Error,
    MutationVars,
    { previous: MyraPreferences | undefined }
  >({
    mutationFn: ({ key, value }) => {
      if (tenantId === null) throw new Error("tenantId is required");
      const body: MyraPreferencesUpdate =
        key === "chat" ? { chat: value } : { triage: value };
      return putMyraPreferences(tenantId, body);
    },
    onMutate: async ({ key, value }) => {
      await queryClient.cancelQueries({
        queryKey: myraPreferencesKey(tenantId),
      });
      const previous = queryClient.getQueryData<MyraPreferences>(
        myraPreferencesKey(tenantId),
      );
      if (previous !== undefined) {
        queryClient.setQueryData<MyraPreferences>(
          myraPreferencesKey(tenantId),
          { ...previous, [key]: value },
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
          Select a workbench to manage your Myra defaults.
        </p>
      </div>
    );
  }

  if (variantsQuery.isPending || preferencesQuery.isPending) {
    return (
      <div className="flex flex-col gap-6">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="h-40 animate-pulse rounded-xl border border-border bg-surface"
          />
        ))}
      </div>
    );
  }

  if (variantsQuery.isError || preferencesQuery.isError) {
    return (
      <div className="rounded-xl border border-border bg-surface p-5">
        <p className="text-sm text-text-2">
          We couldn't load your Myra settings. Please refresh to try again.
        </p>
      </div>
    );
  }

  const variants = variantsQuery.data;
  const preferences = preferencesQuery.data;

  const handleSelect = (key: Surface, variant: MyraVariant) => {
    // A pinned id is stored only for a non-default pick; picking the default
    // clears the preference back to null so it keeps tracking the canonical
    // default even if that later changes.
    const value = variant.isDefault ? null : variant.id;
    mutation.mutateAsync({ key, value }).catch(() => {
      // Surfaced inline via mutation.isError; onError already reverted.
    });
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
        const pending =
          mutation.isPending && mutation.variables?.key === group.key;
        const errored =
          mutation.isError && mutation.variables?.key === group.key;
        return (
          <section
            key={group.key}
            aria-labelledby={`myra-group-${group.key}`}
            className="rounded-xl border border-border bg-surface p-5"
          >
            <div className="mb-3">
              <h3
                id={`myra-group-${group.key}`}
                className="text-base font-semibold text-text"
              >
                {group.title}
              </h3>
              <p className="mt-0.5 text-sm text-text-3">{group.description}</p>
            </div>
            {groupVariants.length === 0 ? (
              <p className="text-sm text-text-3">
                No Myra options are available here yet.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {groupVariants.map((variant) => (
                  <VariantRow
                    key={variant.id}
                    variant={variant}
                    selected={variant.id === selectedId}
                    disabled={pending}
                    onSelect={() => handleSelect(group.key, variant)}
                  />
                ))}
              </div>
            )}
            {errored && (
              <p className="mt-3 text-sm text-red">
                Couldn't save your choice. We kept your previous selection —
                please try again.
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}
