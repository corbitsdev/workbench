import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, inputFieldClass } from "@workbench/ui";
import { clearOwnerCredential, setOwnerCredential } from "../../lib/hub-api";
import type { OwnerCredentialState } from "@workbench/shared";
import {
  CREDENTIAL_PROVIDER_CATALOG,
  findOAuthProviderByAppCredential,
} from "@workbench/shared";
import { OAuthAppSetupPanel } from "./OAuthAppSetupPanel";

/**
 * One provider credential row shared by Catalog (inference providers) and
 * Capabilities (tool providers): configured/missing badge, a write-only
 * "Set/Replace key" input, and Clear. The secret the owner types is sent on
 * save and never held in the row's own state afterward — nothing here
 * re-renders a stored secret.
 */
function formatUpdatedAt(isoString: string): string {
  return new Date(isoString).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function CredentialRow({
  credential,
}: {
  credential: OwnerCredentialState;
}) {
  const catalogEntry = CREDENTIAL_PROVIDER_CATALOG.find(
    (e) => e.providerName === credential.providerName,
  );
  const secondaryField = catalogEntry?.secondaryField;
  const oauthConfig = findOAuthProviderByAppCredential(credential.providerName);
  const secretLabel = catalogEntry?.secretLabel ?? "API key";
  const platforms = catalogEntry?.platforms;
  const [baseURL, setBaseURL] = useState(credential.baseURL ?? "");
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();

  const canSave =
    secret.trim().length > 0 &&
    (!secondaryField?.required || baseURL.trim().length > 0);

  const setMutation = useMutation({
    mutationFn: (value: { secret: string; baseURL?: string }) =>
      setOwnerCredential(credential.providerName, value.secret, value.baseURL),
    onSuccess: () => {
      setSecret("");
      setBaseURL("");
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
          {platforms && platforms.length > 0 && (
            <p className="mt-0.5 text-xs text-text-3">
              Powers {platforms.join(", ")}
            </p>
          )}
          {credential.configured && credential.updatedAt && (
            <p className="mt-0.5 text-xs text-text-3">
              Updated {formatUpdatedAt(credential.updatedAt)}
            </p>
          )}
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
                setSecret("");
                setBaseURL(credential.baseURL ?? "");
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

      {editing && oauthConfig && <OAuthAppSetupPanel config={oauthConfig} />}

      {editing && (
        <form
          className="mt-3 flex flex-wrap items-end gap-2 border-t border-border pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSave || setMutation.isPending) return;
            setError(null);
            const payload = {
              secret: secret.trim(),
              ...(secondaryField && baseURL.trim()
                ? { baseURL: baseURL.trim() }
                : {}),
            };
            setMutation.mutateAsync(payload).catch(() => {
              /* onError already surfaces this to the user */
            });
          }}
        >
          <div className="min-w-[240px] flex-1 space-y-1">
            <label className="block text-[12px] text-text-3" htmlFor={fieldId}>
              {secretLabel}
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
            {oauthConfig && (
              <p className="text-[11px] text-text-3">
                {oauthConfig.setup.fieldHints.clientSecret}
              </p>
            )}
          </div>

          {secondaryField && (
            <div className="min-w-[240px] flex-1 space-y-1">
              <label
                className="block text-[12px] text-text-3"
                htmlFor={`${fieldId}-base`}
              >
                {secondaryField.label}
              </label>
              <input
                id={`${fieldId}-base`}
                type="text"
                autoComplete="off"
                value={baseURL}
                onChange={(e) => setBaseURL(e.target.value)}
                placeholder={secondaryField.placeholder}
                className={inputFieldClass}
              />
              {oauthConfig && (
                <p className="text-[11px] text-text-3">
                  {oauthConfig.setup.fieldHints.clientId}
                </p>
              )}
            </div>
          )}

          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={!canSave || setMutation.isPending}
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
              setBaseURL(credential.baseURL ?? "");
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
