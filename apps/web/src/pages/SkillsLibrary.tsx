import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, Plus, Search, X } from 'lucide-react';
import { useSkillLibrary, useSkillShareTargets, type SkillLibraryItem } from '../hooks/use-skills';
import { getMe } from '../lib/hub-api';

function LibraryCard({
  skill,
  accessLabel,
  onSelect,
}: {
  skill: SkillLibraryItem;
  accessLabel: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex flex-col justify-between gap-3 rounded-[10px] border border-border p-4 text-left transition-colors hover:bg-[var(--row-hover)]"
    >
      <div className="min-w-0">
        <span className="truncate text-[14px] font-semibold text-text">
          {skill.displayName ?? skill.name}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 text-[11px] text-text-3">
        <span className="truncate">{skill.ownerName ?? '—'}</span>
        <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5">
          {accessLabel}
        </span>
        <span className="shrink-0">{new Date(skill.updatedAt).toLocaleDateString()}</span>
      </div>
    </button>
  );
}

export function SkillsLibrary() {
  const navigate = useNavigate();
  const meQuery = useQuery({ queryKey: ['me'], queryFn: getMe, staleTime: 5 * 60_000 });
  const tenantId = meQuery.data?.personalTenantId ?? null;
  const [query, setQuery] = useState('');

  const skillsQuery = useSkillLibrary(tenantId);
  const shareTargetsQuery = useSkillShareTargets(tenantId);

  const accessLabel = (skill: SkillLibraryItem) => {
    if (skill.scope === 'private') return 'Private';
    const target = (shareTargetsQuery.data ?? []).find((t) => t.tenantId === skill.accessTenantId);
    return target ? target.name : 'Shared';
  };

  const filteredLibrary = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (skillsQuery.data ?? []).filter(
      (skill) =>
        !q ||
        skill.name.toLowerCase().includes(q) ||
        (skill.displayName ?? '').toLowerCase().includes(q)
    );
  }, [query, skillsQuery.data]);

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
                <LibraryCard
                  key={skill.id}
                  skill={skill}
                  accessLabel={accessLabel(skill)}
                  onSelect={() => navigate(`/skills/${skill.id}`)}
                />
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
    </div>
  );
}
