// Every live fact — connected or not, which auth mode applies — is
// resolved by the host, never authored by the agent.

export type ConnectAffordance = "oauth" | "keyless" | "api-key";

export type ConnectServiceQuery =
  | { readonly kind: "loading" }
  | {
      readonly kind: "disconnected";
      readonly affordance: ConnectAffordance;
      /** Where the key on the key-paste arm comes from, when the host
       * knows — the descriptor's docs page. */
      readonly docsUrl?: string;
    }
  | { readonly kind: "connected" }
  | { readonly kind: "error"; readonly message: string };

export type ConnectServiceResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export interface ConnectServiceActions {
  getConnectState(connectorId: string): Promise<ConnectServiceQuery>;
  subscribeConnectState(
    connectorId: string,
    listener: (query: ConnectServiceQuery) => void,
  ): () => void;
  // Called on a `chat.settings` event so a mounted card flips without
  // remounting.
  notifySettingsChanged(): Promise<void>;
  /** One-click connect: starts the hosted OAuth hand-off (navigating
   * away and back) or completes a keyless preset in place. */
  connect(connectorId: string): Promise<ConnectServiceResult>;
  submitKey(connectorId: string, key: string): Promise<ConnectServiceResult>;
}
