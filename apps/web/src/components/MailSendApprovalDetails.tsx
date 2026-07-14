import type { ApprovalDisplayLookups } from "../lib/approval-display";
import {
  formatMailboxAddress,
  humanizeApprovalValue,
  mailSendBodyText,
  type MailSendContext,
} from "../lib/approval-display";

type MailSendApprovalDetailsProps = {
  context: MailSendContext;
  lookups: ApprovalDisplayLookups;
  lookupsLoading?: boolean;
};

function formatRecipient(
  to: unknown,
  lookups: ApprovalDisplayLookups,
  lookupsLoading: boolean,
): string {
  if (typeof to !== "string" || to.trim() === "") return "Recipient";
  if (lookupsLoading) return "Recipient";
  return formatMailboxAddress(to, lookups);
}

export function MailSendApprovalDetails({
  context,
  lookups,
  lookupsLoading = false,
}: MailSendApprovalDetailsProps) {
  const recipient = formatRecipient(context.to, lookups, lookupsLoading);
  const subject =
    typeof context.subject === "string" && context.subject.trim() !== ""
      ? context.subject
      : null;
  const body = mailSendBodyText(context);
  const refs = Array.isArray(context.refs) ? context.refs : [];

  return (
    <div
      className="mt-3 flex flex-col gap-3 rounded-md border border-border bg-bg px-3.5 py-3"
      data-testid="mail-send-approval"
    >
      <div className="flex flex-col gap-0.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-text-3">
          To
        </span>
        <span className="text-[14px] font-semibold text-text">{recipient}</span>
      </div>
      {subject !== null ? (
        <div className="flex flex-col gap-0.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-text-3">
            Subject
          </span>
          <span className="text-[13px] text-text">{subject}</span>
        </div>
      ) : null}
      {body !== null ? (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-text-3">
            Message
          </span>
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-text-2">
            {body}
          </p>
        </div>
      ) : null}
      {refs.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-text-3">
            Related
          </span>
          <ul className="flex flex-col gap-0.5 text-[12px] text-text-2">
            {refs.map((ref, index) => {
              const row = humanizeApprovalValue(ref, lookups) as Record<
                string,
                unknown
              >;
              const label =
                typeof row.label === "string" && row.label.trim() !== ""
                  ? row.label
                  : typeof row.kind === "string"
                    ? row.kind
                    : "Link";
              return (
                <li key={`${label}-${String(index)}`} className="truncate">
                  {label}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
