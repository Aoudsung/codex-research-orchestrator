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

    def test_route_001_ignores_historical_and_negated_dyschop_and_allows_pinned_pi_gemini(self):
        (self.project / "AGENTS.md").write_text(
            "# Workspace\n监控使用 default/explorer + gpt-6-luna low；禁止把 agent_type=\"Luna\" 当作执行或监控角色。\n",
            encoding="utf-8",
        )
        (self.project / "controls.md").write_text(
            "# Controls\n"
            "forbid_claude_code: true\n"
            "## 常驻协作与路由政策\n"
            "新Gemini调用优先用户固定PI会话，使用Magpie auto来源，禁Dyschop。\n"
            "## 历史指令\n"
            "旧版本曾用 dyschop/kimi-k2，已废弃。\n",
            encoding="utf-8",
        )
        pi_dir = self.project / ".pi"
        pi_dir.mkdir(parents=True)
        (pi_dir / "model-sessions.json").write_text(
            json.dumps({
                "sessions": {
                    "carbon": {
                        "provider": "google-vertex",
                        "model": "gemini-4-carbon",
                        "sessionId": "00000000-0000-7000-8000-000000000002",
                        "cwd": str(self.project),
                    }
                },
                "previousOrchestratorSession": {
                    "provider": "dyschop",
                    "status": "historical_not_selected_for_future_dispatch",
                },
            }),
            encoding="utf-8",
        )
        (pi_dir / "execution-sessions.json").write_text(
            json.dumps({
                "authority": "User-selected auto entries; Dyschop forbidden",
                "sessions": {
                    "kimi": {"provider": "magpie", "model": "auto/kimi-k3.1-pro", "cwd": str(self.project)},
                },
                "historicalSessions": {
                    "kimi_old": {"provider": "magpie", "model": "dyschop/kimi-k3.1-pro", "cwd": str(self.project)},
                },
            }),
            encoding="utf-8",
        )
        (self.project / ".agent-bridge").mkdir(exist_ok=True)
        (self.project / ".agent-bridge" / "collaborators.json").write_text(
            json.dumps({
                "authority": "PI(magpie auto/*, no dyschop)",
                "channelPreferences": {"gemini": ["pi_pinned", "antigravity_pinned"]},
            }),
            encoding="utf-8",
        )

        rep = research_lint.lint_project(self.project, strict=True)
        self.assertTrue(rep["ok"], f"Expected clean lint, got {rep['findings']}")

    def test_route_002_and_route_003_context_aware_guards(self):
        (self.project / "AGENTS.md").write_text(
            "# Workspace\nNo delegation is allowed. Spawn agent_type=\"Luna\" to monitor logs.\n",
            encoding="utf-8",
        )
        (self.project / "controls.md").write_text("# Controls\nforbid_claude_code: true\n", encoding="utf-8")
        (self.project / "project.md").write_text(
            "# Project\nthe existing Sol(high) executor prepares deployment.\n",
            encoding="utf-8",
        )

        pi_sessions = self.project / ".pi" / "sessions"
        pi_sessions.mkdir(parents=True)
        big_jsonl = pi_sessions / "carbon.jsonl"
        big_jsonl.write_bytes(b"{}\n" + b" " * (8 * 1024 * 1024 + 64))

        bridge_dir = self.project / ".agent-bridge"
        bridge_dir.mkdir()
        (bridge_dir / "collaborators.json").write_text(
            json.dumps({
                "protocolEpoch": "fixture-protocol-v3",
                "pinnedSessions": {
                    "pi": {
                        "carbon": {
                            "model": "gemini-4-carbon",
                            "sessionId": "00000000-0000-7000-8000-000000000002",
                            "sessionPath": str(big_jsonl),
                            "cwd": str(self.project),
                        }
                    }
                },
                "subagentLifecyclePolicy": {
                    "retireAfterTaskHandback": {
                        "/root/fixture_worker": {
                            "boundTaskId": "fixture-bound-task",
                            "sessionId": "retiring-sol-session",
                            "recordedModel": "gpt-6-sol",
                            "recordedEffort": "medium",
                        }
                    },
                    "softSizeRotationBytes": 8 * 1024 * 1024,
                },
            }),
            encoding="utf-8",
        )

        bconn = sqlite3.connect(bridge_dir / "bridge.sqlite")
        bconn.execute(
            "CREATE TABLE tasks(id TEXT, from_agent TEXT, assigned_to TEXT, status TEXT, prompt TEXT, cwd TEXT, permissions_json TEXT, required_model TEXT, bound_conversation_id TEXT, required_conversation_id TEXT, session_id TEXT, metadata_json TEXT)"
        )
        # Bound task is protected; new task reusing retiring session or wrong epoch triggers ROUTE-002
        bconn.execute(
            "INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            ("fixture-bound-task", "codex", "codex", "in_progress", "Wait test host", str(self.project), "{}", "gpt-6-sol", "retiring-sol-session", None, "retiring-sol-session", json.dumps({"protocolEpoch": "fixture-protocol-v3"})),
        )
        bconn.execute(
            "INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            ("task-reused-bad", "codex", "codex", "in_progress", "New work on retiring", str(self.project), "{}", "gpt-6-sol", "retiring-sol-session", None, "retiring-sol-session", json.dumps({"protocolEpoch": "r2-old"})),
        )
        bconn.commit()
        bconn.close()

        rep = research_lint.lint_project(self.project, strict=True)
        rules = {f["rule"] for f in rep["findings"]}
        msgs = "\n".join(f["message"] for f in rep["findings"])
        self.assertIn("ROUTE-002", rules)
        self.assertIn("ROUTE-003", rules)
        route002_tasks = {
            f.get("detail", {}).get("taskId")
            for f in rep["findings"]
            if f["rule"] == "ROUTE-002"
        }
        self.assertIn("task-reused-bad", route002_tasks)
        self.assertNotIn("fixture-bound-task", route002_tasks)
        self.assertIn("No delegation is allowed", msgs)
        self.assertIn('agent_type="Luna"', msgs)
        self.assertIn("Sol(high", msgs)
        self.assertIn("8.0 MiB", msgs)


if __name__ == "__main__":
    unittest.main()
