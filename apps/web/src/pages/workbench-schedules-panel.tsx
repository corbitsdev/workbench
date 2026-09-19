// A workbench's cron schedules. A schedule targets an agent by its
// definition name, so it waits out the gaps between the agent's runs — and
// only a deleted agent stops the row for good.

import { Button, Input, Select, Skeleton, formatRelativeTime } from "@corbits/react-ui";
import { cronSentence } from "@corbits/workflows/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { displayAgentName } from "@/chat/threads-api";
import type { WorkbenchParticipant } from "@/chat/threads-api";
import { describeApiError } from "@/lib/api-query";
import {
  UnknownDefinitionError,
  createCronSchedule,
  deleteCronSchedule,
  listCronSchedules,
  type CronSchedule,
} from "../routines-api";
import { tenantKeys } from "../query-client";

type FormState = {
  readonly definitionName: string;
  readonly expression: string;
  readonly body: string;
};

const EMPTY_FORM: FormState = { definitionName: "", expression: "", body: "" };

function scheduleError(cause: unknown): string {
  if (cause instanceof UnknownDefinitionError) {
    return "No agent here carries that name any more. Pick another agent.";
  }
  return describeApiError(cause, "saving this schedule");
}

function stoppedNote(schedule: CronSchedule): string {
  const reason =
    schedule.stoppedReason === "agent_deleted"
      ? "its agent was deleted"
      : (schedule.stoppedReason ?? "it was stopped");
  return `Stopped — ${reason}. A redeploy doesn't resume it.`;
}

export function WorkbenchSchedulesPanel({
  workbenchTenantId,
  participants,
}: {
  readonly workbenchTenantId: string;
  readonly participants: readonly WorkbenchParticipant[];
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [open, setOpen] = useState(false);

  const agents = participants.filter(
    (p): p is WorkbenchParticipant & { assetName: string } =>
      p.kind === "agent" && p.assetName !== undefined,
  );

  const schedules = useQuery({
    queryKey: tenantKeys.schedules(workbenchTenantId),
    queryFn: () => listCronSchedules(workbenchTenantId),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: tenantKeys.schedules(workbenchTenantId) });

  const create = useMutation({
    mutationFn: (input: FormState) =>
      createCronSchedule(workbenchTenantId, {
        expression: input.expression.trim(),
        definitionName: input.definitionName,
        subject: "Scheduled run",
        body: input.body.trim(),
      }),
    onSuccess: async () => {
      setForm(EMPTY_FORM);
      setOpen(false);
      await invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteCronSchedule(workbenchTenantId, id),
    onSuccess: () => invalidate(),
  });

  const blocked =
    form.definitionName === ""
      ? "Pick an agent to continue."
      : form.expression.trim() === ""
        ? "Add a cron expression to continue."
        : form.body.trim() === ""
          ? "Say what the agent should do."
          : null;

  const rows = schedules.data ?? [];

  return (
    <section className="workbench-info-panel">
      <div className="workbench-info-panel-header">
        <h2>Schedules</h2>
        <Button variant="ghost" size="sm" onClick={() => setOpen(!open)}>
          {open ? "Close" : "New"}
        </Button>
      </div>

      {schedules.isLoading ? <Skeleton className="h-16 w-full" /> : null}
      {schedules.isError ? (
        <p className="workbench-info-empty-note">
          {describeApiError(schedules.error, "loading schedules")}
        </p>
      ) : null}
      {!schedules.isLoading && !schedules.isError && rows.length === 0 ? (
        <p className="workbench-info-empty-note">Nothing scheduled here yet.</p>
      ) : null}

      {rows.length > 0 ? (
        <ul className="workbench-info-schedule-list">
          {rows.map((schedule) => (
            <li key={schedule.id} data-stopped={schedule.stoppedAt !== null}>
              <span className="workbench-info-cell-primary">
                {displayAgentName(schedule.definitionName)}
              </span>
              <br />
              <span className="workbench-info-cell-context">
                {cronSentence(schedule.expression) ?? schedule.expression}
                {schedule.lastFiredAt === null
                  ? ""
                  : ` · last ran ${formatRelativeTime(schedule.lastFiredAt)}`}
              </span>
              {schedule.stoppedAt === null ? (
                schedule.waitingSince === null ? null : (
                  <>
                    <br />
                    <span className="workbench-info-cell-context" role="status">
                      {`Waiting for its agent to come back — since ${formatRelativeTime(schedule.waitingSince)}.`}
                    </span>
                  </>
                )
              ) : (
                <>
                  <br />
                  <span className="workbench-info-cell-context" role="status">
                    {stoppedNote(schedule)}
                  </span>
                </>
              )}
              <div className="mt-1 flex gap-2">
                {schedule.stoppedAt === null ? null : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setForm({
                        definitionName: schedule.definitionName,
                        expression: schedule.expression,
                        body: schedule.body,
                      });
                      setOpen(true);
                    }}
                  >
                    Schedule again
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => remove.mutate(schedule.id)}
                  disabled={remove.isPending}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {open ? (
        <div className="mt-3 flex flex-col gap-2">
          {create.isError ? (
            <p className="text-sm text-destructive" role="alert">
              {scheduleError(create.error)}
            </p>
          ) : null}
          <Select
            aria-label="Agent"
            value={form.definitionName}
            onChange={(event) => setForm({ ...form, definitionName: event.target.value })}
          >
            <option value="">Pick an agent…</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.assetName}>
                {agent.name}
              </option>
            ))}
          </Select>
          <Input
            aria-label="Cron expression"
            placeholder="0 9 * * 1"
            value={form.expression}
            onChange={(event) => setForm({ ...form, expression: event.target.value })}
          />
          <Input
            aria-label="What to do"
            placeholder="Summarize yesterday's activity."
            value={form.body}
            onChange={(event) => setForm({ ...form, body: event.target.value })}
          />
          <Button
            type="button"
            onClick={() => {
              if (blocked === null) create.mutate(form);
            }}
            disabled={create.isPending || blocked !== null}
          >
            {create.isPending ? "Saving…" : (blocked ?? "Schedule")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
