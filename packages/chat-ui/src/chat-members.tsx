import { useId } from "react";
import {
  Avatar,
  Button,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  useDismissablePopover,
} from "@corbits/react-ui";
import { CaretDown, DotsThree, Plus } from "@corbits/icons";

import type { WorkbenchAgent } from "./api";
import { CorbitAvatar } from "./avatar";
import type { TeamAvatarEntry } from "./chat-workspace";
import { localPartOf } from "./timeline";

export function ChatMembers({
  members,
  agents,
  currentUserPrincipalId,
  onInvite,
  onEditAgent,
}: {
  readonly members: readonly TeamAvatarEntry[];
  readonly agents: readonly WorkbenchAgent[];
  readonly currentUserPrincipalId: string | undefined;
  readonly onInvite: (() => void) | undefined;
  readonly onEditAgent: ((definitionId: string) => void) | undefined;
}) {
  const { open, setOpen, rootRef, triggerRef, close } = useDismissablePopover<
    HTMLDivElement,
    HTMLButtonElement
  >();
  const panelId = useId();
  const agentCount = members.filter((member) => member.tone === "agent").length;
  const peopleCount = members.length - agentCount;
  const representatives = [
    members.find((member) => member.tone === "agent"),
    members.find((member) => member.tone === "neutral"),
  ].filter((member) => member !== undefined);

  const preview =
    representatives.length === 2 ? representatives : members.slice(0, 2);

  return (
    <div ref={rootRef} className="relative">
      <Button
        ref={triggerRef}
        variant="ghost"
        className="gap-3 rounded-lg bg-muted px-3"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${members.length} ${members.length === 1 ? "member" : "members"}`}
        onClick={() => setOpen(!open)}
      >
        <span
          className="chat-member-stack flex items-center"
          aria-hidden="true"
        >
          {preview.map((member, index) => (
            <span
              key={member.key}
              title={member.label}
              data-agent={member.tone === "agent" ? "true" : undefined}
              className={`member-avatar relative flex size-6 shrink-0 items-center justify-center ${index === 0 ? "z-10" : "-ml-1.5"}`}
            >
              {member.tone === "agent" ? (
                <CorbitAvatar
                  size="sm"
                  ariaLabel={member.label}
                  className="[&_svg]:!size-full"
                />
              ) : (
                <Avatar
                  size="sm"
                  initials={member.initials}
                  label={member.label}
                  className={`rounded-full ${member.avatarClassName ?? ""}`}
                />
              )}
            </span>
          ))}
        </span>
        <span className="border-l border-border pl-3 text-sm font-normal">
          {members.length} {members.length === 1 ? "member" : "members"}
        </span>
        <CaretDown
          aria-hidden="true"
          className="size-4 text-muted-foreground"
        />
      </Button>
      {open ? (
        <section
          id={panelId}
          aria-label="Members"
          className="fixed inset-x-4 z-50 mt-2 sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:w-80 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg"
        >
          <h2 className="text-base font-semibold">Members</h2>
          <p className="text-sm text-muted-foreground">
            {peopleCount} {peopleCount === 1 ? "person" : "people"} ·{" "}
            {agentCount} {agentCount === 1 ? "agent" : "agents"}
          </p>
          <ul className="my-3 max-h-72 overflow-y-auto">
            {members.map((member) => {
              const self =
                member.tone === "neutral" &&
                localPartOf(member.key) === currentUserPrincipalId;
              const agent = agents.find(
                (candidate) => candidate.address === member.key,
              );
              const editable = agent !== undefined && onEditAgent !== undefined;
              return (
                <li
                  key={member.key}
                  className="chat-member-row flex items-start gap-3 rounded-md px-2 py-2 transition-colors hover:bg-muted focus-within:bg-muted"
                >
                  {member.tone === "agent" ? (
                    <CorbitAvatar size="lg" ariaLabel={member.label} />
                  ) : (
                    <Avatar
                      size="lg"
                      initials={member.initials}
                      label={member.label}
                      className={`rounded-full ${member.avatarClassName ?? ""}`}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">
                      {member.label}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {self
                        ? "You"
                        : member.tone === "agent"
                          ? "Agent"
                          : "Member"}
                    </p>
                  </div>
                  {editable ? (
                    <Menu>
                      <MenuTrigger asChild>
                        <button
                          type="button"
                          aria-label={`Actions for ${member.label}`}
                          className="flex min-h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                        >
                          <DotsThree aria-hidden="true" className="size-5" />
                        </button>
                      </MenuTrigger>
                      <MenuContent
                        align="start"
                        onEscapeKeyDown={(event) => event.stopPropagation()}
                        onCloseAutoFocus={(event) => {
                          if (open) return;
                          event.preventDefault();
                          triggerRef.current?.focus();
                        }}
                        onPointerDown={(event) => event.stopPropagation()}
                      >
                        <MenuItem
                          onSelect={() => {
                            close();
                            onEditAgent(agent.definitionId);
                          }}
                        >
                          Edit agent
                        </MenuItem>
                      </MenuContent>
                    </Menu>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {onInvite !== undefined ? (
            <div className="border-t border-border pt-3">
              <Button
                className="w-full"
                onClick={() => {
                  close();
                  onInvite();
                }}
              >
                <Plus aria-hidden="true" />
                Add member
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
