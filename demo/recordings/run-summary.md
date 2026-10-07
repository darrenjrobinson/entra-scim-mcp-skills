# Recording run 2026-10-06T06:38:03Z

Model claude-fable-5-1 (effort xhigh) · Claude Code 2.1.268 · entra-scim-mcp 0.3.0 · policy contoso-lifecycle-policy v1.2.0 · seed d7989f15f0068ba1

| Scenario | Skill | Decision | Outcome | Risk | Tool calls | Observed | Turns | Duration | Cost | Assertions | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| S0a | `lifecycle-intake` | allow | not_executed | low | 1 of 2 | 1 | 1 | 116 s | US$1.62 | 30/30 | ok |
| S0b | `lifecycle-intake` | require_manual_review | not_executed | medium | 1 of 2 | 1 | 1 | 184 s | US$1.98 | 29/29 | ok |
| S0c | `lifecycle-intake` | deny | blocked | high | 1 of 2 | 1 | 1 | 137 s | US$1.45 | 29/29 | ok |
| S1 | `joiner-orchestrator` | deny | blocked | high | 0 of 20 | 0 | 1 | 157 s | US$1.92 | 25/25 | ok |
| S2 | `joiner-orchestrator` | allow_with_approval | completed | medium | 15 of 20 | 15 | 2 | 430 s | US$3.67 | 29/29 | ok |
| S3a | `mover-orchestrator` | deny | blocked | high | 5 of 20 | 5 | 1 | 213 s | US$2.17 | 25/25 | ok |
| S3b | `mover-orchestrator` | allow_with_approval | completed | medium | 15 of 20 | 15 | 2 | 356 s | US$3.35 | 29/29 | ok |
| S3c | `mover-orchestrator` | allow | completed | low | 6 of 20 | 6 | 1 | 169 s | US$1.85 | 28/28 | ok |
| S4 | `leaver-orchestrator` | allow_with_approval | completed | high | 11 of 25 | 11 | 2 | 282 s | US$2.42 | 31/31 | ok |
