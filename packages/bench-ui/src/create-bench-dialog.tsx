// The "new workbench" affordance: type cards (global vs sub), name, purpose,
// derived slug preview, and a join-policy note that reflects operator signup
// defaults. Create still posts only the name — inheritance and join policy
// storage are not on the hub yet.

import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@corbits/react-ui";
import { useState } from "react";

import { canCreateBench, deriveBenchSlug } from "./membership";
import { BENCH_STRINGS } from "./strings";

export type BenchCreateType = "global" | "sub";

export function CreateBenchDialog({
  open,
  onOpenChange,
  onCreate,
  submitting,
  error = null,
  signupOpen = false,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreate: (name: string) => void;
  readonly submitting: boolean;
  readonly error?: string | null;
  /** When true, join-policy copy reflects open signup; otherwise invites-only. */
  readonly signupOpen?: boolean;
}) {
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [benchType, setBenchType] = useState<BenchCreateType>("global");
  const slug = deriveBenchSlug(name);
  const canSubmit = canCreateBench(name);

  function reset() {
    setName("");
    setPurpose("");
    setBenchType("global");
  }

  function handleSubmit() {
    if (canSubmit) onCreate(name.trim());
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{BENCH_STRINGS.createBenchDialogTitle}</DialogTitle>
          <DialogDescription>
            {BENCH_STRINGS.createBenchDialogDescription}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form
            id="create-bench-form"
            className="bench-form"
            onSubmit={(event) => {
              event.preventDefault();
              handleSubmit();
            }}
          >
            <div className="bench-form-field">
              <span>{BENCH_STRINGS.createBenchTypeLabel}</span>
              <div
                role="group"
                aria-label={BENCH_STRINGS.createBenchTypeLabel}
                className="bench-kind-grid"
              >
                <button
                  type="button"
                  className="bench-kind-card"
                  aria-pressed={benchType === "global"}
                  onClick={() => setBenchType("global")}
                >
                  <span className="bench-kind-card-title">
                    {BENCH_STRINGS.createBenchTypeGlobal}
                  </span>
                  <span className="bench-kind-card-desc">
                    {BENCH_STRINGS.createBenchTypeGlobalDesc}
                  </span>
                </button>
                <button
                  type="button"
                  className="bench-kind-card"
                  aria-pressed={benchType === "sub"}
                  onClick={() => setBenchType("sub")}
                >
                  <span className="bench-kind-card-title">
                    {BENCH_STRINGS.createBenchTypeSub}
                  </span>
                  <span className="bench-kind-card-desc">
                    {BENCH_STRINGS.createBenchTypeSubDesc}
                  </span>
                </button>
              </div>
            </div>
            <label className="bench-form-field">
              <span>{BENCH_STRINGS.createBenchNameLabel}</span>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={BENCH_STRINGS.createBenchNamePlaceholder}
                autoFocus
              />
            </label>
            <label className="bench-form-field">
              <span>{BENCH_STRINGS.createBenchPurposeLabel}</span>
              <textarea
                className="bench-textarea"
                value={purpose}
                onChange={(event) => setPurpose(event.target.value)}
                placeholder={BENCH_STRINGS.createBenchPurposePlaceholder}
                rows={2}
              />
            </label>
            {slug.length > 0 && (
              <p className="bench-slug-preview">
                {BENCH_STRINGS.createBenchSlugPreviewLabel}: {slug}
              </p>
            )}
            <p className="bench-join-policy">
              <strong>{BENCH_STRINGS.createBenchJoinPolicyLabel}: </strong>
              {signupOpen
                ? BENCH_STRINGS.createBenchJoinPolicyOpen
                : BENCH_STRINGS.createBenchJoinPolicyClosed}
            </p>
            {error !== null && (
              <p className="bench-dialog-error" role="alert">
                {error}
              </p>
            )}
          </form>
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {BENCH_STRINGS.createBenchCancel}
          </Button>
          <Button
            type="submit"
            form="create-bench-form"
            variant="primary"
            disabled={!canSubmit || submitting}
          >
            {BENCH_STRINGS.createBenchSubmit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
