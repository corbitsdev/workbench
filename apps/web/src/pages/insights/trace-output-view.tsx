import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Clipboard } from "lucide-react";
import { Markdown } from "@workbench/ui";
import {
  classifyTraceValue,
  stringifyTraceValue,
  type TraceOutputMode,
} from "./trace-output-format";
import { copyText } from "./tracer-shell";

export type { TraceOutputMode } from "./trace-output-format";
export {
  classifyTraceValue,
  looksLikeMarkdown,
  stringifyTraceValue,
} from "./trace-output-format";

function JsonTreeNode({
  label,
  value,
  depth,
}: {
  label: string | null;
  value: unknown;
  depth: number;
}) {
  const [open, setOpen] = useState(depth < 2);
  if (value === null) {
    return (
      <div className="font-mono text-[11px] text-text-3" style={{ paddingLeft: depth * 12 }}>
        {label !== null ? (
          <>
            <span className="text-text-2">{label}: </span>
            <span>null</span>
          </>
        ) : (
          "null"
        )}
      </div>
    );
  }
  if (typeof value !== "object") {
    const shown =
      typeof value === "string" ? JSON.stringify(value) : String(value);
    return (
      <div className="font-mono text-[11px] text-text-2" style={{ paddingLeft: depth * 12 }}>
        {label !== null ? (
          <>
            <span className="text-text-3">{label}: </span>
            <span>{shown}</span>
          </>
        ) : (
          shown
        )}
      </div>
    );
  }
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value as Record<string, unknown>);
  const preview = Array.isArray(value) ? `[${value.length}]` : "{…}";
  return (
    <div style={{ paddingLeft: depth * 12 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-[32px] items-center gap-1 font-mono text-[11px] text-text-2 hover:text-text"
      >
        <span className="text-text-3">{open ? "▾" : "▸"}</span>
        {label !== null ? (
          <>
            <span className="text-text-3">{label}: </span>
            <span>{preview}</span>
          </>
        ) : (
          preview
        )}
      </button>
      {open ? (
        <div className="border-l border-border/60 pl-1">
          {entries.map(([key, child]) => (
            <JsonTreeNode key={key} label={key} value={child} depth={depth + 1} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FormattedTraceBody({
  value,
  kind,
}: {
  value: unknown;
  kind: ReturnType<typeof classifyTraceValue>;
}) {
  if (kind === "markdown" && typeof value === "string") {
    return (
      <div
        data-testid="trace-output-markdown"
        className="max-h-[420px] overflow-auto rounded-[8px] border border-border bg-surface-2 p-3"
      >
        <Markdown className="text-[12px]">{value}</Markdown>
      </div>
    );
  }
  if (kind === "json") {
    const parsed =
      typeof value === "string"
        ? (() => {
            try {
              return JSON.parse(value) as unknown;
            } catch {
              return value;
            }
          })()
        : value;
    return (
      <div
        data-testid="trace-output-tree"
        className="max-h-[420px] overflow-auto rounded-[8px] border border-border bg-surface-2 p-3"
      >
        <JsonTreeNode label={null} value={parsed} depth={0} />
      </div>
    );
  }
  const text =
    typeof value === "string" ? value : stringifyTraceValue(value, "formatted");
  return (
    <pre
      data-testid="trace-output-text"
      className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-[8px] border border-border bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-text-2"
    >
      {text}
    </pre>
  );
}

function CopyOutputButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  return (
    <button
      type="button"
      data-testid="trace-output-copy"
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          if (timer.current !== null) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="flex min-h-[40px] items-center gap-1 rounded-sm border border-border px-2 py-1 text-[11px] font-medium text-text-2 transition-[color,background-color,transform] hover:bg-row-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.97]"
    >
      {copied ? (
        <Check className="h-3 w-3 text-green" />
      ) : (
        <Clipboard className="h-3 w-3" />
      )}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export function TraceOutputView({
  value,
  testId = "trace-payload",
  copyText: copyTextOverride,
}: {
  value: unknown;
  testId?: string;
  copyText?: string;
}) {
  const kind = useMemo(() => classifyTraceValue(value), [value]);
  const [mode, setMode] = useState<TraceOutputMode>("formatted");
  const rawText = useMemo(
    () => copyTextOverride ?? stringifyTraceValue(value, "raw"),
    [copyTextOverride, value],
  );
  const formattedCopy = useMemo(
    () => stringifyTraceValue(value, "formatted"),
    [value],
  );
  const copyPayload = mode === "raw" ? rawText : formattedCopy;

  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setMode("formatted")}
          aria-pressed={mode === "formatted"}
          className="min-h-[40px] rounded-sm border border-border px-2 py-1 text-[11px] font-medium text-text-2 transition-[color,background-color,transform] hover:bg-row-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.97]"
        >
          Formatted
        </button>
        <button
          type="button"
          onClick={() => setMode("raw")}
          aria-pressed={mode === "raw"}
          className="min-h-[40px] rounded-sm border border-border px-2 py-1 text-[11px] font-medium text-text-2 transition-[color,background-color,transform] hover:bg-row-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.97]"
        >
          Raw
        </button>
        <CopyOutputButton text={copyPayload} />
      </div>
      {mode === "formatted" ? (
        <FormattedTraceBody value={value} kind={kind} />
      ) : (
        <pre
          data-testid={testId}
          className="max-h-[420px] overflow-auto rounded-[8px] border border-border bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-text-2"
        >
          {rawText}
        </pre>
      )}
    </div>
  );
}