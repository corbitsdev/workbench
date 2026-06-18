import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import Markdown from 'react-markdown';
import { ChevronRight, File, Folder, Trash2, ArrowLeft, Code, Eye } from 'lucide-react';
import {
  useSkillDetail,
  useDeleteSkill,
  useSkillVersions,
  useRestoreSkillVersion,
} from '../hooks/use-skills';
import { getMe } from '../lib/hub-api';

type TreeNode =
  | { kind: 'file'; path: string; name: string; content?: string }
  | { kind: 'dir'; name: string; children: TreeNode[] };

function buildTree(files: { path: string; content?: string }[]): TreeNode[] {
  const root: TreeNode[] = [];

  for (const file of files) {
    const parts = file.path.split('/');
    let nodes = root;

    for (let i = 0; i < parts.length - 1; i++) {
      const dirName = parts[i];
      let dir = nodes.find(
        (n): n is Extract<TreeNode, { kind: 'dir' }> => n.kind === 'dir' && n.name === dirName
      );
      if (!dir) {
        dir = { kind: 'dir', name: dirName, children: [] };
        nodes.push(dir);
      }
      nodes = dir.children;
    }

    nodes.push({
      kind: 'file',
      path: file.path,
      name: parts[parts.length - 1],
      content: file.content,
    });
  }

  return root;
}

