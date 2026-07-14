import { useState } from "react";
import { cn, Markdown } from "@workbench/ui";
import type { UIBlock } from "./ui-block";

export function isSafeLinkHref(url: string): boolean {
  const trimmed = url.trim();
  if (/^javascript:/iu.test(trimmed)) return false;
  if (trimmed.startsWith("/") || trimmed.startsWith("#")) return true;
  try {
    const parsed = new URL(trimmed);
    return (
      parsed.protocol === "http:" ||
      parsed.protocol === "https:" ||
      parsed.protocol === "mailto:"
    );
  } catch {
    return false;
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

export function CardBlock({
  block,
}: {
  block: Extract<UIBlock, { kind: "card" }>;
}) {
  const body =
    block.body !== undefined && block.body.trim().length > 0 ? (
      <Markdown className="text-sm text-text-2">{block.body}</Markdown>
    ) : null;

  const inner = (
    <>
      <div className="flex items-start justify-between gap-3 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-text">
            {block.title}
          </h3>
          {block.subtitle !== undefined && (
            <p className="truncate text-xs text-text-3">{block.subtitle}</p>
          )}
        </div>
        {block.badge !== undefined && (
          <span className="shrink-0 rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-2">
            {block.badge}
          </span>
        )}
      </div>
      {body !== null && <div className="border-t border-border px-3 py-2.5">{body}</div>}
      {block.footer !== undefined && (
        <div className="border-t border-border px-3 py-2 text-xs text-text-3">
          {block.footer}
        </div>
      )}
    </>
  );

  if (block.href !== undefined && isSafeLinkHref(block.href)) {
    return (
      <a
        href={block.href}
        target="_blank"
        rel="noreferrer"
        className="block rounded-lg border border-border bg-surface-2 transition-colors hover:border-border-strong"
      >
        {inner}
      </a>
    );
  }

  return <Surface>{inner}</Surface>;
}

export function ListBlock({
  block,
}: {
  block: Extract<UIBlock, { kind: "list" }>;
}) {
  const ListTag = block.ordered === true ? "ol" : "ul";
  const listClass =
    block.ordered === true
      ? "list-decimal space-y-2 pl-5"
      : "list-disc space-y-2 pl-5";

  return (
    <Surface className="px-3 py-2.5">
      {block.title !== undefined && (
        <div className="pb-2 text-sm font-medium text-text-2">{block.title}</div>
      )}
      <ListTag className={listClass}>
        {block.items.map((item, index) => (
          <li key={item.id ?? index} className="text-sm text-text">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="font-medium text-text">{item.title}</span>
              {item.badge !== undefined && (
                <span className="rounded-full border border-border px-1.5 py-px text-[10px] text-text-3">
                  {item.badge}
                </span>
              )}
            </div>
            {item.description !== undefined && (
              <p className="text-xs text-text-2">{item.description}</p>
            )}
            {item.meta !== undefined && (
              <p className="text-[11px] text-text-3">{item.meta}</p>
            )}
          </li>
        ))}
      </ListTag>
    </Surface>
  );
}

function PreviewImage({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  if (!isSafeLinkHref(url) || failed) return null;
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      className="h-28 w-full rounded-t-lg object-cover"
      onError={() => setFailed(true)}
    />
  );
}

export function PreviewBlock({
  block,
}: {
  block: Extract<UIBlock, { kind: "preview" }>;
}) {
  const title = block.title ?? block.url;
  if (!isSafeLinkHref(block.url)) {
    return (
      <Surface className="px-3 py-2.5">
        <span className="text-sm text-text-2">{title}</span>
      </Surface>
    );
  }

  return (
    <a
      href={block.url}
      target="_blank"
      rel="noreferrer"
      className="block overflow-hidden rounded-lg border border-border bg-surface-2 transition-colors hover:border-border-strong"
      data-testid="ui-preview"
    >
      {block.imageUrl !== undefined && <PreviewImage url={block.imageUrl} />}
      <div className="px-3 py-2.5">
        <span className="block truncate text-sm font-medium text-text">
          {title}
        </span>
        {block.description !== undefined && (
          <span className="mt-0.5 block line-clamp-2 text-xs text-text-3">
            {block.description}
          </span>
        )}
        <span className="mt-1 block truncate text-[11px] text-text-3">
          {block.url}
        </span>
      </div>
    </a>
  );
}