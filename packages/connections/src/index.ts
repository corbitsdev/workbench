// The library entry for `@workbench/connections`: PKCE/state primitives
// shared by every OAuth connect flow, the connector descriptor shape and
// registry (also reachable browser-side through the lighter
// `./registry` subpath — see that file's header comment), and the
// tenant-scoped route factory that tests and stores an api-key
// connector's credential.
export {
  createConnectStateStore,
  generatePKCEPair,
  s256Challenge,
  type ConnectStateStore,
  type PKCEPair,
} from "./pkce";
