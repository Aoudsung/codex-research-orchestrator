"""Exercise the public errata CLI and a local patch application with synthetic records."""

from difflib import unified_diff
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest


CLI = Path(__file__).resolve().parents[1] / "src/runtime/verified_errata.py"
ANCHOR = "The fixture recovered four records."
REPLACEMENT = "The fixture recovered three records."
DRAFT = f"# Fixture summary\n\n{ANCHOR}\n\nSource notes follow.\n".encode()


class VerifyErrataCliTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.workspace = Path(directory.name)
        self.frozen = self.workspace / "frozen.md"
        self.evidence = self.workspace / "replay.json"
        self.write_record(DRAFT)

    def write_record(self, draft, **check_fields):
        self.frozen.write_bytes(draft)
        self.draft_digest = sha256(draft).hexdigest()
        check = {
            "draftClaim": ANCHOR,
            "finalClaim": REPLACEMENT,
            "expected": {"records": 4},
            "actual": {"records": 3},
            "verdict": "contradicted",
            "reason": "The completed fixture printed a count of three.",
        }
        check.update(check_fields)
        record = {"status": "replayed", "draftSha256": self.draft_digest, "checks": {"record count": check}}
        evidence = json.dumps(record).encode()
        self.evidence.write_bytes(evidence)
        self.evidence_digest = sha256(evidence).hexdigest()

    def cli(self, command, *args):
        return subprocess.run(
            [sys.executable, str(CLI), command, str(self.frozen), str(self.evidence),
             "--evidence-sha256", self.evidence_digest, *args],
            capture_output=True, timeout=10,
        )

    def assert_rejected(self, process, diagnostic):
        self.assertEqual(process.returncode, 1, process.stderr.decode())
        self.assertEqual(process.stdout, b"")
        self.assertIn(diagnostic, process.stderr.decode())

    def test_candidate_patch_and_verify(self):
        candidate = self.cli("candidate")
        self.assertEqual(candidate.returncode, 0, candidate.stderr.decode())
        expected = DRAFT.replace(ANCHOR.encode(), REPLACEMENT.encode())
        self.assertEqual(candidate.stdout, expected)
        self.assertEqual(self.frozen.read_bytes(), DRAFT)
        patch = "diff --git a/report.md b/report.md\n" + "".join(unified_diff(
            DRAFT.decode().splitlines(keepends=True), candidate.stdout.decode().splitlines(keepends=True),
            fromfile="a/report.md", tofile="b/report.md",
        ))
        applied = self.workspace / "report.md"
        applied.write_bytes(DRAFT)
        subprocess.run(["git", "apply", "-"], cwd=self.workspace, input=patch.encode(), check=True, timeout=10)

        options = ("--applied", str(applied), "--patch-id", "applied-fixture")
        verified = self.cli("verify", *options)
        self.assertEqual(verified.returncode, 0, verified.stderr.decode())
        self.assertEqual(json.loads(verified.stdout), {
            "draftSha256": self.draft_digest,
            "evidenceSha256": self.evidence_digest,
            "reportSha256": sha256(expected).hexdigest(),
            "patchId": "applied-fixture",
        })
        applied.write_bytes(expected + b"Unrelated change.\n")
        self.assert_rejected(self.cli("verify", *options), "applied file differs")

    def test_rejects_stale_draft_and_changed_evidence(self):
        self.frozen.write_bytes(DRAFT + b"A newer draft.\n")
        self.assert_rejected(self.cli("candidate"), "draft SHA-256")
        self.frozen.write_bytes(DRAFT)
        self.evidence.write_bytes(self.evidence.read_bytes() + b"\n")
        self.assert_rejected(self.cli("candidate"), "evidence SHA-256")

    def test_rejects_ambiguous_or_partial_line_anchors(self):
        for draft in (DRAFT + f"{ANCHOR}\n".encode(), DRAFT.replace(ANCHOR.encode(), f"Quote: {ANCHOR}".encode())):
            with self.subTest(draft=draft):
                self.write_record(draft)
                self.assert_rejected(self.cli("candidate"), "one unique, complete line")

    def test_supports_complete_anchors_at_the_character_limit(self):
        for count in (4096, 4097):
            with self.subTest(characters=count):
                anchor = "文" * count
                self.write_record(f"{anchor}\n".encode(), draftClaim=anchor)
                process = self.cli("candidate")
                if count == 4096:
                    self.assertEqual(process.returncode, 0, process.stderr.decode())
                    self.assertEqual(process.stdout, f"{REPLACEMENT}\n".encode())
                else:
                    self.assert_rejected(process, "at most 4096 characters")

    def test_rejects_unresolved_or_unsupported_errata(self):
        cases = (
            ({"reason": "PARTIAL: Another finding conflicts with the replacement."}, "resolved explanation"),
            ({"actual": {}}, "observation fields"),
            ({"finalClaim": ANCHOR}, "applicable conclusion"),
        )
        for check, diagnostic in cases:
            with self.subTest(check=check):
                self.write_record(DRAFT, **check)
                self.assert_rejected(self.cli("candidate"), diagnostic)
