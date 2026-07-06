// The dashboard "Caption" style section label (Red Hat Display uppercase),
// shared by the Insights dashboard and its sections so the heading treatment is
// defined once. Space Mono is reserved for true data readouts elsewhere.
export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-3">
      {children}
    </h2>
  );
}
