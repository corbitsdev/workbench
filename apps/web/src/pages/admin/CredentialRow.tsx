import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, inputFieldClass } from "@workbench/ui";
import { clearOwnerCredential, setOwnerCredential } from "../../lib/hub-api";
import type { OwnerCredentialState } from "@workbench/shared";

/**
 * One provider credential row shared by Catalog (inference providers) and
 * Capabilities (tool providers): configured/missing badge, a write-only
 * "Set/Replace key" input, and Clear. The secret the owner types is sent on
 * save and never held in the row's own state afterward — nothing here
 * re-renders a stored secret.
 */
export function CredentialRow({
  credential,
}: {
  credential: OwnerCredentialState;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();

  const setMutation = useMutation({
    mutationFn: (value: string) =>
      setOwnerCredential(credential.providerName, value),
    onSuccess: () => {
      setSecret("");
      setEditing(false);
      void queryClient.invalidateQueries({
        queryKey: ["owner", "credentials"],
      });
    },
    onError: () => setError("Could not save the key. Try again in a moment."),
  });

  const clearMutation = useMutation({
    mutationFn: () => clearOwnerCredential(credential.providerName),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["owner", "credentials"] }),
    onError: () => setError("Could not clear the key. Try again in a moment."),
  });

  return (
    <li className="p-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-text">{credential.label}</p>
          <p className="mt-0.5 font-mono text-xs text-text-3">
            {credential.providerName}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={`rounded-md border px-2 py-0.5 text-xs ${
              credential.configured
                ? "border-border text-text-2"
                : "border-border text-text-3"
            }`}
          >
            {credential.configured ? "Configured" : "Not configured"}
          </span>
          {!editing && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setError(null);
                setEditing(true);
              }}
            >
              {credential.configured ? "Replace key" : "Set key"}
            </Button>
          )}
          {credential.configured && !editing && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={clearMutation.isPending}
              onClick={() => {
                setError(null);
                clearMutation.mutateAsync().catch(() => {
                  /* onError already surfaces this to the user */
                });
              }}
            >
              {clearMutation.isPending ? "Clearing…" : "Clear"}
            </Button>
          )}
        </div>
      </div>

      {editing && (
        <form
          className="mt-3 flex flex-wrap items-end gap-2 border-t border-border pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (secret.trim().length === 0 || setMutation.isPending) return;
            setError(null);
            setMutation.mutateAsync(secret.trim()).catch(() => {
              /* onError already surfaces this to the user */
            });
          }}
        >
          <div className="min-w-[240px] flex-1 space-y-1">
            <label className="block text-[12px] text-text-3" htmlFor={fieldId}>
              API key
            </label>
            <input
              id={fieldId}
              type="password"
              autoComplete="off"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="Paste the new key"
              className={inputFieldClass}
            />
          </div>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={secret.trim().length === 0 || setMutation.isPending}
          >
            {setMutation.isPending ? "Saving…" : "Save"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setEditing(false);
              setSecret("");
              setError(null);
            }}
          >
            Cancel
          </Button>
        </form>
      )}

      {error && (
        <p className="mt-2 text-xs text-red-500" role="status">
          {error}
        </p>
      )}
    </li>
  );
}
