import { CheckIcon } from 'lucide-react';

interface ReviewedArtifact {
  id: string;
  title: string;
}

// Pure presentational summary shown once every generated artifact has been
// reviewed. Receives only the approved artifacts; renders no data loading.
export function ReviewedArtifactsSummary({
  approvedArtifacts,
}: {
  approvedArtifacts: ReviewedArtifact[];
}) {
  return (
    <div className="flex-1 overflow-y-auto p-5 space-y-4">
      <div className="flex items-center gap-3">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-green/[0.18]">
          <CheckIcon className="h-4 w-4 text-green" />
        </div>
        <p className="text-[14px] font-semibold text-text">All artifacts reviewed</p>
      </div>
      {approvedArtifacts.length > 0 ? (
        <>
          <ul className="space-y-1.5">
            {approvedArtifacts.map((a) => (
              <li
                key={a.id}
                className="rounded-[8px] border border-border bg-surface px-3 py-2 text-[12px] text-text"
              >
                {a.title}
              </li>
            ))}
          </ul>
          <p className="text-[12px] text-text-3">
            Your approved pieces have been saved to Artifacts.
          </p>
        </>
      ) : (
        <p className="text-[12px] text-text-3">All pieces were denied. No artifacts were saved.</p>
      )}
    </div>
  );
}
