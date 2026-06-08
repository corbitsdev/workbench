# @workbench/hub-crypto

Credential encryption/decryption for the hub. Wraps sensitive credential values before they hit the DB.

- Encryption must happen in this layer — never store plaintext credential values in `@intx/db` tables
- Do not expose key material; keys come from env vars validated at hub startup
- Used exclusively by `apps/hub` — not imported by frontend packages
