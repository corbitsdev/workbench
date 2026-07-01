import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import {
  ChevronRight,
  File,
  Folder,
  Trash2,
  ArrowLeft,
  Code,
  Eye,
} from "lucide-react";
import {
  useSkillDetail,
  useDeleteSkill,
  useSkillVersions,
  useRestoreSkillVersion,
  SKILL_VERSION_PAGE_SIZE,
} from "../hooks/use-skills";
import { getMe } from "../lib/hub-api";
import { toHumanLabel } from "@workbench/ui";

type TreeNode =
  | { kind: "file"; path: string; name: string; content?: string }
  | { kind: "dir"; name: string; children: TreeNode[] };

function buildTree(files: { path: string; content?: string }[]): TreeNode[] {
  const root: TreeNode[] = [];

  for (const file of files) {
    const parts = file.path.split("/");
    let nodes = root;

    for (let i = 0; i < parts.length - 1; i++) {
      const dirName = parts[i];
      let dir = nodes.find(
        (n): n is Extract<TreeNode, { kind: "dir" }> =>
          n.kind === "dir" && n.name === dirName,
      );
      if (!dir) {
        dir = { kind: "dir", name: dirName, children: [] };
        nodes.push(dir);
      }
      nodes = dir.children;
    }

    nodes.push({
      kind: "file",
      path: file.path,
      name: parts[parts.length - 1],
      content: file.content,
    });
  }

  return root;
}

const MARKDOWN_EXTENSIONS = new Set(["md", "mdx", "markdown"]);

// Maps a file extension to a highlight.js language hint. Unknown extensions
// fall back to plaintext (still rendered as a clean code block, just uncolored).
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  sql: "sql",
  html: "xml",
  xml: "xml",
  css: "css",
  scss: "scss",
};

