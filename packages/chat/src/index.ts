export const CHAT_PACKAGE_NAME = "@corbits/chat";

export {
  TextPart,
  ReasoningPart,
  ToolTracePart,
  BlockPart,
  FilePart,
  EventPart,
  Part,
  parsePart,
} from "./parts";
export { encodeParts, decodeParts, decodeMail } from "./codec";
export type { MailContent, MailReadContent, FetchBlob } from "./codec";
