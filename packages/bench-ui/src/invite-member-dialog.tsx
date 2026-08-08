// The invite affordance over the native
// `POST /api/tenants/:tenantId/members/invite` route: email in, nothing
// else — the route only accepts an existing account's email today, so this
// never collects a name or offers to create one.

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

import { BENCH_STRINGS } from "./strings";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function canInviteMember(email: string): boolean {
  return EMAIL_PATTERN.test(email.trim());
}

export function InviteMemberDialog({
  open,
  onOpenChange,
  onInvite,
  submitting,
  error = null,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onInvite: (email: string) => void;
  readonly submitting: boolean;
  readonly error?: string | null;
}) {
  const [email, setEmail] = useState("");
  const canSubmit = canInviteMember(email);

  function reset() {
    setEmail("");
  }

  function handleSubmit() {
    if (canSubmit) onInvite(email.trim());
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
          <DialogTitle>{BENCH_STRINGS.inviteMemberDialogTitle}</DialogTitle>
          <DialogDescription>
            {BENCH_STRINGS.inviteMemberDialogDescription}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form
            id="invite-member-form"
            className="bench-form"
            onSubmit={(event) => {
              event.preventDefault();
              handleSubmit();
            }}
          >
            <label className="bench-form-field">
              <span>{BENCH_STRINGS.inviteMemberEmailLabel}</span>
              <Input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder={BENCH_STRINGS.inviteMemberEmailPlaceholder}
                autoFocus
              />
            </label>
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
            {BENCH_STRINGS.inviteMemberCancel}
          </Button>
          <Button
            type="submit"
            form="invite-member-form"
            variant="primary"
            disabled={!canSubmit || submitting}
          >
            {submitting
              ? BENCH_STRINGS.inviteMemberInviting
              : BENCH_STRINGS.inviteMemberSubmit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
