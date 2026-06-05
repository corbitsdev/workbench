import { useParams } from 'react-router';

export default function WorkbenchPage() {
  const { slug } = useParams<{ slug: string }>();

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8">
      <div className="text-[14px] font-semibold text-text">{slug}</div>
      <div className="text-[13px] text-text-3">Workspace coming soon.</div>
    </div>
  );
}
