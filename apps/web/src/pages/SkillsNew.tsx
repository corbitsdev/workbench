import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, FileArchive, Upload } from 'lucide-react';
import { useCreateSkill, useSkillShareTargets } from '../hooks/use-skills';
import { getMe } from '../lib/hub-api';

type FileWithRelativePath = File & { webkitRelativePath?: string };

const PRIVATE_CHOICE = 'private';

export function SkillsNew() {
  const navigate = useNavigate();
  const meQuery = useQuery({ queryKey: ['me'], queryFn: getMe, staleTime: 5 * 60_000 });
  const tenantId = meQuery.data?.personalTenantId ?? null;
  const shareTargetsQuery = useSkillShareTargets(tenantId);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [accessChoice, setAccessChoice] = useState<string>(PRIVATE_CHOICE);
  const createSkill = useCreateSkill();

  const accessFor = (choice: string) => {
    if (choice === PRIVATE_CHOICE) {
      return { scope: 'private' as const, tenantId };
    }
    return { scope: 'tenant' as const, tenantId: choice };
  };

  const savePastedSkill = () => {
    setError('');
    const access = accessFor(accessChoice);
    createSkill.mutate(
      { tenantId: access.tenantId, scope: access.scope, name: name.trim(), text: text.trim() },
      {
        onSuccess: () => navigate('/skills'),
        onError: (err) => setError(err instanceof Error ? err.message : 'Failed to save skill'),
      }
    );
  };

  const saveFiles = (files: FileList | null, folder: boolean) => {
    setError('');
    const selectedFiles = Array.from(files ?? []) as FileWithRelativePath[];
    if (selectedFiles.length === 0) return;
    const first = selectedFiles[0];
    const inferredName = folder
      ? (first.webkitRelativePath?.split('/')[0] ?? first.name.replace(/\.[^.]+$/, ''))
      : first.name.replace(/\.[^.]+$/, '');
    const access = accessFor(accessChoice);
    createSkill.mutate(
      {
        tenantId: access.tenantId,
        scope: access.scope,
        name: name.trim() || inferredName,
        files: selectedFiles.map((file) => ({
          file,
          path: folder ? file.webkitRelativePath || file.name : file.name,
        })),
      },
      {
        onSuccess: () => navigate('/skills'),
        onError: (err) => setError(err instanceof Error ? err.message : 'Failed to save skill'),
      }
    );
  };

  return (
    <div className="flex h-full overflow-hidden bg-bg">
      <div className="flex flex-1 flex-col overflow-hidden rounded-panel border border-border bg-bg">
        <div className="flex items-center justify-between gap-3 border-b border-border bg-surface px-5 py-3 shrink-0">
          <div className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-text-3" />
            <p className="text-[14px] font-semibold text-text">New Skill</p>
          </div>
          <button
            type="button"
            onClick={() => navigate('/skills')}
            className="text-[12px] text-text-3 hover:text-text"
          >
            Cancel
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-6">
          <div className="mx-auto max-w-2xl space-y-4">
            <div>
              <p className="text-[13px] text-text-3">
                Paste markdown, upload one file, upload a folder, or import a zip. Code and assets
                are stored but never executed.
              </p>
            </div>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Skill name (required for pasted text; uploads can infer it)"
              className="w-full rounded-[9px] border border-border bg-surface px-3 py-2 text-[13px] text-text placeholder-text-3 focus:outline-none focus:ring-1 focus:ring-orange/40"
            />
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Paste a single-file markdown skill..."
              rows={10}
              className="w-full resize-none rounded-[9px] border border-border bg-surface px-3 py-2 text-[13px] text-text placeholder-text-3 focus:outline-none focus:ring-1 focus:ring-orange/40"
            />
            <fieldset className="rounded-[12px] border border-border bg-surface p-4 space-y-2">
              <legend className="px-1 text-[13px] font-medium text-text">
                Who can access this skill?
              </legend>
              <label className="flex items-center gap-2 text-[13px] text-text-2">
                <input
                  type="radio"
                  name="skill-access"
                  value={PRIVATE_CHOICE}
                  checked={accessChoice === PRIVATE_CHOICE}
                  onChange={() => setAccessChoice(PRIVATE_CHOICE)}
                  className="accent-orange"
                />
                Just Me
              </label>
              {(shareTargetsQuery.data ?? []).map((target) => (
                <label
                  key={target.tenantId}
                  className="flex items-center gap-2 text-[13px] text-text-2"
                >
                  <input
                    type="radio"
                    name="skill-access"
                    value={target.tenantId}
                    checked={accessChoice === target.tenantId}
                    onChange={() => setAccessChoice(target.tenantId)}
                    className="accent-orange"
                  />
                  Everyone in {target.name}
                </label>
              ))}
            </fieldset>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={savePastedSkill}
                disabled={createSkill.isPending}
                className="btn-primary disabled:opacity-50"
              >
                Save pasted skill
              </button>
              <label className="cursor-pointer rounded-[9px] border border-border px-3 py-2 text-[13px] font-medium text-text-2 hover:text-text">
                <Upload className="mr-1 inline h-3.5 w-3.5" /> Upload file
                <input
                  type="file"
                  className="hidden"
                  onChange={(event) => saveFiles(event.currentTarget.files, false)}
                />
              </label>
              <label className="cursor-pointer rounded-[9px] border border-border px-3 py-2 text-[13px] font-medium text-text-2 hover:text-text">
                <Upload className="mr-1 inline h-3.5 w-3.5" /> Upload folder
                <input
                  type="file"
                  multiple
                  // @ts-expect-error webkitdirectory is required for browser folder selection.
                  webkitdirectory=""
                  className="hidden"
                  onChange={(event) => saveFiles(event.currentTarget.files, true)}
                />
              </label>
              <label className="cursor-pointer rounded-[9px] border border-border px-3 py-2 text-[13px] font-medium text-text-2 hover:text-text">
                <FileArchive className="mr-1 inline h-3.5 w-3.5" /> Import zip
                <input
                  type="file"
                  accept=".zip,application/zip"
                  className="hidden"
                  onChange={(event) => saveFiles(event.currentTarget.files, false)}
                />
              </label>
            </div>
            {error && <p className="text-[12px] text-orange-deep">{error}</p>}

            <div className="rounded-[12px] border border-border bg-surface p-4 space-y-2">
              <p className="text-[13px] font-medium text-text">Safety model</p>
              <ul className="space-y-1 text-[12px] text-text-3">
                <li>Immutable versions keep old workflow runs reproducible.</li>
                <li>Non-text files are stored as assets and not prompt-injected.</li>
                <li>Code-like files are allowed as inert bundle contents only.</li>
                <li>
                  Unsafe paths, symlinks, traversal, and empty bundles are rejected server-side.
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
