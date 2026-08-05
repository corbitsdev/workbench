# Security Policy

## Reporting a Vulnerability

Please report security issues through [GitHub private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) on this repository (Security tab → Report a vulnerability).

Do not open a public issue for security reports.

We will acknowledge reports as soon as practical and work with you on a fix and
disclosure timeline.

## Scope Notes

Corbits Workbench runs AI agents alongside humans, with every external side
effect gated behind human approval. Treat any way around that gate as
security-relevant, including:

- an agent producing an external side effect without a human approving it
- credential or secret exposure through any surface
- a sandboxed component reaching capabilities it was never granted

When reporting, include:

- Workbench version or commit
- Steps to reproduce
- Expected vs actual behavior
- Whether the issue requires a malicious prompt, module, workflow, or
  configuration
