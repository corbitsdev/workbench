import { useRef, useState, useMemo } from 'react';
import { BookOpen, Search, X } from 'lucide-react';
import { SKILLS_REGISTRY, type SkillEntry } from '@workbench/agents';

const SEARCH_DEBOUNCE_MS = 300;

export function SkillsLibrary() {
  const [inputQuery, setInputQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sort, setSort] = useState<'name' | 'original'>('name');
  const [selected, setSelected] = useState<SkillEntry | null>(null);

  const handleQueryChange = (value: string) => {
    setInputQuery(value);
    if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      setDebouncedQuery(value);
    }, SEARCH_DEBOUNCE_MS);
  };

  const filteredSkills = useMemo(() => {
    let result = [...SKILLS_REGISTRY];
    const q = debouncedQuery.trim().toLowerCase();
    if (q) {
      result = result.filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.author.toLowerCase().includes(q)
      );
    }
    if (sort === 'name') {
      result.sort((a, b) => a.title.localeCompare(b.title));
    }
    return result;
  }, [debouncedQuery, sort]);

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-panel border border-border bg-bg">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-border bg-surface px-5 py-3 shrink-0">
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-text-3" />
          <p className="text-[14px] font-semibold text-text">Skills Library</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Sort toggle */}
          <div className="flex gap-1 rounded-[8px] bg-surface-2 p-[3px]">
            <button
              type="button"
              onClick={() => setSort('name')}
              className={`rounded-[6px] px-2.5 py-1 text-[12px] font-medium transition-colors ${
                sort === 'name'
                  ? 'bg-surface text-text shadow-sm'
                  : 'text-text-2 hover:text-text'
              }`}
            >
              A–Z
            </button>
    <button
      type="button"
      onClick={() => setSort('original')}
      className={`rounded-[6px] px-2.5 py-1 text-[12px] font-medium transition-colors ${
        sort === 'original'
          ? 'bg-surface text-text shadow-sm'
          : 'text-text-2 hover:text-text'
      }`}
    >
      Original
    </button>
          </div>
        </div>
      </div>

      {/* Search bar */}
      <div className="border-b border-border px-5 py-3 shrink-0">
        <div className="flex items-center gap-2 rounded-[12px] border border-border bg-surface px-3 py-2 focus-within:border-orange">
          <Search className="h-4 w-4 text-text-3" />
          <input
            type="text"
            value={inputQuery}
            onChange={(e) => handleQueryChange(e.target.value)}
            placeholder="Search skills…"
            className="w-full bg-transparent text-[14px] text-text outline-none placeholder:text-text-3"
          />
          {inputQuery && (
            <button
              type="button"
              onClick={() => handleQueryChange('')}
              className="grid h-5 w-5 place-items-center rounded-full text-text-3 hover:text-text"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {filteredSkills.map((skill) => (
            <button
              key={skill.id}
              type="button"
              onClick={() => setSelected(skill)}
              className="flex flex-col justify-between gap-3 rounded-[10px] border border-border p-4 text-left transition-colors hover:bg-[var(--row-hover)]"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-semibold text-text">{skill.title}</span>
                  <span className="rounded-[5px] bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-text-2">
                    v{skill.version}
                  </span>
                </div>
                <p className="mt-1.5 text-[12px] leading-[1.4] text-text-3 line-clamp-3">
                  {skill.description}
                </p>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-text-3">by {skill.author}</span>
                <span className="text-[11px] font-medium text-orange">View</span>
              </div>
            </button>
          ))}
        </div>
        {filteredSkills.length === 0 && (
          <div className="flex h-48 flex-col items-center justify-center gap-2">
            <p className="text-[13px] text-text-3">No skills match your search.</p>
          </div>
        )}
      </div>

      {/* Detail modal */}
      {selected && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-[rgba(0,0,0,0.55)] p-4 backdrop-blur-[2px]">
          <div
            role="dialog"
            aria-modal="true"
            aria-label={selected.title}
            className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-panel border border-border bg-surface shadow-[0_10px_40px_rgba(0,0,0,0.4)]"
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div className="flex items-center gap-2">
                <BookOpen className="h-4 w-4 text-text-3" />
                <div className="text-[16px] font-bold text-text">{selected.title}</div>
              </div>
              <button
                type="button"
                onClick={() => setSelected(null)}
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
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-[5px] bg-surface-2 px-2 py-0.5 text-[12px] font-medium text-text-2">
                  Version {selected.version}
                </span>
                <span className="rounded-[5px] bg-surface-2 px-2 py-0.5 text-[12px] font-medium text-text-2">
                  by {selected.author}
                </span>
              </div>
              <p className="text-[13px] text-text-2 leading-relaxed">{selected.description}</p>
              <div className="rounded-[8px] border border-border bg-surface p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-text-3 mb-2">
                  Skill content
                </p>
                <pre className="text-[12px] text-text-2 whitespace-pre-wrap font-mono leading-relaxed max-h-64 overflow-y-auto">
                  {selected.content}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
