// CL-6568: the pre-send half of the fix. A tenant whose one seeded
// `model_provider` row carries no credential (the shape seeding always
// leaves behind) can't run inference — the composer stays live (a person
// may still want to leave a note), but this banner says so before they
// invest a long message in a reply that was never coming, and leads
// straight into the connect flow that already works
// (`@corbits/settings-ui`'s `ConnectionsSection`).
import { Button } from "@corbits/react-ui";
import { WarningCircle } from "@corbits/icons";
import { CHAT_STRINGS } from "./strings";

export function NoUsableModelBanner({
  onConnectModel,
}: {
  readonly onConnectModel: () => void;
}) {
  return (
    <div className="chat-no-model-banner" role="status">
      <WarningCircle aria-hidden="true" />
      <span className="chat-no-model-banner-text">
        {CHAT_STRINGS.noUsableModelBannerText}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onConnectModel}
      >
        {CHAT_STRINGS.noUsableModelBannerAction}
      </Button>
    </div>
  );
}