function fileExtension(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

const MARKDOWN_PROSE_CLASS = `prose prose-sm prose-invert max-w-none text-text-2
  [&_h1]:text-[20px] [&_h1]:font-bold [&_h1]:text-text [&_h1]:mb-3
  [&_h2]:text-[16px] [&_h2]:font-semibold [&_h2]:text-text [&_h2]:mb-2 [&_h2]:mt-5
  [&_h3]:text-[14px] [&_h3]:font-semibold [&_h3]:text-text [&_h3]:mb-1.5 [&_h3]:mt-4
  [&_p]:text-[13px] [&_p]:leading-relaxed [&_p]:mb-3 [&_p]:break-words
  [&_*]:min-w-0
  [&_ul]:pl-5 [&_ul]:mb-3 [&_li]:text-[13px] [&_li]:mb-1
  [&_ol]:pl-5 [&_ol]:mb-3
  [&_code]:font-mono [&_code]:text-[12px] [&_code]:bg-bg [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded
  [&_pre]:bg-bg [&_pre]:rounded-[8px] [&_pre]:p-3 [&_pre]:overflow-x-auto [&_pre]:mb-3
  [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[12px]
  [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-text-3
  [&_hr]:border-border [&_hr]:my-4
  [&_a]:text-orange [&_a]:no-underline hover:[&_a]:underline
  [&_strong]:text-text [&_strong]:font-semibold
  [&_table]:w-full [&_table]:my-3 [&_table]:text-[12.5px] [&_table]:border-collapse
  [&_th]:border [&_th]:border-border [&_th]:bg-surface-2 [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold [&_th]:text-text
  [&_td]:border [&_td]:border-border [&_td]:px-2.5 [&_td]:py-1.5 [&_td]:align-top
  [&_input]:mr-1.5`;

// Builds a code fence whose backtick run is longer than any run inside the
// content, so a code file that itself contains ``` cannot break out of it.
function fenceFor(content: string): string {
  const longest = (content.match(/`+/g) ?? []).reduce(
    (max, run) => Math.max(max, run.length),
    0,
  );
  return "`".repeat(Math.max(3, longest + 1));
}

function SkillFileBody({ path, content }: { path: string; content: string }) {
  const ext = fileExtension(path);
  const isMarkdown = MARKDOWN_EXTENSIONS.has(ext);
  const fence = fenceFor(content);
  const source = isMarkdown
    ? content
    : `${fence}${LANGUAGE_BY_EXTENSION[ext] ?? ""}\n${content}\n${fence}`;

  return (
    <div className={MARKDOWN_PROSE_CLASS}>
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {source}
      </Markdown>
    </div>
  );
}

function TreeItem({
  node,
  depth,
  onSelect,
  selectedPath,
}: {
  node: TreeNode;
  depth: number;
  onSelect: (node: Extract<TreeNode, { kind: "file" }>) => void;
  selectedPath: string | null;
}) {
  const [open, setOpen] = useState(true);
  const indent = depth * 16;

  if (node.kind === "dir") {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1.5 rounded-[10px] px-2 py-1 text-left text-[13px] text-text-2 hover:bg-[var(--row-hover)]"
          style={{ paddingLeft: `${8 + indent}px` }}
        >
          <ChevronRight
            className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          />
          <Folder className="h-3.5 w-3.5 shrink-0 text-text-3" />
          <span>{node.name}</span>
        </button>
        {open &&
          node.children.map((child) => (
            <TreeItem
              key={child.kind === "file" ? child.path : child.name}
              node={child}
              depth={depth + 1}
              onSelect={onSelect}
              selectedPath={selectedPath}
            />
          ))}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(node)}
      className={`flex w-full items-center gap-1.5 rounded-[10px] px-2 py-1 text-left text-[13px] hover:bg-[var(--row-hover)] ${selectedPath === node.path ? "bg-orange/10 font-medium text-orange" : "text-text-2"}`}
      style={{ paddingLeft: `${8 + indent + 16}px` }}
    >
      <File className="h-3.5 w-3.5 shrink-0 text-text-3" />
      <span className="truncate">{node.name}</span>
    </button>
  );
}

export function SkillDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: getMe,
    staleTime: 5 * 60_000,
  });
  const tenantId = meQuery.data?.personalTenantId ?? null;
  const detailQuery = useSkillDetail(id ?? null, tenantId);
  const [versionLimit, setVersionLimit] = useState(SKILL_VERSION_PAGE_SIZE);
  const versionsQuery = useSkillVersions(id ?? null, tenantId, versionLimit);
  const deleteMutation = useDeleteSkill();
  const restoreMutation = useRestoreSkillVersion();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);

  const skill = detailQuery.data?.skill;
  const files = detailQuery.data?.files ?? [];
  const tree = buildTree(files);

  const effectivePath = selectedPath ?? files[0]?.path ?? null;
  const selectedFile = files.find((f) => f.path === effectivePath) ?? null;

  const versions = [...(versionsQuery.data?.versions ?? [])].sort(
    (a, b) => b.version - a.version,
  );
  const totalVersions = versionsQuery.data?.total ?? 0;
  const latestVersion = versions[0]?.version ?? null;

  const handleRestore = (sha: string) => {
    if (!id) return;
    restoreMutation.mutate({ assetId: id, sha, tenantId });
  };

  const handleDelete = () => {
    if (!id) return;
    deleteMutation
      .mutateAsync({ assetId: id, tenantId })
      .then(() => {
        navigate("/skills");
      })
      .catch(() => {
        setConfirmDelete(false);
      });
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg">
      <div className="flex items-center gap-3 border-b border-border bg-surface px-5 py-3 shrink-0">
        <button
          type="button"
          onClick={() => navigate("/skills")}
          className="grid h-8 w-8 place-items-center rounded-[9px] border border-border text-text-2 hover:text-text"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div>
          {skill && (
            <p className="text-[15px] font-semibold text-text">
              {skill.displayName ?? toHumanLabel(skill.name)}
            </p>
          )}
          {detailQuery.isLoading && (
            <p className="text-[13px] text-text-3">Loading...</p>
          )}
        </div>
      </div>

      {detailQuery.isError && (
        <div className="flex flex-1 items-center justify-center p-5 text-[13px] text-text-3">
          Could not load this skill.
        </div>
      )}

      {detailQuery.data && (
        <div className="flex flex-1 overflow-hidden">
          {files.length > 1 && tree.length > 0 && (
            <div className="w-56 shrink-0 overflow-y-auto border-r border-border bg-surface py-2 max-md:w-40">
              {tree.map((node) => (
                <TreeItem
                  key={node.kind === "file" ? node.path : node.name}
                  node={node}
                  depth={0}
                  onSelect={(n) => setSelectedPath(n.path)}
                  selectedPath={effectivePath}
                />
              ))}
            </div>
          )}

          <div className="min-w-0 flex-1 space-y-5 overflow-y-auto p-5">
            {selectedFile ? (
              <div className="rounded-[10px] border border-border bg-surface">
                <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
                  <p className="min-w-0 truncate font-mono text-[12px] text-text-3">
                    {selectedFile.path}
                  </p>
                  {selectedFile.content !== undefined && (
                    <button
                      type="button"
                      onClick={() => setShowSource((v) => !v)}
                      aria-pressed={showSource}
                      className="flex shrink-0 items-center gap-1.5 rounded-[7px] border border-border px-2.5 py-1 text-[12px] text-text-3 transition-colors hover:border-border-strong hover:text-text"
                    >
                      {showSource ? (
                        <Eye className="h-3.5 w-3.5" />
                      ) : (
                        <Code className="h-3.5 w-3.5" />
                      )}
                      {showSource ? "Preview" : "Source"}
                    </button>
                  )}
                </div>
                <div className="overflow-x-auto p-5">
                  {selectedFile.content !== undefined ? (
                    showSource ? (
                      <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-text-2">
                        {selectedFile.content}
                      </pre>
                    ) : (
                      <SkillFileBody
                        path={selectedFile.path}
                        content={selectedFile.content}
                      />
                    )
                  ) : (
                    <p className="text-[13px] text-text-3">
                      Binary file — content not displayed.
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-[13px] text-text-3">
                Select a file to view its contents.
              </p>
            )}

            {versions.length > 0 && (
              <section className="rounded-[10px] border border-border bg-surface">
                <div className="border-b border-border px-4 py-2">
                  <p className="text-[13px] font-semibold text-text">
                    Version history
                  </p>
                </div>
                <ul className="divide-y divide-border">
                  {versions.map((version) => {
                    const isCurrent = version.version === latestVersion;
                    return (
                      <li
                        key={version.sha}
                        className="flex items-center justify-between gap-3 px-4 py-2 text-[12px]"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="font-medium text-text">
                            v{version.version}
                          </span>
                          <span className="font-mono text-text-3">
                            {version.shortSha}
                          </span>
                          <span className="truncate text-text-2">
                            {version.authorName}
                          </span>
                          <span className="shrink-0 text-text-3">
                            {new Date(version.createdAt).toLocaleString()}
                          </span>
                        </div>
                        {isCurrent ? (
                          <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[11px] text-text-3">
                            current
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleRestore(version.sha)}
                            disabled={restoreMutation.isPending}
                            className="shrink-0 rounded-[9px] border border-border px-2.5 py-1 text-[12px] text-text-2 hover:text-text disabled:opacity-50"
                          >
                            Restore
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {versions.length < totalVersions && (
                  <button
                    type="button"
                    onClick={() =>
                      setVersionLimit(
                        (limit) => limit + SKILL_VERSION_PAGE_SIZE,
                      )
                    }
                    className="w-full border-t border-border px-4 py-2 text-[12px] text-text-3 hover:text-text"
                  >
                    Show older versions ({totalVersions - versions.length} more)
                  </button>
                )}
                {restoreMutation.error && (
                  <p className="px-4 py-2 text-[12px] text-red-500">
                    {restoreMutation.error instanceof Error
                      ? restoreMutation.error.message
                      : "Failed to restore version"}
                  </p>
                )}
              </section>
            )}

            {skill && (
              <section className="flex items-center justify-between gap-3 rounded-[10px] border border-border bg-surface px-4 py-3">
                {deleteMutation.error ? (
                  <p className="text-[12px] text-red-500">
                    {deleteMutation.error instanceof Error
                      ? deleteMutation.error.message
                      : "Failed to delete skill"}
                  </p>
                ) : (
                  <p className="text-[12px] text-text-3">
                    Permanently delete this skill and its history.
                  </p>
                )}
                {!confirmDelete ? (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    className="flex shrink-0 items-center gap-1.5 rounded-[9px] border border-border px-3 py-1.5 text-[13px] text-text-2 hover:border-red-400 hover:text-red-500"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </button>
                ) : (
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-[13px] text-text-2">
                      Delete this skill?
                    </span>
                    <button
                      type="button"
                      onClick={handleDelete}
                      disabled={deleteMutation.isPending}
                      className="rounded-[9px] bg-red-500 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-red-600 disabled:opacity-50"
                    >
                      {deleteMutation.isPending ? "Deleting..." : "Confirm"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(false)}
                      className="rounded-[9px] border border-border px-3 py-1.5 text-[13px] text-text-2 hover:text-text"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </section>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
