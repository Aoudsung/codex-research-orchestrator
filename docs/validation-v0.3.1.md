# v0.3.1: real-client communication and continuation

Date: 2026-10-25. A separate test project was installed from the public v0.3.0 release archive. It used its own research records, memory, bridge database, task IDs, and client sessions. No active research workspace, bridge route, or research conversation was used.

## Real clients and models

| Surface | Version | Selected model | Effort |
|---|---|---|---|
| Codex App Server | 0.164.0 | `gpt-6-luna` | Low |
| Claude Code CLI | 2.1.310 | `claude-haiku-5-5` | Low |
| Antigravity CLI | 1.4.7 | `gemini-3.8-flash-low` | Low |

Codex confirmed the installed skill and project question. Each client used the installed MCP servers and its existing provider authentication. The low-cost model selections were explicit; the test did not use a higher-cost fallback.

## Observed exchanges

| Request sender | Recipient | Message sent through MCP | Bound session continued automatically | Matching ACK returned through MCP |
|---|---|---|---|---|
| Codex | Claude Code | Passed | Passed | Passed |
| Codex | Antigravity | Passed | Passed | Passed |
| Claude Code | Codex | Passed | Passed | Passed |
| Claude Code | Antigravity | Passed | Passed | Passed |
| Antigravity | Codex | Passed | Passed | Passed |
| Antigravity | Claude Code | Passed | Passed | Passed |

The final ledger contained six requests, six matching acknowledgements, and six confirmed request deliveries. The recipient was not manually prompted to process the arriving request. The bridge's event receiver invoked a configured `custom_command` host adapter, which started a turn in the same bound session. Test tasks were separate per recipient, matching the runtime's one wakeup route per task.

For Codex, the adapter submitted `turn/start` to the dedicated real App Server and recorded its returned turn ID. For Claude Code, it resumed the bound CLI session and used the client's result UUID and session ID. For Antigravity, it resumed the bound conversation and used the actual user-input step index and conversation ID. The MCP acknowledgements separately established that the messages were processed. A successful forwarding process alone was not accepted as proof.

All test routes were disabled afterward, and the dedicated wakeup process and Codex test host were stopped.

## Problems found and corrected

- **Antigravity project setup:** its documented `.agents/mcp_config.json` workspace entry worked in the real CLI. The helper now supports applying that configuration and sets the documented `timeoutSeconds` field.
- **Antigravity output shape:** the current CLI places the model under `init.model` and terminal output under `result`. The adapter now requests streaming JSON and reads those fields.
- **False success after a denied tool:** Antigravity returned exit code zero and `SUCCESS` while denying an MCP call. Claude also reports permission denials separately from `is_error`. Both adapters now return an explicit permission failure when those records are present.
- **Claude model evidence:** current JSON output reports the executed model in `modelUsage`. The adapter now uses it when there is one unambiguous model entry, without treating a requested CLI flag as runtime evidence.
- **Effort selection:** Claude execution/resumption and Antigravity CLI execution now expose the supported effort option.
- **Permission setup:** the initial Codex call was rejected by `approval_policy = "never"`; a Claude reply used a valid reply tool omitted from the test allowlist. Only the authorized test tools were granted, and the failed exchange was retried. Setup guidance now distinguishes configuration, tool permission, delivery, and processing.

Antigravity global MCP definitions could not be reliably disabled by same-name workspace entries. The test used an OS sandbox to prevent loading the existing research bridge and to deny writes to the research directories. Its bounded headless invocations used explicit per-run permission approval. This isolation harness is specific to the test environment; the installer does not change global policies or apply a blanket permission bypass.

## Targeted regression checks

After the corrections, all **27 onboarding tests** and the bridge regression suite passed on the isolated Linux validation server. New provider fixtures reproduce the observed nested Antigravity events, Claude model usage records, low-effort flags, and zero-exit tool-denial cases. The live sessions established the behavior above; these fixture checks protect the corresponding parser and configuration fixes.

## Limits

This verifies real model-backed client sessions and event-triggered continuation through an explicitly configured host adapter. It does not verify native idle-window activation in the Codex Desktop or Antigravity graphical applications, nor automatic wakeup without a host adapter. The test-specific adapter is not installed by the skill. The current generic `cli_resume` wakeup driver is Codex-specific; Claude and Antigravity deployments need a compatible host route such as `custom_command`.

The test used short messages. It was not a stress test, a long-running unattended research evaluation, or a scientific-quality benchmark. Testing stopped after the six directions and relevant regression checks passed.
