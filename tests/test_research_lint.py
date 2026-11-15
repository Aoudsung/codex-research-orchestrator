#!/usr/bin/env python3
"""Tests for static/read-only research_lint.py and setup.py lint integration."""

import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "skills" / "codex-research-orchestrator" / "scripts"
sys.path.insert(0, str(SCRIPTS))
import research_lint  # noqa: E402


class ResearchLintTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.project = Path(self.tmp.name).resolve()

    def tearDown(self):
        self.tmp.cleanup()

    def test_clean_workspace_passes(self):
        (self.project / "AGENTS.md").write_text("# Workspace\nUse setup.py lint.\n", encoding="utf-8")
        (self.project / "controls.md").write_text("# Controls\nforbid_claude_code: true\n", encoding="utf-8")
        (self.project / "charter.md").write_text("# Charter\nGoal\n", encoding="utf-8")
        (self.project / "project.md").write_text("# Project\nActive\n", encoding="utf-8")
        (self.project / "state.md").write_text("# State\nReady\n", encoding="utf-8")

        report = research_lint.lint_project(self.project, strict=True)
        self.assertTrue(report["ok"])
        self.assertEqual(0, report["error_count"])
        self.assertEqual(0, report["warning_count"])

        proc = subprocess.run(
            [sys.executable, str(ROOT / "setup.py"), "lint", "--project", str(self.project), "--strict", "--json"],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(0, proc.returncode)
        cli_json = json.loads(proc.stdout)
        self.assertTrue(cli_json["ok"])
        self.assertEqual("passed", cli_json["status"])

    def test_detects_all_rule_families_read_only(self):
        # DOC-001 + DOC-002
        bloated_lines = ["禁止做 A"] * 10 + ["python3 scripts/research_memory.py context q"] * 4
        (self.project / "AGENTS.md").write_text(
            "## 补充说明\n" + "\n".join(bloated_lines) + "\nSee DynaRT-RSI and research-log.md\n",
            encoding="utf-8",
        )
        (self.project / "controls.md").write_text("forbid_claude_code: true\ndyschop/kimi-k2\n", encoding="utf-8")

        # GIT-001
        subprocess.run(["git", "init", "-q"], cwd=self.project, check=True)
        (self.project / ".env").write_text("SECRET=1\n", encoding="utf-8")
        subprocess.run(["git", "add", "-f", ".env"], cwd=self.project, check=True)

        # MCP-001 (disabled claude present + missing BRIDGE_TOOL_PROFILE dedup)
        (self.project / ".mcp.json").write_text(
            json.dumps({
                "mcpServers": {
                    "cro_codex": {"command": "node", "args": ["codex-mcp.mjs"]},
                    "cro_antigravity": {"command": "node", "args": ["antigravity-mcp.mjs"]},
                    "cro_claude_code": {"command": "node", "args": ["claude-code-mcp.mjs"]},
                }
            }),
            encoding="utf-8",
        )

        # ROUTE-001 (PI routing Gemini + token bloat)
        pi_sessions = self.project / ".pi" / "sessions"
        pi_sessions.mkdir(parents=True)
        (pi_sessions / "project-session.json").write_text(
            json.dumps({"cwd": "/tmp/elsewhere", "model": "gemini-2.5-pro"}),
            encoding="utf-8",
        )
        (pi_sessions / "trace.jsonl").write_text(
            json.dumps({"role": "assistant", "usage": {"input": 195000, "cacheRead": 0}}) + "\n",
            encoding="utf-8",
        )

        # TASK-001 (bridge.sqlite active overlap + coordinator write)
        bridge_dir = self.project / ".agent-bridge"
        bridge_dir.mkdir()
        bconn = sqlite3.connect(bridge_dir / "bridge.sqlite")
        bconn.execute(
            "CREATE TABLE tasks(id TEXT, from_agent TEXT, assigned_to TEXT, status TEXT, prompt TEXT, cwd TEXT, permissions_json TEXT, required_model TEXT, metadata_json TEXT)"
        )
        bconn.execute(
            "INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?)",
            ("t1", "codex", "codex", "running", "Edit solver", str(self.project), json.dumps({"writeRoots": ["src"]}), "gpt-6-luna", json.dumps({"role": "coordinator"})),
        )
        bconn.execute(
            "INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?)",
            ("t2", "codex", "codex", "pending", "Edit solver step", str(self.project), json.dumps({"writeRoots": ["src/step.py"]}), "gpt-6-sol", json.dumps({"taskKind": "experiment"})),
        )
        bconn.commit()
        bconn.close()

        # MEM-001 (memory.sqlite3 bloated tombstone + unsupported claim)
        mem_dir = self.project / ".research-memory"
        mem_dir.mkdir()
        mconn = sqlite3.connect(mem_dir / "memory.sqlite3")
        mconn.execute("CREATE TABLE records(id INTEGER PRIMARY KEY, kind TEXT, claim_status TEXT, state TEXT, state_reason TEXT)")
        mconn.execute("CREATE TABLE dependencies(record_id INTEGER, depends_on INTEGER)")
        mconn.execute("INSERT INTO records VALUES (1, 'claim', 'supported', 'current', NULL)")
        mconn.execute("INSERT INTO records VALUES (2, 'source', NULL, 'withdrawn', ?)", (" ".join(["w"] * 45),))
        mconn.commit()
        mconn.close()

        rep = research_lint.lint_project(self.project, strict=True)
        rules_seen = {f["rule"] for f in rep["findings"]}
        self.assertFalse(rep["ok"])
        for expected in ("DOC-001", "DOC-002", "GIT-001", "MCP-001", "ROUTE-001", "TASK-001", "MEM-001"):
            self.assertIn(expected, rules_seen, f"Missing expected rule {expected}; got {rep['findings']}")

        # Verify SQLite read-only access did not create -wal / -shm sidecars
        self.assertFalse((bridge_dir / "bridge.sqlite-wal").exists())
        self.assertFalse((mem_dir / "memory.sqlite3-wal").exists())

        proc = subprocess.run(
            [sys.executable, str(ROOT / "setup.py"), "lint", "--project", str(self.project), "--json"],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(1, proc.returncode)


if __name__ == "__main__":
    unittest.main()
