# Security Policy

commons-crew runs agent-backed specialist workers (crew-runner) against provider APIs. No API keys, provider credentials, or connector secrets belong in this repository — configuration shape lives in-repo; the secrets that back it are deployment-specific and injected at runtime via environment or a secret store. Do not commit a usable secret under any circumstance.

## Reporting

For security concerns related to commons-crew or the wider OLF platform, see the full policy in [open-labor-foundation](https://github.com/Open-Labor-Foundation/open-labor-foundation/blob/main/SECURITY.md).

Report vulnerabilities to **[security@openlabor.foundation](mailto:security@openlabor.foundation)**.
