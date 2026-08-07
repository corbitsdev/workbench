// The "new channel" affordance: name + kind, behind a small centered dialog
// triggered from the sidebar.

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

import type { ChannelKind } from "./api";
import { CHAT_STRINGS } from "./strings";

export function NewChannelDialog({
  open,
  onOpenChange,
  onCreate,
  submitting,
  error = null,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreate: (input: { name: string; kind: ChannelKind }) => void;
  readonly submitting: boolean;
  readonly error?: string | null;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ChannelKind>("channel");

  function reset() {
    setName("");
    setKind("channel");
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
          <DialogTitle>{CHAT_STRINGS.newChannelDialogTitle}</DialogTitle>
          <DialogDescription>
            {CHAT_STRINGS.newChannelDialogDescription}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form
            id="new-channel-form"
            className="chat-new-channel-form"
            onSubmit={(event) => {
              event.preventDefault();
              const trimmed = name.trim();
              if (trimmed.length === 0) return;
              onCreate({ name: trimmed, kind });
            }}
          >
            <label className="chat-form-field">
              <span>{CHAT_STRINGS.newChannelNameLabel}</span>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={CHAT_STRINGS.newChannelNamePlaceholder}
                autoFocus
              />
            </label>
            <fieldset className="chat-form-field">
              <legend>{CHAT_STRINGS.newChannelKindLabel}</legend>
              <label className="chat-radio-option">
                <input
                  type="radio"
                  name="kind"
                  checked={kind === "channel"}
                  onChange={() => setKind("channel")}
                />
                {CHAT_STRINGS.newChannelKindChannel}
              </label>
              <label className="chat-radio-option">
                <input
                  type="radio"
                  name="kind"
                  checked={kind === "chat"}
                  onChange={() => setKind("chat")}
                />
                {CHAT_STRINGS.newChannelKindChat}
              </label>
            </fieldset>
            {error !== null && (
              <p className="chat-dialog-error" role="alert">
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
            {CHAT_STRINGS.newChannelCancel}
          </Button>
          <Button
            type="submit"
            form="new-channel-form"
            variant="primary"
            disabled={name.trim().length === 0 || submitting}
          >
            {CHAT_STRINGS.newChannelSubmit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
