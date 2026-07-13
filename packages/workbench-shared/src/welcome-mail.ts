/**
 * Copy for the one-time welcome mail delivered to a member's own inbox on
 * first provisioning (CL-3448). Kept here — not inlined in the hub — so the
 * message can be reviewed/edited without touching delivery logic, matching
 * how task-mail and mention-mail copy live alongside their domain packages.
 */

export type WelcomeMailArgs = {
  memberName: string;
};

export function welcomeMailSubject(): string {
  return "Welcome to your workbench";
}

export function welcomeMailBody(args: WelcomeMailArgs): string {
  const name = args.memberName.trim().length > 0 ? args.memberName : "there";
  return [
    `Hi ${name},`,
    "",
    "Myra is your personal agent here — this inbox is where she'll keep you posted.",
    "",
    "A few places to start:",
    "- Say hello to Myra and ask her what she can help with.",
    "- Your morning brief arrives automatically once a day; you can change the time in Settings.",
    "- Schedule a workflow to turn call data and research into ready-to-publish collateral.",
    "- Visit Settings to set Myra's autonomy — how much she prepares versus executes on your behalf.",
    "- Connect the tools you use (calendar, call notes, CRM) so Myra has real context to work with.",
    "",
    "Glad you're here.",
  ].join("\n");
}