function TreeItem({
  node,
  depth,
  onSelect,
  selectedPath,
}: {
  node: TreeNode;
  depth: number;
  onSelect: (node: Extract<TreeNode, { kind: 'file' }>) => void;
  selectedPath: string | null;
}) {
  const [open, setOpen] = useState(true);
  const indent = depth * 16;

  if (node.kind === 'dir') {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[13px] text-text-2 hover:bg-[var(--row-hover)]"
          style={{ paddingLeft: `${8 + indent}px` }}
        >
          <ChevronRight
            className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
          />
          <Folder className="h-3.5 w-3.5 shrink-0 text-text-3" />
          <span>{node.name}</span>
        </button>
        {open &&
          node.children.map((child) => (
            <TreeItem
              key={child.kind === 'file' ? child.path : child.name}
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
      className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[13px] hover:bg-[var(--row-hover)] ${selectedPath === node.path ? 'bg-orange/10 text-orange' : 'text-text-2'}`}
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
  const meQuery = useQuery({ queryKey: ['me'], queryFn: getMe, staleTime: 5 * 60_000 });
  const tenantId = meQuery.data?.personalTenantId ?? null;
  const detailQuery = useSkillDetail(id ?? null, tenantId);
  const versionsQuery = useSkillVersions(id ?? null, tenantId);
  const deleteMutation = useDeleteSkill();
  const restoreMutation = useRestoreSkillVersion();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);

  const skill = detailQuery.data?.skill;
  const files = detailQuery.data?.files ?? [];
  const tree = buildTree(files);

  const effectivePath = selectedPath ?? files[0]?.path ?? null;
  const selectedFile = files.find((f) => f.path === effectivePath) ?? null;

  const versions = [...(versionsQuery.data ?? [])].sort((a, b) => b.version - a.version);
  const latestVersion = versions[0]?.version ?? null;

  const handleRestore = (sha: string) => {
    if (!id) return;
    setRestoreError(null);
    restoreMutation.mutate(
      { assetId: id, sha, tenantId },
      {
        onError: (err) =>
          setRestoreError(err instanceof Error ? err.message : 'Failed to restore version'),
      }
    );
  };

  const handleDelete = async () => {
    if (!id) return;
    setDeleteError(null);
    deleteMutation
      .mutateAsync({ assetId: id, tenantId })
      .then(() => {
        navigate('/skills');
      })
      .catch((err: unknown) => {
        setDeleteError(err instanceof Error ? err.message : 'Failed to delete skill');
        setConfirmDelete(false);
      });
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-surface px-5 py-3 shrink-0">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/skills')}
            className="grid h-8 w-8 place-items-center rounded-[9px] border border-border text-text-2 hover:text-text"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            {skill && (
              <>
                <p className="text-[15px] font-semibold text-text">
                  {skill.displayName ?? skill.name}
                </p>
                <p className="text-[12px] text-text-3">{skill.name}</p>
              </>
            )}
            {detailQuery.isLoading && <p className="text-[13px] text-text-3">Loading...</p>}
          </div>
        </div>

        {deleteError && <p className="text-[12px] text-red-500">{deleteError}</p>}
        {skill && !confirmDelete && (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="flex items-center gap-1.5 rounded-[9px] border border-border px-3 py-1.5 text-[13px] text-text-2 hover:border-red-400 hover:text-red-500"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </button>
        )}
        {confirmDelete && (
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-text-2">Delete this skill?</span>
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
              className="rounded-[9px] bg-red-500 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-red-600 disabled:opacity-50"
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Confirm'}
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
      </div>

      {detailQuery.data && (
        <div className="flex flex-1 overflow-hidden">
          {tree.length > 0 && (
            <div className="w-56 shrink-0 overflow-y-auto border-r border-border bg-surface py-2">
              {tree.map((node) => (
                <TreeItem
                  key={node.kind === 'file' ? node.path : node.name}
                  node={node}
                  depth={0}
                  onSelect={(n) => setSelectedPath(n.path)}
                  selectedPath={effectivePath}
                />
              ))}
            </div>
          )}

          <div className="relative flex-1 overflow-y-auto p-5 space-y-5">
            {versions.length > 0 && (
              <section className="rounded-[10px] border border-border bg-surface">
                <div className="border-b border-border px-4 py-2">
                  <p className="text-[13px] font-semibold text-text">Version history</p>
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
                          <span className="font-medium text-text">v{version.version}</span>
                          <span className="font-mono text-text-3">{version.shortSha}</span>
                          <span className="truncate text-text-2">{version.authorName}</span>
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
                {restoreError && (
                  <p className="px-4 py-2 text-[12px] text-red-500">{restoreError}</p>
                )}
              </section>
            )}
            {selectedFile ? (
              <div className="rounded-[10px] border border-border bg-surface">
                <div className="flex items-center justify-between border-b border-border px-4 py-2">
                  <p className="font-mono text-[12px] text-text-3">{selectedFile.path}</p>
                </div>
                <div className="p-5">
                  {selectedFile.content !== undefined ? (
                    showSource ? (
                      <pre className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-text-2">
                        {selectedFile.content}
                      </pre>
                    ) : (
                      <div
                        className="prose prose-sm prose-invert max-w-none text-text-2
                        [&_h1]:text-[20px] [&_h1]:font-bold [&_h1]:text-text [&_h1]:mb-3
                        [&_h2]:text-[16px] [&_h2]:font-semibold [&_h2]:text-text [&_h2]:mb-2 [&_h2]:mt-5
                        [&_h3]:text-[14px] [&_h3]:font-semibold [&_h3]:text-text [&_h3]:mb-1.5 [&_h3]:mt-4
                        [&_p]:text-[13px] [&_p]:leading-relaxed [&_p]:mb-3
                        [&_ul]:pl-5 [&_ul]:mb-3 [&_li]:text-[13px] [&_li]:mb-1
                        [&_ol]:pl-5 [&_ol]:mb-3
                        [&_code]:font-mono [&_code]:text-[12px] [&_code]:bg-bg [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded
                        [&_pre]:bg-bg [&_pre]:rounded-[8px] [&_pre]:p-3 [&_pre]:overflow-x-auto [&_pre]:mb-3
                        [&_pre_code]:bg-transparent [&_pre_code]:p-0
                        [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-text-3
                        [&_hr]:border-border [&_hr]:my-4
                        [&_a]:text-orange [&_a]:no-underline hover:[&_a]:underline
                        [&_strong]:text-text [&_strong]:font-semibold"
                      >
                        <Markdown>{selectedFile.content}</Markdown>
                      </div>
                    )
                  ) : (
                    <p className="text-[13px] text-text-3">Binary file — content not displayed.</p>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-[13px] text-text-3">Select a file to view its contents.</p>
            )}

            {selectedFile?.content !== undefined && (
              <button
                type="button"
                onClick={() => setShowSource((v) => !v)}
                className="absolute bottom-9 left-9 flex items-center gap-1.5 rounded-[9px] border border-border bg-surface px-3 py-1.5 text-[12px] text-text-3 shadow-sm hover:text-text"
              >
                {showSource ? <Eye className="h-3.5 w-3.5" /> : <Code className="h-3.5 w-3.5" />}
                {showSource ? 'Preview' : 'Source'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
