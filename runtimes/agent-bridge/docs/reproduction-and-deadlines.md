# Reproducing claims and budgeting a bounded investigation

A lead requesting behavioral verification gives the verifier the exact candidate and the claims to check. Have the verifier commit to an expected observable result, then run the scoped command on that candidate. Keep the inputs, observed result, exit code and artifact revision. If the result disagrees, correct or qualify the claim. Recheck a revision when it changes a tested claim or its inputs.

For an authorized Antigravity CLI call, pass `captureCommandEvidence: true` to `antigravity_exec`. A successful invocation then returns `commandEvidence` for its completed shell events. Match the session and step index with the verifier transcript, and compare SHA-256 of the exact UTF-8 command and full native tool output. The exit code comes from the tool header; a missing header yields null. The hashes identify what ran. The verifier still compares the observed values against the claim. Link those receipts to the corresponding requirements when submitting work-run acceptance.

Before changing a timed-out investigation, measure the span from task planning to first dispatch, first candidate, review, repair and final acceptance. Within each provider invocation, distinguish model-attributed time, tool-attributed time, and intervals the transport cannot explain. A phase the run never entered has zero observed execution time. Preserve the common deadline across all steps. Record the first applicable candidate and the revision sent for review. If the deadline passes before a candidate arrives, close the run with its measured author time and the requirements still open.

The installed timing helper reads a retained run directory offline. It expects a `receipt.json`, controller MCP traces under `controller/NAME.mcp.jsonl`, and any available native event streams under `provider-PROFILE/`. Supply one phase-to-profile binding per phase and the CLI's timezone if known. For example:

```sh
runtime=.research-orchestrator/runtime/agent-bridge
python3 "$runtime/src/runtime/investigation_timing.py" "$run_dir" \
  --origin-trace plan --rpc-method antigravity_exec \
  --phase implementation=author --phase review=review --phase revision=author \
  --cli-timezone America/Los_Angeles
```

Use the JSON phase records to distinguish the controller deadline, the last visible stream event and completed model/tool durations. The marker-to-termination interval comes from wall-clock observations and may overlap reported steps. Unmatched durations stay null. A run directory containing only a total elapsed time cannot supply per-phase attribution.
