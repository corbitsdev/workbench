// The shared "shown once" webhook-secret reveal: a copyable hook URL, a
// copyable signing secret, and an optional sample payload. Every webhook
// UI in the app renders this after a create or a rotate — the hub returns
// a trigger's secret exactly once (see
// `packages/webhook-triggers/src/management-routes.ts`), so this is the
// only place that value is ever on screen. First built inline in the
// Routines page's webhook panel; lifted here so the Connections surface's
// Granola webhook card (CL-6028) renders the identical panel instead of a
// second hand-rolled copy.

import { Button } from "@corbits/react-ui";
import { Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/** Copies `value` to the clipboard, showing "Copied" for 1.5s. */
export function CopyButton({
  value,
  label,
}: {
  readonly value: string;
  readonly label: string;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    };
  }, []);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      title={label}
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          if (resetTimer.current !== null) clearTimeout(resetTimer.current);
          resetTimer.current = setTimeout(() => {
            resetTimer.current = null;
            setCopied(false);
          }, 1500);
        });
      }}
    >
      <Copy /> {copied ? "Copied" : "Copy"}
    </Button>
  );
}

/**
 * The generated hook URL, a freshly-issued secret, and (optionally) a
 * sample payload — shown right after create or rotate. The secret shown
 * here is never fetched back later: the hub returns it exactly once, so
 * this panel only ever renders from a value the caller just received.
 */
export function WebhookSecretPanel({
  url,
  secret,
  samplePayload,
}: {
  readonly url: string;
  readonly secret: string;
  readonly samplePayload?: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-[var(--ui-fg-muted)]" role="status">
        This secret is shown once — copy it now. It signs every delivery to this
        URL; losing it means rotating for a new one.
      </p>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium">Hook URL</span>
        <div className="flex items-center gap-1.5 rounded-[var(--ui-radius-md)] border border-[var(--ui-border)] bg-[var(--ui-bg-subtle)] px-2.5 py-1.5">
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--ui-fg)]">
            {url}
          </code>
          <CopyButton value={url} label="Copy hook URL" />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium">Signing secret</span>
        <div className="flex items-center gap-1.5 rounded-[var(--ui-radius-md)] border border-[var(--ui-border)] bg-[var(--ui-bg-subtle)] px-2.5 py-1.5">
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--ui-fg)]">
            {secret}
          </code>
          <CopyButton value={secret} label="Copy signing secret" />
        </div>
      </div>
      {samplePayload !== undefined && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium">Example payload</span>
          <pre className="overflow-x-auto rounded-[var(--ui-radius-md)] border border-[var(--ui-border)] bg-[var(--ui-bg-subtle)] px-2.5 py-2 font-mono text-xs whitespace-pre-wrap text-[var(--ui-fg-muted)]">
            {samplePayload}
          </pre>
          <p className="text-xs text-[var(--ui-fg-muted)]">
            Any valid JSON body with a matching{" "}
            <code className="font-mono">X-Webhook-Signature</code> header starts
            a run.
          </p>
        </div>
      )}
    </div>
  );
}
