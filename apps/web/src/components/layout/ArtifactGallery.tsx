// PHASE 1 SCAFFOLD — static sample artifacts mirroring workbench.html.
// Phase 2 replaces SAMPLE_ARTIFACTS with useArtifacts() (lib/workbench-data.ts):
//   - real collateral_items derived from workflow GETs + MOCK decorative fillers.
// The artifact detail modal + open-in-workbench routing is CL-988; this renders the grid only.

type VizKind = 'bars' | 'donut' | 'grid' | 'lines' | 'nodes' | 'heat' | 'deck' | 'cal';

interface Artifact {
  title: string;
  type: string;
  span: string;
  fill: string;
  viz: VizKind;
  from: string;
  time: string;
}

const SAMPLE_ARTIFACTS: Artifact[] = [
  {
    title: 'Q2 Revenue by Product',
    type: 'Chart',
    span: 'row-span-3',
    fill: 'bg-orange',
    viz: 'bars',
    from: 'Revenue Analysis',
    time: '2h ago',
  },
  {
    title: 'GTM Strategy Deck',
    type: 'Deck',
    span: 'row-span-4 col-span-2',
    fill: 'bg-charcoal',
    viz: 'deck',
    from: 'GTM Workbench',
    time: '4h ago',
  },
  {
    title: 'Daily Usage Metrics',
    type: 'Dataset',
    span: 'row-span-2',
    fill: 'bg-blue',
    viz: 'grid',
    from: 'Usage Chart',
    time: 'today',
  },
  {
    title: 'Faremeter v0.22 Notes',
    type: 'Document',
    span: 'row-span-3',
    fill: 'bg-cream',
    viz: 'lines',
    from: 'Release Notes',
    time: '1d ago',
  },
  {
    title: 'Network Map',
    type: 'Image',
    span: 'row-span-2',
    fill: 'bg-green',
    viz: 'nodes',
    from: 'Network Vaults',
    time: '1d ago',
  },
  {
    title: 'Ad Spend Breakdown',
    type: 'Chart',
    span: 'row-span-3',
    fill: 'bg-blue',
    viz: 'donut',
    from: 'Ad Campaign',
    time: '2d ago',
  },
  {
    title: 'Sentiment Heatmap',
    type: 'Chart',
    span: 'row-span-2',
    fill: 'bg-orange',
    viz: 'heat',
    from: 'WhatsApp Agent',
    time: '3d ago',
  },
  {
    title: 'Knowledge Base Index',
    type: 'Dataset',
    span: 'row-span-4',
    fill: 'bg-charcoal',
    viz: 'grid',
    from: 'Network Vaults',
    time: '3d ago',
  },
  {
    title: 'Brand QA Summary',
    type: 'Report',
    span: 'row-span-3',
    fill: 'bg-green',
    viz: 'lines',
    from: 'Brand Review',
    time: '4d ago',
  },
  {
    title: 'Content Calendar',
    type: 'Deck',
    span: 'row-span-3 col-span-2',
    fill: 'bg-blue',
    viz: 'cal',
    from: 'Content Pipeline',
    time: '5d ago',
  },
  {
    title: 'Funnel Conversion',
    type: 'Chart',
    span: 'row-span-2',
    fill: 'bg-orange',
    viz: 'bars',
    from: 'Revenue Analysis',
    time: '6d ago',
  },
  {
    title: 'Engagement Overview',
    type: 'Report',
    span: 'row-span-3',
    fill: 'bg-charcoal',
    viz: 'donut',
    from: 'GTM Workbench',
    time: '1w ago',
  },
];

const W = 'rgba(255,255,255,.9)';
const W2 = 'rgba(255,255,255,.45)';

function Viz({ kind }: { kind: VizKind }) {
  switch (kind) {
    case 'bars':
      return (
        <svg className="h-full w-full" viewBox="0 0 120 80" preserveAspectRatio="none">
          <rect x="14" y="44" width="14" height="30" fill={W2} />
          <rect x="36" y="30" width="14" height="44" fill={W} />
          <rect x="58" y="38" width="14" height="36" fill={W2} />
          <rect x="80" y="18" width="14" height="56" fill={W} />
        </svg>
      );
    case 'donut':
      return (
        <svg className="h-full w-full" viewBox="0 0 120 80">
          <circle cx="60" cy="40" r="24" fill="none" stroke={W2} strokeWidth="11" />
          <circle
            cx="60"
            cy="40"
            r="24"
            fill="none"
            stroke={W}
            strokeWidth="11"
            strokeDasharray="100 150"
            transform="rotate(-90 60 40)"
          />
        </svg>
      );
    case 'grid':
      return (
        <svg className="h-full w-full" viewBox="0 0 120 80">
          {Array.from({ length: 15 }).map((_, i) => (
            <rect
              key={i}
              x={12 + (i % 5) * 20}
              y={14 + Math.floor(i / 5) * 20}
              width="15"
              height="15"
              rx="2"
              fill={i % 3 ? W2 : W}
            />
          ))}
        </svg>
      );
    case 'lines':
      return (
        <svg className="h-full w-full" viewBox="0 0 120 80">
          {Array.from({ length: 5 }).map((_, i) => (
            <rect
              key={i}
              x="16"
              y={16 + i * 11}
              width={i % 2 ? 60 : 88}
              height="5"
              rx="2.5"
              fill={i ? W2 : W}
            />
          ))}
        </svg>
      );
    case 'nodes':
      return (
        <svg className="h-full w-full" viewBox="0 0 120 80">
          <line x1="30" y1="26" x2="70" y2="50" stroke={W2} strokeWidth="2" />
          <line x1="70" y1="50" x2="94" y2="24" stroke={W2} strokeWidth="2" />
          <line x1="30" y1="26" x2="40" y2="60" stroke={W2} strokeWidth="2" />
          <circle cx="30" cy="26" r="7" fill={W} />
          <circle cx="70" cy="50" r="9" fill={W} />
          <circle cx="94" cy="24" r="6" fill={W2} />
          <circle cx="40" cy="60" r="6" fill={W2} />
        </svg>
      );
    case 'heat':
      return (
        <svg className="h-full w-full" viewBox="0 0 120 80">
          {Array.from({ length: 24 }).map((_, i) => (
            <rect
              key={i}
              x={14 + (i % 6) * 16}
              y={16 + Math.floor(i / 6) * 13}
              width="13"
              height="10"
              rx="2"
              fill={`rgba(255,255,255,${(0.2 + ((i * 37) % 80) / 100).toFixed(2)})`}
            />
          ))}
        </svg>
      );
    case 'deck':
      return (
        <svg className="h-full w-full" viewBox="0 0 120 120">
          <rect x="22" y="20" width="76" height="46" rx="4" fill={W} />
          <rect x="30" y="30" width="40" height="6" rx="3" fill="rgba(43,38,39,.4)" />
          <rect x="30" y="42" width="56" height="4" rx="2" fill="rgba(43,38,39,.25)" />
          <rect x="22" y="74" width="36" height="26" rx="4" fill={W2} />
          <rect x="62" y="74" width="36" height="26" rx="4" fill={W2} />
        </svg>
      );
    case 'cal':
      return (
        <svg className="h-full w-full" viewBox="0 0 120 80">
          {Array.from({ length: 14 }).map((_, i) => (
            <rect
              key={i}
              x={12 + (i % 7) * 15}
              y={20 + Math.floor(i / 7) * 22}
              width="12"
              height="18"
              rx="2"
              fill={[2, 5, 9].includes(i) ? W : W2}
            />
          ))}
        </svg>
      );
  }
}

