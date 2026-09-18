// Says so before a person invests a long message in a reply that was
// never coming; the composer stays live since they may still want a note.
import { Button } from "@corbits/react-ui";
import { WarningCircle } from "@/lib/icons";
import { CHAT_STRINGS } from "./strings";

export function NoUsableModelBanner({ onConnectModel }: { readonly onConnectModel: () => void }) {
  return (
    <div className="chat-no-model-banner" role="status">
      <WarningCircle aria-hidden="true" />
      <span className="chat-no-model-banner-text">{CHAT_STRINGS.noUsableModelBannerText}</span>
      <Button type="button" variant="outline" size="sm" onClick={onConnectModel}>
        {CHAT_STRINGS.noUsableModelBannerAction}
      </Button>
    </div>
  );
}
