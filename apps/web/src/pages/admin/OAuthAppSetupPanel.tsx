import { useState } from "react";
import { Button } from "@workbench/ui";
import type { OAuthOwnerAppProviderConfig } from "@workbench/shared";
import { buildRootUrl } from "../../lib/api";

/**
 * Semi-guided owner setup for an OAuth-app credential row (CL-3356 follow-on).
 * Ordered as the owner's do-this sequence, not by content type: create the app
 * (steps + docs link) → register the redirect URL (copy) → confirm the
 * permissions → paste the Client ID + Client secret (rendered by the parent
 * CredentialRow immediately below). Everything here is read-only catalog data;
 * no secrets are handled in the panel. Styled to read as one flow with the
 * form below (shared top divider, matching text-3 labels — no card-in-card).
 */
export function OAuthAppSetupPanel({
  config,
}: {
  config: OAuthOwnerAppProviderConfig;
}) {
  // The callback is a HUB route, not the web app origin — build it from the hub
  // base so the owner registers the URL the provider will actually redirect to.
  const redirectUrl = buildRootUrl(config.setup.callbackPath);
  const [copied, setCopied] = useState(false);

  function copyRedirectUrl() {
    void navigator.clipboard
      ?.writeText(redirectUrl)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => setCopied(false));
  }

  return (
    <div className="mt-3 space-y-3 border-t border-border pt-3">
      {/* 1 — Create the app (the do-first action + where to do it). */}
      <div className="space-y-1">
        <p className="text-[12px] text-text-3">
          Set up {config.label} — where do I get these?
        </p>
        <ol className="list-decimal space-y-1 pl-4 text-xs text-text-2">
          {config.setup.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p className="text-xs font-medium text-text-2">
          Copy the Client secret while you are still on the provider — it is
          shown only once and cannot be retrieved later.
        </p>
        <a
          href={config.setup.registerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block text-xs font-medium text-accent underline"
        >
          Open {config.label} OAuth setup docs →
        </a>
      </div>

      {/* 2 — Register this redirect URL back in the provider (copyable). */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-[12px] text-text-3">Redirect URL</p>
          <p className="break-all font-mono text-xs text-text">{redirectUrl}</p>
          <p className="text-[11px] text-text-3">
            Register this exact URL as the app's redirect / callback URL.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Copy redirect URL"
          onClick={copyRedirectUrl}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {copied ? "Redirect URL copied to clipboard" : ""}
      </p>

      {/* 3 — Confirm the permissions the app will request (glossed, not raw). */}
      <div className="space-y-1">
        <p className="text-[12px] text-text-3">Permissions requested</p>
        <p className="text-xs text-text-2">
          The access {config.label} grants on each connected user's behalf:
        </p>
        <ul className="list-disc space-y-0.5 pl-4 text-xs text-text-2">
          {config.scopes.map((scope) => (
            <li key={scope} title={scope}>
              {config.scopeDescriptions[scope] ?? scope}
            </li>
          ))}
        </ul>
      </div>

      {/* 4 — Paste the Client ID + Client secret: rendered by CredentialRow
          directly below this panel, so the panel flows straight into it. */}
    </div>
  );
}
