// "Add from source" flow for the artifact gallery. Four modes ship today: link
// an external URL (an `imported` artifact), paste text (a `manual` artifact),
// upload one or more files, or upload a whole folder (`webkitdirectory`). File
// and folder uploads persist each file's binary and create one `imported`
// artifact per file (CL-2475).

import { useRef, useState } from "react";
import { Button } from "@workbench/ui";
import { useCreateArtifact, useUploadArtifacts } from "@workbench/client/react";
import { clientOptions } from "../lib/client-options";

type Mode = "url" | "text" | "file" | "folder";

const TAB_LABELS: Record<Mode, string> = {
  url: "Link URL",
  text: "Paste text",
  file: "Upload files",
  folder: "Upload folder",
};

type UploadStatus = "pending" | "uploading" | "done" | "error";

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
  const [files, setFiles] = useState<File[]>([]);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>("pending");
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const createArtifact = useCreateArtifact(clientOptions);
  const uploadArtifacts = useUploadArtifacts(clientOptions);

  if (!open) return null;

  const pending = createArtifact.isPending || uploadArtifacts.isPending;
  const isUpload = mode === "file" || mode === "folder";

  function reset() {
    setTitle("");
    setContent("");
    setFiles([]);
    setUploadStatus("pending");
    setError(null);
    setMode("url");
  }

  function handleClose() {
    if (pending) return;
    reset();
    onClose();
  }

  function handleFilesChange(list: FileList | null) {
    setError(null);
    setUploadStatus("pending");
    setFiles(list ? Array.from(list) : []);
  }

  function submitTextOrUrl() {
    const trimmedTitle = title.trim();
    const trimmedContent = content.trim();
    if (trimmedTitle.length === 0 || trimmedContent.length === 0) {
      setError("Both a title and a value are required.");
      return;
    }
    createArtifact
      .mutateAsync({
        tenantId,
        mode: mode === "url" ? "url" : "text",
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

  function submitUpload() {
    if (files.length === 0) {
      setError("Choose at least one file to upload.");
      return;
    }
    setUploadStatus("uploading");
    uploadArtifacts
      .mutateAsync({ tenantId, files })
      .then((artifacts) => {
        setUploadStatus("done");
        const first = artifacts[0];
        reset();
        if (first) onCreated?.(first.id);
        onClose();
      })
      .catch((cause: unknown) => {
        setUploadStatus("error");
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not upload the files. Please try again.",
        );
      });
  }

  function handleSubmit() {
    setError(null);
    if (isUpload) {
      submitUpload();
      return;
    }
    submitTextOrUrl();
  }

  function statusLabel(): string {
    if (uploadStatus === "uploading") return "Uploading…";
    if (uploadStatus === "done") return "Added";
    if (uploadStatus === "error") return "Failed";
    return "Ready";
  }

  function submitLabel(): string {
    if (pending) return isUpload ? "Uploading…" : "Adding…";
    return isUpload ? "Upload" : "Add artifact";
  }

  // `webkitdirectory`/`directory` are non-standard input attributes (folder
  // selection) the React types do not model; supply them via a typed spread.
  const folderInputProps = {
    webkitdirectory: "",
    directory: "",
  } as unknown as Record<string, string>;

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
          {(["url", "text", "file", "folder"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => {
                setMode(m);
                setError(null);
                setUploadStatus("pending");
                setFiles([]);
              }}
              className={`flex-1 rounded-[7px] px-3 py-[6px] text-[12.5px] font-semibold transition-colors ${
                mode === m
                  ? "bg-charcoal text-cream"
                  : "text-text-2 hover:bg-[var(--row-hover)]"
              }`}
            >
              {TAB_LABELS[m]}
            </button>
          ))}
        </div>

        {!isUpload && (
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
        )}

        {mode === "url" && (
          <label className="flex flex-col gap-1.5 text-[12px] font-semibold text-text-3">
            URL
            <input
              type="url"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="https://example.com/page"
              className="h-[36px] rounded-[9px] border border-border bg-transparent px-3 text-[13px] text-text placeholder:text-text-3 focus:outline-none focus:ring-2 focus:ring-orange"
            />
          </label>
        )}

        {mode === "text" && (
          <label className="flex flex-col gap-1.5 text-[12px] font-semibold text-text-3">
            Text
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Paste the content to store as an artifact"
              rows={6}
              className="resize-y rounded-[9px] border border-border bg-transparent px-3 py-2 text-[13px] text-text placeholder:text-text-3 focus:outline-none focus:ring-2 focus:ring-orange"
            />
          </label>
        )}

        {isUpload && (
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1.5 text-[12px] font-semibold text-text-3">
              {mode === "folder" ? "Folder" : "Files"}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                aria-label={
                  mode === "folder" ? "Choose folder" : "Choose files"
                }
                onChange={(e) => handleFilesChange(e.target.files)}
                className="text-[13px] text-text file:mr-3 file:rounded-[7px] file:border file:border-border file:bg-transparent file:px-3 file:py-[6px] file:text-[12.5px] file:font-semibold file:text-text"
                {...(mode === "folder" ? folderInputProps : {})}
              />
            </label>

            {files.length === 0 ? (
              <p className="text-[12.5px] text-text-3">
                No files selected yet.
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                <ul className="flex max-h-[160px] flex-col gap-1 overflow-y-auto">
                  {files.map((file, index) => (
                    <li
                      key={`${file.webkitRelativePath || file.name}-${index}`}
                      className="truncate text-[12.5px] text-text-2"
                    >
                      {file.webkitRelativePath || file.name}
                    </li>
                  ))}
                </ul>
                <p className="text-[12.5px] text-text-3">
                  {files.length} file{files.length === 1 ? "" : "s"} selected ·{" "}
                  {statusLabel()}
                </p>
              </div>
            )}
          </div>
        )}

        {error && <p className="text-[12.5px] text-red-400">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={handleClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={pending}>
            {submitLabel()}
          </Button>
        </div>
      </div>
    </div>
  );
}
