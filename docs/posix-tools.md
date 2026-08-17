# Posix tools (design note)

`@corbits/posix-tools` runs only on a workbench placed on isolated capacity
(`sidecarPlacement` enabled, backed by a real `SidecarProvisioner`) — the
dedicated container is the sandbox boundary, so there is no in-process
sandboxing to build. Tool set: `shell`, `read`, `write`, `glob`, `grep`.
Every write-capable tool (`shell`, `write`) declares `approval: "ask"`, so
each call surfaces through the existing human-approval path before it runs
— no tool in this package ever gets a standing auto-approve. The sandbox
policy is a named, auditable, per-workbench setting (alongside
`sidecarPlacement`), defaulting closed until an operator opts a workbench
in — never a single all-or-nothing flag. This mirrors the same pattern
already used for exclusive sidecar placement itself: capability is inert
until named, scoped, and explicitly turned on.
