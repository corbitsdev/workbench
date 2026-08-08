// The "new bench" affordance: a name, with the derived slug shown as a
// preview so the address a bench will be created at is never a surprise.

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

export function CreateBenchDialog({
  open,
  onOpenChange,
  onCreate,
  submitting,
  error = null,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreate: (name: string) => void;
  readonly submitting: boolean;
  readonly error?: string | null;
}) {
  const [name, setName] = useState("");
  const slug = deriveBenchSlug(name);
  const canSubmit = canCreateBench(name);

  function reset() {
    setName("");
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
            <label className="bench-form-field">
              <span>{BENCH_STRINGS.createBenchNameLabel}</span>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={BENCH_STRINGS.createBenchNamePlaceholder}
                autoFocus
              />
            </label>
            {slug.length > 0 && (
              <p className="bench-slug-preview">
                {BENCH_STRINGS.createBenchSlugPreviewLabel}: {slug}
              </p>
            )}
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