interface ArtifactGalleryProps {
  /** Bridge to the working intake flow (real Dashboard) until CL-988/Phase 4 wires it natively. */
  onNew?: () => void;
  /** When provided, renders a mobile-only control to open the library overlay. */
  onOpenLibrary?: () => void;
}

export function ArtifactGallery({ onNew, onOpenLibrary }: ArtifactGalleryProps) {
  return (
    <section className="flex min-h-full flex-col rounded-panel border border-border bg-bg shadow-[var(--shadow,0_2px_6px_rgba(0,0,0,0.3))]">
      <div className="flex items-center gap-[14px] px-4 pb-[14px] pt-5 sm:px-7">
        {onOpenLibrary && (
          <button
            type="button"
            onClick={onOpenLibrary}
            aria-label="Open library"
            className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[9px] border border-border text-text-2 transition-colors hover:bg-[var(--row-hover)] hover:text-text lg:hidden"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-[18px] w-[18px]"
            >
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        )}
        <h1 className="text-[21px] font-bold tracking-[-0.02em] text-text">Artifacts</h1>
        <span className="rounded-[7px] bg-surface-2 px-[9px] py-[3px] font-mono text-[12px] text-text-3">
          {SAMPLE_ARTIFACTS.length} items
        </span>
        <div className="flex-1" />
        <button
          type="button"
          className="flex items-center gap-[7px] rounded-[9px] border border-border px-[13px] py-[7px] text-[12.5px] font-semibold text-text-2 transition-colors hover:border-border-strong hover:bg-[var(--row-hover)]"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="h-3.5 w-3.5"
          >
            <path d="M3 6h18M6 12h12M10 18h4" />
          </svg>
          Sort
        </button>
        <button
          type="button"
          onClick={onNew}
          className="flex items-center gap-[7px] rounded-[9px] border border-charcoal bg-charcoal px-[13px] py-[7px] text-[12.5px] font-semibold text-cream transition-colors"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="h-3.5 w-3.5"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          New
        </button>
      </div>

      <div className="flex-1 px-4 pb-10 pt-1.5 sm:px-7 [container-type:inline-size]">
        <div className="grid auto-rows-[88px] grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-[var(--gap)] sm:grid-cols-[repeat(auto-fill,minmax(190px,1fr))]">
          {/* TODO(CL-986): key by stable artifact id once wired to real data. */}
          {SAMPLE_ARTIFACTS.map((a, i) => (
            <div
              key={a.title}
              className={`group relative flex cursor-pointer flex-col overflow-hidden rounded-lg border border-border bg-surface transition-transform duration-300 ease-spring hover:-translate-y-1.5 hover:rotate-[-1deg] hover:scale-[1.02] hover:border-border-strong ${a.span}`}
            >
              <span className="absolute left-[10px] top-[10px] z-[2] rounded-full bg-[rgba(0,0,0,0.32)] px-2 py-[3px] text-[10px] font-bold uppercase tracking-[0.03em] text-white backdrop-blur-[6px]">
                {a.type}
              </span>
              <div className={`relative grid flex-1 place-items-center overflow-hidden ${a.fill}`}>
                <div className="h-full w-full transition-transform duration-500 ease-spring group-hover:scale-[1.06]">
                  <Viz kind={a.viz} />
                </div>
                <span className="absolute bottom-[10px] right-3 font-mono text-[13px] font-bold text-[rgba(255,255,255,0.85)]">
                  {a.type[0]}
                  {(i + 1).toString().padStart(2, '0')}
                </span>
              </div>
              <div className="border-t border-border bg-surface px-[13px] py-[11px]">
                <div className="truncate text-[13.5px] font-semibold text-text">{a.title}</div>
                <div className="mt-0.5 flex items-center gap-[7px] font-mono text-[11px] text-text-3">
                  <span>{a.from}</span>·<span>{a.time}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
