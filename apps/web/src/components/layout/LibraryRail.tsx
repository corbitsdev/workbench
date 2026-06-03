// PHASE 1 SCAFFOLD — static sample data mirroring workbench.html.
// Phase 2 replaces SAMPLE_ITEMS with a typed provider (lib/workbench-data.ts):
//   - Workflows group  -> real GET /workflows (sessions)
//   - Workbenches/Agents -> MOCK until offerings registry (CL-911)
// Search + segment filtering interactivity is CL-985; this renders the visual rail only.

type ResourceType = 'workflow' | 'workbench' | 'agent';
type ResourceStatus = 'run' | 'done' | 'idle';

interface RailItem {
  group: string;
  name: string;
  type: ResourceType;
  sub: string;
  status: ResourceStatus;
  who: string;
  color: string;
}

const SAMPLE_ITEMS: RailItem[] = [
  {
    group: 'Pinned',
    name: 'GTM Workbench',
    type: 'workbench',
    sub: 'CL-981 · 6 agents',
    status: 'run',
    who: 'GA',
    color: 'var(--blue)',
  },
  {
    group: 'Pinned',
    name: 'Revenue & Ad Campaign Analysis',
    type: 'workflow',
    sub: 'CL-857 · runs daily',
    status: 'done',
    who: 'JO',
    color: 'var(--orange)',
  },
  {
    group: 'Pinned',
    name: 'Network Vaults',
    type: 'workbench',
    sub: 'CL-874 · knowledge base',
    status: 'idle',
    who: 'SC',
    color: 'var(--blue)',
  },
  {
    group: 'Recently active',
    name: 'WhatsApp Rating Agent',
    type: 'agent',
    sub: 'CL-926 · 1.2k msgs',
    status: 'run',
    who: 'GA',
    color: 'var(--green)',
  },
  {
    group: 'Recently active',
    name: 'Faremeter Release Notes',
    type: 'workflow',
    sub: 'FMTR-453 · v0.22.0',
    status: 'run',
    who: 'GA',
    color: 'var(--orange)',
  },
  {
    group: 'Recently active',
    name: 'Weekly Link Roundup',
    type: 'agent',
    sub: 'MKT-387 · newsletter',
    status: 'idle',
    who: 'JO',
    color: 'var(--green)',
  },
  {
    group: 'All resources',
    name: 'Content Pipeline',
    type: 'workbench',
    sub: 'tweet → publish',
    status: 'run',
    who: 'GA',
    color: 'var(--blue)',
  },
  {
    group: 'All resources',
    name: 'Solana Dev Playbook',
    type: 'workflow',
    sub: 'scaffold + test',
    status: 'idle',
    who: 'PA',
    color: 'var(--orange)',
  },
  {
    group: 'All resources',
    name: 'Meeting Todo Router',
    type: 'agent',
    sub: 'Granola → Linear',
    status: 'done',
    who: 'JO',
    color: 'var(--green)',
  },
];

const GROUP_ORDER = ['Pinned', 'Recently active', 'All resources'];

const TAG_STYLES: Record<ResourceType, string> = {
  workflow: 'bg-[rgba(233,132,40,0.16)] text-orange',
  workbench: 'bg-[rgba(96,124,154,0.18)] text-blue',
  agent: 'bg-[rgba(123,153,116,0.18)] text-green',
};

const DOT_STYLES: Record<ResourceType, string> = {
  workflow: 'bg-orange',
  workbench: 'bg-blue',
  agent: 'bg-green',
};

function StatusDot({ status }: { status: ResourceStatus }) {
  if (status === 'done') {
    return (
      <span className="relative h-[15px] w-[15px] flex-none rounded-full bg-green">
        <span className="absolute left-[4px] top-[1.5px] h-2 w-1 rotate-[42deg] border-b-2 border-r-2 border-white" />
      </span>
    );
  }
  if (status === 'run') {
    return (
      <span className="relative h-[15px] w-[15px] flex-none rounded-full border-2 border-orange">
        <span className="absolute inset-[2px] rounded-full bg-orange" />
      </span>
    );
  }
  return (
    <span className="relative h-[15px] w-[15px] flex-none rounded-full border-2 border-text-3">
      <span className="absolute inset-[3px] rounded-full bg-text-3 opacity-40" />
    </span>
  );
}

