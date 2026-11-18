# Applying verified report corrections

Use lightweight parallel work for independently answerable parts of the report. After integration, a fresh verifier receives the frozen UTF-8 draft, task and permitted inputs. The verifier picks assertions that could change the conclusion, records an expected observation before running the check, and gives each correction a unique complete source line. Preserve the command evidence and the verifier's record.

The replay JSON has `status` set to `replayed`, a `draftSha256`, and a `checks` object keyed by check name. Each check contains `draftClaim`, `finalClaim`, `expected`, `actual`, `verdict` and `reason`. Expected and observed objects use the same field names. A matching observation takes the verdict `confirmed`; a mismatch takes `contradicted` and needs a resolved replacement. Source and replacement lines may each contain up to 4,096 characters. The full-line format uses LF line endings.

The coordinator pins the SHA-256 of the verifier's evidence from the trusted handoff. From the installed project directory, generate a candidate in a fresh file.

```sh
runtime=.research-orchestrator/runtime/agent-bridge
python3 "$runtime/src/runtime/verified_errata.py" candidate draft.md replay.json \
  --evidence-sha256 "$replay_sha256" > candidate.md
```

After a successful command, check that the target still matches the frozen draft. Submit the candidate diff through the authorized patch path. After applying it, use the patch ID from the actual receipt and the path of the resulting document.

```sh
python3 "$runtime/src/runtime/verified_errata.py" verify draft.md replay.json \
  --evidence-sha256 "$replay_sha256" --applied report.md --patch-id "$patch_id"
```

The verification receipt records the patch ID and digests of the frozen draft, evidence and byte-verified report. The owner still checks whether a corrected claim conflicts with another passage or leaves an acceptance criterion open. Record unresolved findings for follow-up.
