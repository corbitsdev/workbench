import { useState } from "react";
import { Streamdown } from "streamdown";
import { cn } from "@workbench/ui";
import type { UIBlock, UIResponse } from "./ui-block";

/**
 * The generative-UI registry: the single switch that turns a typed UIBlock into
 * a rendered component. Adding a block type = one variant in the union + one
 * case here. Interactive blocks (choice) call `onRespond`, which the host wires
 * to "send a new user turn", closing the agent loop.
 */
export interface UIBlockViewProps {
  block: UIBlock;
  /** Invoked when an interactive block produces a response to send to the agent. */
  onRespond?: ((response: UIResponse) => void) | undefined;
  /** Invoked for document actions (copy / download / save-artifact). */
  onAction?:
    | ((action: "copy" | "download" | "save-artifact", block: UIBlock) => void)
    | undefined;
}

export function UIBlockView({ block, onRespond, onAction }: UIBlockViewProps) {
  switch (block.kind) {
    case "text":
      return (
        <p className="whitespace-pre-wrap break-words text-sm text-text-2">
          {block.text}
        </p>
      );
    case "markdown":
      return <MarkdownBlock block={block} />;
    case "document":
      return (
        <DocumentBlock
          block={block}
          {...(onAction !== undefined ? { onAction } : {})}
        />
      );
    case "table":
      return <TableBlock block={block} />;
    case "link":
      return <LinkBlock block={block} />;
    case "error":
      return <ErrorBlock block={block} />;
    case "choice":
      return (
        <ChoiceBlock
          block={block}
          {...(onRespond !== undefined ? { onRespond } : {})}
        />
      );
    case "canvas":
      return (
        <div className="space-y-3" data-testid="ui-canvas">
          {block.title !== undefined && (
            <h3 className="text-sm font-semibold text-text">{block.title}</h3>
          )}
          {block.blocks.map((child, index) => (
            <UIBlockView
              key={index}
              block={child}
              onRespond={onRespond}
              onAction={onAction}
            />
          ))}
        </div>
      );
  }
}

function Surface({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("rounded-lg border border-border bg-surface-2", className)}
    >
      {children}
    </div>
  );
}

function MarkdownBlock({
  block,
}: {
  block: Extract<UIBlock, { kind: "markdown" }>;
}) {
  const [open, setOpen] = useState(!(block.collapsible ?? false));
  return (
    <Surface className="overflow-hidden">
      {block.title !== undefined && (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium text-text-2"
        >
          {block.title}
          {block.collapsible === true && (
            <span className="text-text-3">{open ? "−" : "+"}</span>
          )}
        </button>
      )}
      {open && (
        <div className="chat-md px-3 pb-3 text-sm text-text">
          <Streamdown mode="static">{block.source}</Streamdown>
        </div>
      )}
    </Surface>
  );
}

function DocumentBlock({
  block,
  onAction,
}: {
  block: Extract<UIBlock, { kind: "document" }>;
  onAction?: (
    action: "copy" | "download" | "save-artifact",
    block: UIBlock,
  ) => void;
}) {
  const [open, setOpen] = useState(false);
  const actions = block.actions ?? { copy: true };
  const actionList: {
    key: "copy" | "download" | "save-artifact";
    label: string;
  }[] = [];
  if (actions.copy === true) actionList.push({ key: "copy", label: "Copy" });
  if (actions.download === true)
    actionList.push({ key: "download", label: "Download" });
  if (actions.saveArtifact === true)
    actionList.push({ key: "save-artifact", label: "Save to artifacts" });

  return (
    <Surface>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
        aria-expanded={open}
      >
        <span
          className={cn(
            "text-text-3 transition-transform",
            open && "rotate-90",
          )}
          aria-hidden
        >
          ▸
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-text">
            {block.title}
          </span>
          {block.subtitle !== undefined && (
            <span className="block truncate text-xs text-text-3">
              {block.subtitle}
            </span>
          )}
        </span>
        <span className="shrink-0 text-xs text-text-3">
          {open ? "Hide" : "Open"}
        </span>
      </button>
      {open && (
        <div className="border-t border-border">
          <div className="chat-md max-h-96 overflow-auto px-4 py-3 text-sm text-text">
            <Streamdown mode="static">{block.source}</Streamdown>
          </div>
          {actionList.length > 0 && (
            <div className="flex gap-2 border-t border-border px-3 py-2">
              {actionList.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  onClick={() => onAction?.(action.key, block)}
                  className="rounded-md border border-border px-2.5 py-1 text-xs text-text-2 hover:bg-row-hover hover:text-text"
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </Surface>
  );
}

function TableBlock({ block }: { block: Extract<UIBlock, { kind: "table" }> }) {
  return (
    <Surface className="overflow-hidden">
      {block.title !== undefined && (
        <div className="px-3 py-2 text-sm font-medium text-text-2">
          {block.title}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-y border-border text-xs text-text-3">
              {block.columns.map((column) => (
                <th key={column} className="px-3 py-1.5 font-medium">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr
                key={rowIndex}
                className="border-b border-border last:border-0 hover:bg-row-hover"
              >
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className="px-3 py-1.5 text-text">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Surface>
  );
}

function LinkBlock({ block }: { block: Extract<UIBlock, { kind: "link" }> }) {
  return (
    <a
      href={block.url}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2.5 hover:border-border-strong"
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-text">
          {block.title ?? block.url}
        </span>
        {block.description !== undefined && (
          <span className="block truncate text-xs text-text-3">
            {block.description}
          </span>
        )}
      </span>
    </a>
  );
}

function ErrorBlock({ block }: { block: Extract<UIBlock, { kind: "error" }> }) {
  return (
    <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">
      <span className="font-medium">{block.message}</span>
      {block.detail !== undefined && (
        <pre className="mt-1 whitespace-pre-wrap break-words text-xs opacity-80">
          {block.detail}
        </pre>
      )}
    </div>
  );
}

function ChoiceBlock({
  block,
  onRespond,
}: {
  block: Extract<UIBlock, { kind: "choice" }>;
  onRespond?: (response: UIResponse) => void;
}) {
  const [answered, setAnswered] = useState<string | null>(null);
  if (answered !== null) {
    return <p className="text-xs italic text-text-3">You chose: {answered}</p>;
  }
  return (
    <div className="space-y-2">
      {block.prompt !== undefined && (
        <p className="text-sm text-text-2">{block.prompt}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {block.options.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => {
              setAnswered(option.label);
              onRespond?.({
                blockKind: "choice",
                value: option.value ?? option.label,
              });
            }}
            className="rounded-full border border-border bg-bg px-3 py-1.5 text-sm text-text hover:border-orange hover:text-orange"
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
