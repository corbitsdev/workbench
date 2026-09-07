# Posix tools (design note — not implemented)

Nothing under this name ships in workbench today. There is no
`@corbits/posix-tools` package anywhere in this tree. Upstream Interchange
does publish a real package in this space, `@intx/tools-posix` — its
`sidecar-bundle:run_shell` tool already appears in this repo's fixtures
(`packages/mocks/src/ollama/scenarios.ts`,
`vendor/intx/hub-sessions/src/event-collector.test.ts`) — but workbench
does not depend on it and has built no integration against it. Treat
everything below as a proposal for that integration, not a description of
current behavior.

The design: run only on a workbench placed on isolated capacity
(`sidecarPlacement` enabled, backed by a real `SidecarProvisioner`) — the
dedicated container is the sandbox boundary, so there is no in-process
sandboxing to build. Every write-capable tool it exposes (shell, write)
would declare `approval: "ask"`, so each call surfaces through the
existing human-approval path before it runs — no tool in this package
would ever get a standing auto-approve. The sandbox policy would be a
named, auditable, per-workbench setting, defaulting closed until an
operator opts a workbench in — never a single all-or-nothing flag. This
mirrors the pattern Interchange's own sidecar capability rules use:
capability is inert until named, scoped, and explicitly turned on.
