import {
  ChatInput,
  ChatThread,
  EmptyState,
  TopBar,
  TopBarTitle,
} from "@corbits/react-ui";
import type { AgentIdentity, ChatMessage } from "@corbits/react-ui";
import { MessageSquare } from "lucide-react";
import { useState } from "react";

const IDENTITY: AgentIdentity = { name: "Workbench" };
const NO_MESSAGES: readonly ChatMessage[] = [];

export function ChatPage() {
  const [draft, setDraft] = useState("");
  return (
    <>
      <TopBar>
        <TopBarTitle subtitle="Talk to an agent">Chat</TopBarTitle>
      </TopBar>
      <div className="page-body">
        <div className="chat-column">
          <ChatThread
            messages={NO_MESSAGES}
            identity={IDENTITY}
            empty={
              <EmptyState
                icon={<MessageSquare />}
                title="No conversation yet"
                description="This surface is ready for chat, but the hub does not expose a conversational agent endpoint yet, so there is nothing to send a message to."
              />
            }
          />
          <ChatInput
            value={draft}
            onValueChange={setDraft}
            onSend={() => undefined}
            disabled
            placeholder="Chat is not connected to an agent yet"
          />
        </div>
      </div>
    </>
  );
}