export function LibraryRail() {
  const segments: { label: string; count: number }[] = [
    { label: 'All', count: SAMPLE_ITEMS.length },
    { label: 'Workflows', count: SAMPLE_ITEMS.filter((i) => i.type === 'workflow').length },
    { label: 'Workbenches', count: SAMPLE_ITEMS.filter((i) => i.type === 'workbench').length },
    { label: 'Agents', count: SAMPLE_ITEMS.filter((i) => i.type === 'agent').length },
  ];

  return (
    <aside className="flex h-full flex-col overflow-hidden rounded-panel border border-border bg-bg shadow-[var(--shadow,0_2px_6px_rgba(0,0,0,0.3))]">
      <div className="px-[18px] pb-[10px] pt-[18px]">
        <div className="text-[13px] font-bold uppercase tracking-[0.04em] text-text-3">Library</div>
        <div className="mt-3 flex items-center gap-[9px] rounded-[12px] border border-border bg-surface px-[11px] py-2 focus-within:border-orange">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="h-[15px] w-[15px] flex-none text-text-3"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4-4" />
          </svg>
          <input
            aria-label="Search workflows, agents"
            placeholder="Search workflows, agents…"
            className="w-full border-none bg-transparent text-[14px] text-text outline-none placeholder:text-text-3"
          />
          <span className="flex-none rounded-[5px] border border-border px-1.5 py-0.5 font-mono text-[11px] text-text-3">
            ⌘K
          </span>
        </div>
      </div>

      <div className="flex flex-wrap gap-[3px] px-4 pb-1.5 pt-3">
        {segments.map((seg, idx) => (
          <button
            key={seg.label}
            type="button"
            className={`flex items-center gap-[5px] whitespace-nowrap rounded-[9px] px-[9px] py-1.5 text-[12px] font-semibold transition-colors ${
              idx === 0
                ? 'bg-surface text-text shadow-[0_2px_6px_rgba(0,0,0,0.2)]'
                : 'text-text-2 hover:bg-[var(--row-hover)]'
            }`}
          >
            {seg.label} <span className="font-mono text-[10.5px] text-text-3">{seg.count}</span>
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-[10px] pb-[22px] pt-1">
        {GROUP_ORDER.map((group) => {
          const inGroup = SAMPLE_ITEMS.filter((i) => i.group === group);
          if (inGroup.length === 0) return null;
          return (
            <div key={group}>
              <div className="flex items-center gap-2 px-[10px] pb-[7px] pt-[14px] text-[11.5px] font-bold uppercase tracking-[0.05em] text-text-3">
                {group}
                <span className="font-mono text-[11px] font-normal opacity-70">
                  {inGroup.length}
                </span>
                <span className="h-px flex-1 bg-border" />
              </div>
              {/* TODO(CL-985): key by stable resource id once wired to real data. */}
              {inGroup.map((item, idx) => (
                <div
                  key={item.name}
                  className={`group relative flex items-center gap-[11px] rounded-[12px] px-[11px] py-[10px] transition-colors hover:bg-[var(--row-hover)] ${
                    group === 'Pinned' && idx === 0
                      ? 'bg-surface shadow-[0_2px_6px_rgba(0,0,0,0.2)]'
                      : ''
                  }`}
                >
                  <StatusDot status={item.status} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-medium text-text">{item.name}</div>
                    <div className="mt-px font-mono text-[11.5px] text-text-3">{item.sub}</div>
                  </div>
                  <span
                    className={`flex flex-none items-center gap-[5px] whitespace-nowrap rounded-full px-2 py-[3px] text-[10.5px] font-bold uppercase tracking-[0.03em] ${TAG_STYLES[item.type]}`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${DOT_STYLES[item.type]}`} />
                    {item.type}
                  </span>
                  <div
                    className="grid h-[22px] w-[22px] flex-none place-items-center rounded-full text-[10px] font-bold text-white"
                    style={{ background: item.color }}
                  >
                    {item.who}
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
