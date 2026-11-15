#!/usr/bin/env python3
"""Tests for pack_pro_bundle.py secret scrubbing and manifest generation."""

import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "skills" / "codex-research-orchestrator" / "scripts"
sys.path.insert(0, str(SCRIPTS))
import pack_pro_bundle  # noqa: E402


class PackProBundleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.project = Path(self.tmp.name)
        subprocess.run(["git", "init", "-q"], cwd=self.project, check=True)
        (self.project / "src").mkdir()
        (self.project / "src" / "model.py").write_text("def step(x):\n    return x\n", encoding="utf-8")
        (self.project / "src" / "__pycache__").mkdir()
        (self.project / "src" / "__pycache__" / "model.cpython-313.pyc").write_bytes(b"\x00\x01")
        (self.project / ".env").write_text("API_KEY=secret\n", encoding="utf-8")
        (self.project / ".pi").mkdir()
        (self.project / ".pi" / "project-session.json").write_text('{"id":"x"}\n', encoding="utf-8")
        (self.project / "SSH_Document.md").write_text("password: hidden\n", encoding="utf-8")
        (self.project / "src" / ".env.local").write_text("TOKEN=123\n", encoding="utf-8")
        (self.project / "src" / "cache.sqlite3").write_bytes(b"sqlite")
        (self.project / "prompt.md").write_text("Paragraph 1\n\nParagraph 2\n\nParagraph 3\n", encoding="utf-8")
        subprocess.run(["git", "add", "src/model.py"], cwd=self.project, check=True)
        subprocess.run(
            ["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"],
            cwd=self.project,
            check=True,
        )

    def tearDown(self):
        self.tmp.cleanup()

    def test_bundle_includes_manifest_and_scrubs_secrets(self):
        out_zip = self.project / "bundle.zip"
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            rc = pack_pro_bundle.main([
                "--project", str(self.project),
                "--output", str(out_zip),
                "--include", "src",
                "--prompt-file", "prompt.md",
            ])
        self.assertEqual(0, rc)
        receipt = json.loads(stdout.getvalue())
        self.assertTrue(receipt["ok"])
        self.assertEqual(1, receipt["file_count"])
        self.assertIsNotNone(receipt["commit_sha"])
        self.assertEqual(1, receipt["skipped"]["blocked_secret"])
        self.assertEqual(1, receipt["skipped"]["blocked_dir"])
        self.assertEqual(1, receipt["skipped"]["blocked_artifact"])

        with zipfile.ZipFile(out_zip) as zf:
            names = set(zf.namelist())
            self.assertEqual({"src/model.py", "PRO_PROMPT.md", "BUNDLE_MANIFEST.md"}, names)
            manifest = zf.read("BUNDLE_MANIFEST.md").decode("utf-8")
            self.assertIn(receipt["commit_sha"], manifest)
            self.assertIn("`src/model.py`", manifest)
            self.assertNotIn("SHA256", manifest)
            self.assertNotIn("SSH_Document.md", manifest)
            self.assertNotIn(".env", manifest)
            self.assertNotIn(".pi/project-session.json", names)

    def test_optional_include_sha256_flag(self):
        out_zip = self.project / "bundle-sha.zip"
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            rc = pack_pro_bundle.main([
                "--project", str(self.project),
                "--output", str(out_zip),
                "--include", ".",
                "--include-sha256",
            ])
        self.assertEqual(0, rc)
        with zipfile.ZipFile(out_zip) as zf:
            names = set(zf.namelist())
            self.assertNotIn(".pi/project-session.json", names)
            self.assertIn("| Path | Lines | Bytes | SHA256 |", zf.read("BUNDLE_MANIFEST.md").decode("utf-8"))

    def test_explicit_secret_include_fails_loudly(self):
        for forbidden in ("SSH_Document.md", ".env"):
            out_zip = self.project / "blocked.zip"
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                rc = pack_pro_bundle.main([
                    "--project", str(self.project),
                    "--output", str(out_zip),
                    "--include", forbidden,
                ])
            self.assertEqual(2, rc)
            self.assertIn("blocked_secret", stderr.getvalue())
            self.assertFalse(out_zip.exists())


if __name__ == "__main__":
    unittest.main()
