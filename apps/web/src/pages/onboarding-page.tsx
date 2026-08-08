// Landing point for a session the first-login hook just provisioned a
// personal bench for. Renaming the bench and choosing a starter channel
// are both server-side decisions `@workbench/onboarding` already made
// during provisioning (see that package's provision.ts) — this screen's
// job is just the guidance half of first-run: a fast orientation to the
// three things new to every arrival (channels, routines, the library)
// and how to bring an agent into a conversation, before landing in the
// channel that provisioning already created.

import {
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  PageShell,
  Section,
} from "@corbits/react-ui";
import { AtSign, Bot, Library, MessageSquare } from "lucide-react";

import { Link } from "../navigation";

const GUIDANCE_CARDS = [
  {
    icon: <MessageSquare />,
    title: "Channels",
    description:
      "Conversations with your team and your agents live in channels, the same way threads do — a starter channel is ready for you below.",
  },
  {
    icon: <Bot />,
    title: "Routines",
    description:
      "A routine is a workflow an agent runs on your behalf — scheduled, triggered, or kicked off right from chat. Runs show up under Runs as they execute.",
  },
  {
    icon: <Library />,
    title: "Library",
    description:
      "Every workflow definition running anywhere in your benches is browsable in the Library, so you can see what a routine actually does before trusting it.",
  },
  {
    icon: <AtSign />,
    title: "@mention an agent",
    description:
      "Type @ in any channel to bring an agent into the conversation — it reads the thread and replies inline, just like a teammate would.",
  },
] as const;

export function OnboardingPage() {
  return (
    <PageShell width="full" className="page-fill">
      <Section
        title="Your workbench is ready"
        description="We've set up a personal bench for you with a starter channel and the default workflows deployed. Here's what to expect."
      >
        <div className="card-grid">
          {GUIDANCE_CARDS.map((card) => (
            <Card key={card.title}>
              <CardHeader>
                {card.icon}
                <CardTitle>{card.title}</CardTitle>
                <CardDescription>{card.description}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
        <Button asChild>
          <Link to="/chat">Go to your starter channel</Link>
        </Button>
      </Section>
    </PageShell>
  );
}
