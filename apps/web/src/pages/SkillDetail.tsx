import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, File, Folder, Trash2, ArrowLeft } from 'lucide-react';
import { useSkillDetail, useDeleteSkill } from '../hooks/use-workflow';
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
  const deleteMutation = useDeleteSkill();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const skill = detailQuery.data?.skill;
  const files = detailQuery.data?.files ?? [];
  const tree = buildTree(files);

  const selectedFile =
    files.find((f) => f.path === selectedPath) ?? (files.length === 1 ? files[0] : null);

  const handleDelete = async () => {
    if (!id) return;
    await deleteMutation.mutateAsync({ assetId: id, tenantId }).catch(() => {});
    navigate('/skills');
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
          {files.length > 1 && (
            <div className="w-56 shrink-0 overflow-y-auto border-r border-border bg-surface py-2">
              {tree.map((node) => (
                <TreeItem
                  key={node.kind === 'file' ? node.path : node.name}
                  node={node}
                  depth={0}
                  onSelect={(n) => setSelectedPath(n.path)}
                  selectedPath={selectedPath ?? files[0]?.path ?? null}
                />
              ))}
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-5">
            {selectedFile ? (
              <div className="rounded-[10px] border border-border bg-surface">
                <div className="border-b border-border px-4 py-2">
                  <p className="font-mono text-[12px] text-text-3">{selectedFile.path}</p>
                </div>
                <div className="p-4">
                  {selectedFile.content !== undefined ? (
                    <pre className="whitespace-pre-wrap font-mono text-[13px] leading-relaxed text-text-2">
                      {selectedFile.content}
                    </pre>
                  ) : (
                    <p className="text-[13px] text-text-3">Binary file — content not displayed.</p>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-[13px] text-text-3">Select a file to view its contents.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
