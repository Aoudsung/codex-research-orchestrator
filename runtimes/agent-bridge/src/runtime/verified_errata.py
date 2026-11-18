"""Reconstruct and verify exact-line errata for a frozen UTF-8 document."""

import argparse
from hashlib import sha256
import json
from pathlib import Path
import sys


CLAIM_LIMIT = 4096


def _single_line(value):
    return isinstance(value, str) and bool(value.strip()) and not any(char in value for char in "\r\n\0")


def validate_line_anchor(document: str, anchor: str):
    if not _single_line(anchor) or document.count(anchor) != 1 or anchor not in document.split("\n"):
        raise RuntimeError("An erratum must target one unique, complete line in the frozen document")


def build_candidate(original: bytes, *, draft_sha256: str, edits) -> bytes:
    """Return the bytes obtained by replacing the given (original line, verbatim line) pairs."""
    if sha256(original).hexdigest() != draft_sha256:
        raise RuntimeError("The errata draft SHA-256 does not match the frozen document")
    document = original.decode("utf-8")
    replacements = {}
    for anchor, replacement in edits:
        validate_line_anchor(document, anchor)
        if anchor in replacements or not _single_line(replacement):
            raise RuntimeError("Each erratum requires a distinct anchor and one nonempty replacement line")
        replacements[anchor] = replacement

    updated = "\n".join(replacements.get(line, line) for line in document.split("\n"))
    for anchor, replacement in replacements.items():
        if updated.count(replacement) != 1 or (anchor != replacement and anchor in updated):
            raise RuntimeError("An erratum would leave a duplicated or superseded line in the candidate")
    return updated.encode("utf-8")


def _unique_object(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError("Duplicate JSON evidence key")
    return result


def candidate_from_evidence(original: bytes, evidence: bytes, *, evidence_sha256: str) -> bytes:
    """Reconstruct the candidate from a completed, independently pinned evidence record."""
    if sha256(evidence).hexdigest() != evidence_sha256:
        raise RuntimeError("The evidence SHA-256 does not match the pinned verifier record")
    record = json.loads(evidence.decode("utf-8"), object_pairs_hook=_unique_object)
    if not isinstance(record, dict) or record.get("status") != "replayed":
        raise RuntimeError("Errata require a completed verifier replay")
    checks = record.get("checks")
    if not isinstance(checks, dict) or not checks:
        raise RuntimeError("The verifier record has no checks")

    edits = []
    for name, check in checks.items():
        if not isinstance(check, dict):
            raise RuntimeError(f"Invalid verifier check {name!r}")
        anchor, replacement = check.get("draftClaim"), check.get("finalClaim")
        if any(not _single_line(line) or len(line) > CLAIM_LIMIT for line in (anchor, replacement)):
            raise RuntimeError(f"Verifier check {name!r} requires two complete lines of at most {CLAIM_LIMIT} characters")
        reason = check.get("reason")
        if not isinstance(reason, str) or not reason.strip() or reason.lstrip().upper().startswith("PARTIAL:"):
            raise RuntimeError(f"Verifier check {name!r} has no resolved explanation")
        expected, actual = check.get("expected"), check.get("actual")
        if not isinstance(expected, dict) or not expected or not isinstance(actual, dict) or expected.keys() != actual.keys():
            raise RuntimeError(f"Verifier check {name!r} requires matching observation fields")
        matches = json.dumps(expected, sort_keys=True) == json.dumps(actual, sort_keys=True)
        verdict = "confirmed" if matches else "contradicted"
        if check.get("verdict") != verdict or (verdict == "contradicted" and anchor == replacement):
            raise RuntimeError(f"Verifier check {name!r} has no applicable conclusion for the observations")
        edits.append((anchor, replacement))

    return build_candidate(original, draft_sha256=record.get("draftSha256"), edits=edits)


def _read_file(path: Path) -> bytes:
    if path.is_symlink() or not path.is_file():
        raise RuntimeError(f"Expected an ordinary file: {path}")
    return path.read_bytes()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    candidate = commands.add_parser("candidate", help="write candidate bytes to stdout")
    verify = commands.add_parser("verify", help="check an applied file and write a JSON receipt to stdout")
    for command in (candidate, verify):
        command.add_argument("draft", type=Path, help="frozen UTF-8 draft")
        command.add_argument("evidence", type=Path, help="completed replay JSON")
        command.add_argument("--evidence-sha256", required=True, help="pinned SHA-256 of the verifier record")
    verify.add_argument("--applied", type=Path, required=True, help="file after the authorized patch was applied")
    verify.add_argument("--patch-id", required=True, help="patch ID from the existing apply receipt")
    args = parser.parse_args(argv)

    try:
        draft = _read_file(args.draft)
        evidence = _read_file(args.evidence)
        updated = candidate_from_evidence(draft, evidence, evidence_sha256=args.evidence_sha256)
        if args.command == "candidate":
            sys.stdout.buffer.write(updated)
        else:
            if not args.patch_id.strip():
                raise RuntimeError("Verification requires an applied patch ID")
            if _read_file(args.applied) != updated:
                raise RuntimeError("The applied file differs from the verified errata candidate")
            print(json.dumps({"draftSha256": sha256(draft).hexdigest(), "evidenceSha256": args.evidence_sha256,
                              "reportSha256": sha256(updated).hexdigest(), "patchId": args.patch_id}))
    except (OSError, ValueError, RuntimeError) as error:
        parser.exit(1, f"{parser.prog}: {error}\n")


if __name__ == "__main__":
    main()
