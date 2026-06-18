import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, Plus, Search, X } from 'lucide-react';
import {
  useSkillDetail,
  useSkillLibrary,
  useSkillVersionPreview,
  type SkillLibraryItem,
} from '../hooks/use-workflow';
import { getMe } from '../lib/hub-api';

type SelectedSkill = { kind: 'library'; skill: SkillLibraryItem };

function LibraryCard({ skill, onSelect }: { skill: SkillLibraryItem; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex flex-col justify-between gap-3 rounded-[10px] border border-border p-4 text-left transition-colors hover:bg-[var(--row-hover)]"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-[14px] font-semibold text-text">{skill.name}</span>
          <span className="rounded-[5px] bg-green/10 px-1.5 py-0.5 text-[11px] font-medium text-green">
            v{skill.latestVersion ?? 1}
          </span>
        </div>
        <p className="mt-1.5 text-[12px] leading-[1.4] text-text-3 line-clamp-3">
          {skill.description ||
            `${skill.fileCount ?? 0} bundled file${skill.fileCount === 1 ? '' : 's'}`}
        </p>
      </div>
      <div className="flex items-center justify-between text-[11px] text-text-3">
        <span>{skill.source ?? 'library'}</span>
        <span>{new Date(skill.updatedAt).toLocaleDateString()}</span>
      </div>
    </button>
  );
}

export function SkillsLibrary() {
  const navigate = useNavigate();
  const meQuery = useQuery({ queryKey: ['me'], queryFn: getMe, staleTime: 5 * 60_000 });
  const tenantId = meQuery.data?.personalTenantId ?? null;
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<SelectedSkill | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);

  const skillsQuery = useSkillLibrary(tenantId);
  const selectedLibrarySkillId = selected?.kind === 'library' ? selected.skill.id : null;
  const skillDetailQuery = useSkillDetail(selectedLibrarySkillId, tenantId);
  const selectedLibrarySkill =
    skillDetailQuery.data ?? (selected?.kind === 'library' ? selected.skill : null);
  const previewQuery = useSkillVersionPreview(selectedVersionId, tenantId);

  const filteredLibrary = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (skillsQuery.data ?? []).filter(
      (skill) =>
        !q || skill.name.toLowerCase().includes(q) || skill.description?.toLowerCase().includes(q)
    );
  }, [query, skillsQuery.data]);

  const selectLibrary = (skill: SkillLibraryItem) => {
    setSelected({ kind: 'library', skill });
    setSelectedVersionId(skill.latestVersionId ?? null);
  };

  return (
    <div className="flex h-full overflow-hidden bg-bg">
      <div className="flex flex-1 flex-col overflow-hidden rounded-panel border border-border bg-bg">
        <div className="flex items-center justify-between gap-3 border-b border-border bg-surface px-5 py-3 shrink-0">
          <div className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-text-3" />
            <p className="text-[14px] font-semibold text-text">Skills Library</p>
          </div>
          <button
            type="button"
            onClick={() => navigate('/skills/new')}
            className="flex items-center gap-1.5 rounded-[9px] bg-orange px-3 py-1.5 text-[13px] font-medium text-white hover:bg-orange/90"
          >
            <Plus className="h-3.5 w-3.5" />
            Add Skill
          </button>
        </div>

        <div className="border-b border-border px-5 py-3 shrink-0">
          <div className="flex items-center gap-2 rounded-[12px] border border-border bg-surface px-3 py-2 focus-within:border-orange">
            <Search className="h-4 w-4 text-text-3" />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search skills..."
              className="w-full bg-transparent text-[14px] text-text outline-none placeholder:text-text-3"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="grid h-5 w-5 place-items-center rounded-full text-text-3 hover:text-text"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          <section>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[13px] font-semibold text-text">Workspace skills</p>
              {skillsQuery.isLoading && <p className="text-[12px] text-text-3">Loading...</p>}
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {filteredLibrary.map((skill) => (
                <LibraryCard key={skill.id} skill={skill} onSelect={() => selectLibrary(skill)} />
              ))}
            </div>
            {!skillsQuery.isLoading && filteredLibrary.length === 0 && (
              <p className="rounded-[10px] border border-border p-4 text-[13px] text-text-3">
                No skills yet.{' '}
                <button
                  type="button"
                  onClick={() => navigate('/skills/new')}
                  className="text-orange hover:underline"
                >
                  Add your first skill
                </button>
              </p>
            )}
          </section>
        </div>
      </div>

      {selected && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-[rgba(0,0,0,0.55)] p-4 backdrop-blur-[2px]">
          <div
            role="dialog"
            aria-modal="true"
            className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-panel border border-border bg-surface shadow-[0_10px_40px_rgba(0,0,0,0.4)]"
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div>
                <p className="text-[16px] font-bold text-text">{selected.skill.name}</p>
                <p className="text-[12px] text-text-3">Workspace reusable skill</p>
              </div>
              <button
                type="button"
                onClick={() => setSelected(null)}
                aria-label="Close"
                className="grid h-8 w-8 place-items-center rounded-[9px] border border-border text-text-2 hover:text-text"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              <>
                <div className="flex flex-wrap gap-2">
                  {(selectedLibrarySkill?.versions ?? []).map((version) => (
                    <button
                      key={version.id}
                      type="button"
                      onClick={() => setSelectedVersionId(version.id)}
                      className={`rounded-[7px] border px-2.5 py-1 text-[12px] font-medium ${selectedVersionId === version.id ? 'border-orange bg-orange/8 text-text' : 'border-border text-text-2'}`}
                    >
                      v{version.version} · {version.source ?? 'file'} ·{' '}
                      {version.manifest.files.length} files
                    </button>
                  ))}
                </div>
                {skillDetailQuery.isLoading && (
                  <p className="text-[12px] text-text-3">Loading versions...</p>
                )}
                {!skillDetailQuery.isLoading &&
                  (selectedLibrarySkill?.versions ?? []).length === 0 && (
                    <p className="text-[12px] text-text-3">No versions available for this skill.</p>
                  )}
                {previewQuery.data && (
                  <div className="grid gap-3 lg:grid-cols-[240px_minmax(0,1fr)]">
                    <div className="rounded-[8px] border border-border bg-bg p-3">
                      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-3">
                        Bundle files
                      </p>
                      <div className="space-y-1">
                        {previewQuery.data.version.manifest.files.map((file) => (
                          <div
                            key={file.path}
                            className="rounded-[6px] bg-surface px-2 py-1 text-[11px] text-text-2"
                          >
                            <p className="break-all font-mono">{file.path}</p>
                            <p className="text-text-3">
                              {file.promptReadable ? 'prompt-readable' : 'stored-only asset'}
                              {file.executableLike ? ' · code-like inert' : ''}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="space-y-3">
                      {previewQuery.data.files.map((file) => (
                        <div
                          key={file.path}
                          className="rounded-[8px] border border-border bg-bg p-3"
                        >
                          <p className="mb-2 break-all font-mono text-[11px] text-text-3">
                            {file.path}
                          </p>
                          {file.content !== undefined ? (
                            <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-text-2">
                              {file.content}
                            </pre>
                          ) : (
                            <p className="text-[12px] text-text-3">
                              Stored-only asset. Not injected into prompts and never executed.
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
