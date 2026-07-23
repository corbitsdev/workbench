export type TourPlacement = "top" | "bottom" | "left" | "right";

export type TourStep = {
  readonly id: string;
  readonly route: string;
  readonly targetSelector?: string;
  readonly title: string;
  readonly body: string;
  readonly placement: TourPlacement;
};

/**
 * The guided-tour registry: adding a workbench feature to onboarding is adding
 * a step object here. Each step routes to its page and anchors its popover to
 * a `data-tour` attribute; a missing target degrades to a centered popover.
 */
export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: "myra",
    route: "/",
    targetSelector: '[data-tour="myra-chat"]',
    title: "Meet Myra",
    body: "Myra is your personal agent. Ask her to research an account, draft collateral, or start a workflow.",
    placement: "top",
  },
  {
    id: "inbox",
    route: "/inbox",
    targetSelector: '[data-tour="nav-inbox"]',
    title: "Your Inbox",
    body: "Agents deliver briefs, approvals, and finished work here. Check it like email; anything that needs you lands in the Inbox.",
    placement: "right",
  },
  {
    id: "bell",
    route: "/inbox",
    targetSelector: '[data-tour="notifications-bell"]',
    title: "Notifications",
    body: "The bell lights up the moment an agent needs your attention, so you don't have to keep checking the Inbox.",
    placement: "bottom",
  },
  {
    id: "schedule",
    route: "/routines",
    title: "Schedule a workflow",
    body: "Routines puts any workflow on a daily cadence. Set one up once and the results arrive in your Inbox on schedule.",
    placement: "bottom",
  },
  {
    id: "autonomy",
    route: "/settings",
    targetSelector: '[data-tour="preference-agentAutonomy"]',
    title: "Set your autonomy",
    body: "Settings holds your preferences, including how much Myra does on her own: prepare work for you to review, or run it and pause only when your approval is needed.",
    placement: "top",
  },
];
