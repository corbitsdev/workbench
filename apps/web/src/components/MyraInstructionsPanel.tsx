import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  MYRA_INSTRUCTIONS_MAX_LENGTH,
  myraPreferencesKey,
  putMyraPreferences,
  useMyraPreferences,
  type MyraPreferences,
  type MyraPreferencesUpdate,
} from "../lib/myra-variants";

type InstructionsField =
  | "instructionsGlobal"
  | "instructionsChat"
  | "instructionsTriage";

interface FieldConfig {
  readonly field: InstructionsField;
  readonly label: string;
  readonly description: string;
}

const FIELDS: readonly FieldConfig[] = [
  {
    field: "instructionsGlobal",
    label: "Global instructions",
    description: "Standing guidance Myra follows everywhere.",
  },
  {
    field: "instructionsChat",
    label: "Chat instructions",
    description: "Applied on top of global guidance in chat threads.",
  },
  {
    field: "instructionsTriage",
    label: "Inbox automation instructions",
    description:
      "Applied on top of global guidance during unattended inbox automation.",
  },
];

interface MutationVars {
  readonly field: InstructionsField;
  readonly value: string | null;
}

interface MyraInstructionsPanelProps {
  readonly tenantId: string | null;
}

export function MyraInstructionsPanel({
  tenantId,
}: MyraInstructionsPanelProps) {
  const queryClient = useQueryClient();
  const preferencesQuery = useMyraPreferences(tenantId);
  // Undefined means "not yet touched this session" — the textarea shows the
  // persisted value; a string is the in-progress edit before save.
  const [edited, setEdited] = useState<
    Partial<Record<InstructionsField, string>>
  >({});
  const [failedField, setFailedField] = useState<InstructionsField | null>(
    null,
  );

  const mutation = useMutation<MyraPreferences, Error, MutationVars>({
    mutationFn: ({ field, value }) => {
      if (tenantId === null) throw new Error("tenantId is required");
      const body: MyraPreferencesUpdate = { [field]: value };
      return putMyraPreferences(tenantId, body);
    },
    onError: (_error, vars) => {
      setFailedField(vars.field);
    },
    onSuccess: (_data, vars) => {
      setFailedField((current) => (current === vars.field ? null : current));
      setEdited((prev) => {
        const next = { ...prev };
        delete next[vars.field];
        return next;
      });
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
          Select a workbench to manage Myra's standing instructions.
        </p>
      </div>
    );
  }

  if (preferencesQuery.isPending) {
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

  if (preferencesQuery.isError) {
    return (
      <div className="rounded-xl border border-border bg-surface p-5">
        <p className="text-sm text-text-2">
          Couldn't load your standing instructions. Refresh to try again.
        </p>
      </div>
    );
  }

  const preferences = preferencesQuery.data;

  const handleSave = (field: InstructionsField) => {
    const raw = edited[field] ?? preferences[field] ?? "";
    const trimmed = raw.trim();
    const value = trimmed === "" ? null : trimmed;
    mutation.mutateAsync({ field, value }).catch(() => {
      // Surfaced inline via mutation.isError; failedField set in onError.
    });
  };

  return (
    <div className="flex flex-col gap-6">
      {FIELDS.map(({ field, label, description }) => {
        const value = edited[field] ?? preferences[field] ?? "";
        const dirty =
          edited[field] !== undefined &&
          edited[field] !== (preferences[field] ?? "");
        const errored = failedField === field;
        const saving =
          mutation.isPending && mutation.variables?.field === field;
        return (
          <section
            key={field}
            className="rounded-xl border border-border bg-surface p-5"
          >
            <div className="mb-3">
              <h3 className="text-base font-semibold text-text">{label}</h3>
              <p className="mt-0.5 text-sm text-text-3">{description}</p>
            </div>
            <textarea
              aria-label={label}
              value={value}
              maxLength={MYRA_INSTRUCTIONS_MAX_LENGTH}
              rows={4}
              onChange={(event) =>
                setEdited((prev) => ({ ...prev, [field]: event.target.value }))
              }
              className="w-full rounded-[10px] border border-border bg-page p-3 text-sm text-text focus:outline-none focus:ring-1 focus:ring-orange"
            />
            <div className="mt-3 flex items-center gap-3">
              <button
                type="button"
                data-field={field}
                disabled={!dirty || saving}
                onClick={() => handleSave(field)}
                className="rounded-lg bg-orange px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-orange-deep disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save"}
              </button>
              {errored && (
                <span className="text-sm text-red">
                  Couldn't save. Try again.
                </span>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
