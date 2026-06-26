// "Add from source" flow for the artifact gallery. Two modes ship today: link
// an external URL (stored as an `imported` artifact) or paste text (a `manual`
// artifact). File/folder upload + batch import are tracked as a follow-up
// (CL-2438) and intentionally absent rather than stubbed.

import { useState } from "react";
import { Button } from "@workbench/ui";
import { useCreateArtifact } from "@workbench/client/react";
import { clientOptions } from "../lib/client-options";

type Mode = "url" | "text";

interface AddArtifactModalProps {
  open: boolean;
  tenantId?: string | null;
  onClose: () => void;
  /** Called with the new artifact id once creation succeeds. */
  onCreated?: (artifactId: string) => void;
}

export function AddArtifactModal({
  open,
  tenantId,
  onClose,
  onCreated,
}: AddArtifactModalProps) {
  const [mode, setMode] = useState<Mode>("url");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);

  const createArtifact = useCreateArtifact(clientOptions);

  if (!open) return null;

  function reset() {
    setTitle("");
    setContent("");
    setError(null);
    setMode("url");
  }

  function handleClose() {
    if (createArtifact.isPending) return;
    reset();
    onClose();
  }

  function handleSubmit() {
    setError(null);
    const trimmedTitle = title.trim();
    const trimmedContent = content.trim();
    if (trimmedTitle.length === 0 || trimmedContent.length === 0) {
      setError("Both a title and a value are required.");
      return;
    }
    createArtifact
      .mutateAsync({
        tenantId,
        mode,
        title: trimmedTitle,
        content: trimmedContent,
      })
      .then((artifact) => {
        reset();
        onCreated?.(artifact.id);
        onClose();
      })
      .catch((cause: unknown) => {
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not add the artifact. Please try again.",
        );
      });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add artifact from source"
      className="fixed inset-0 z-50 grid place-items-center bg-[rgba(0,0,0,0.45)] p-4"
      onClick={handleClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          handleClose();
        }
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-[480px] flex-col gap-4 rounded-panel border border-border bg-bg p-6 shadow-[0_8px_30px_rgba(0,0,0,0.4)]"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-[16px] font-bold text-text">Add artifact</h2>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close"
            className="grid h-8 w-8 flex-none place-items-center rounded-[9px] border border-border text-text-2 transition-colors hover:bg-[var(--row-hover)] hover:text-text"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-4 w-4"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div
          role="tablist"
          aria-label="Source type"
          className="flex gap-1 rounded-[9px] border border-border p-1"
        >
          {(["url", "text"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => {
                setMode(m);
                setError(null);
              }}
              className={`flex-1 rounded-[7px] px-3 py-[6px] text-[12.5px] font-semibold transition-colors ${
                mode === m
                  ? "bg-charcoal text-cream"
                  : "text-text-2 hover:bg-[var(--row-hover)]"
              }`}
            >
              {m === "url" ? "Link URL" : "Paste text"}
            </button>
          ))}
        </div>

        <label className="flex flex-col gap-1.5 text-[12px] font-semibold text-text-3">
          Title
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Name this artifact"
            className="h-[36px] rounded-[9px] border border-border bg-transparent px-3 text-[13px] text-text placeholder:text-text-3 focus:outline-none focus:ring-2 focus:ring-orange"
          />
        </label>

        <label className="flex flex-col gap-1.5 text-[12px] font-semibold text-text-3">
          {mode === "url" ? "URL" : "Text"}
          {mode === "url" ? (
            <input
              type="url"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="https://example.com/page"
              className="h-[36px] rounded-[9px] border border-border bg-transparent px-3 text-[13px] text-text placeholder:text-text-3 focus:outline-none focus:ring-2 focus:ring-orange"
            />
          ) : (
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Paste the content to store as an artifact"
              rows={6}
              className="resize-y rounded-[9px] border border-border bg-transparent px-3 py-2 text-[13px] text-text placeholder:text-text-3 focus:outline-none focus:ring-2 focus:ring-orange"
            />
          )}
        </label>

        {error && <p className="text-[12.5px] text-red-400">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={handleClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={createArtifact.isPending}>
            {createArtifact.isPending ? "Adding…" : "Add artifact"}
          </Button>
        </div>
      </div>
    </div>
  );
}
