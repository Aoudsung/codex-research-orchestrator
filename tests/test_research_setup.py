"""Onboarding contracts; synthetic executables never contact providers."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import tomllib
import unittest
from unittest import mock

REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "skills/codex-research-orchestrator/scripts/research_setup.py"
spec = importlib.util.spec_from_file_location("research_setup", SCRIPT)
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="research setup ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.bundle = self.root / "public bundle"
        self.bundle.mkdir()
        shutil.copy2(REPO / "setup.py", self.bundle / "setup.py")
        shutil.copytree(REPO / "skills", self.bundle / "skills", ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copytree(REPO / "runtimes", self.bundle / "runtimes", ignore=shutil.ignore_patterns("node_modules", ".git", "__pycache__"))
        self.skill = self.bundle / "skills/codex-research-orchestrator"
        self.project = self.root / "research project"
        self.project.mkdir()
        self.bin = self.root / "fake bin"
        self.bin.mkdir()
        self.node = self.executable("node", "printf 'v24.1.0\\n'\n")
        self.provider = self.executable("claude", "exit 97\n")
        self.source_patch = mock.patch.object(setup, "source_skill", return_value=self.skill)
        self.source_patch.start()
        self.addCleanup(self.source_patch.stop)

    def executable(self, name, body):
        path = self.bin / name
        path.write_text("#!/bin/sh\n" + body)
        path.chmod(0o755)
        return path

    def run_cli(self, *args, code=0, project=None):
        stream = io.StringIO()
        with contextlib.redirect_stdout(stream), contextlib.redirect_stderr(stream):
            actual = setup.main([*args, "--project", str(project or self.project), "--json"])
        output = json.loads(stream.getvalue())
        self.assertEqual(actual, code, output)
        return output

    def install(self, *args):
        return self.run_cli("install", *args)

    def initialize(self):
        self.install()
        return self.run_cli("init", "--question", "What changes and why?")

    def connect(self, client="codex", peers=("claude-code",), apply=True):
        args = ["connect", "--client", client, "--peers", *peers, "--node", str(self.node)]
        if apply:
            args.append("--apply")
        return self.run_cli(*args)

    def snapshot(self, root=None):
        root = root or self.project
        return {str(path.relative_to(root)): (path.read_bytes(), path.stat().st_mtime_ns)
                for path in root.rglob("*") if path.is_file()}

    def test_full_install_survives_deleted_source_and_keeps_license(self):
        runtime = self.bundle / "runtimes/agent-bridge"
        for name in ("node_modules/private.txt", "state/private.txt", "logs/private.txt", "src/cache.sqlite", ".git/config"):
            path = runtime / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("private")
        output = self.install()
        self.assertEqual(output["mode"], "full-bundle")
        self.assertTrue((self.project / setup.SKILL_PATH / "LICENSE").is_file())
        self.assertTrue((self.project / setup.RUNTIME_PATH / "LICENSE").is_file())
        self.assertFalse(any(p.name == "private.txt" for p in self.project.rglob("*")))
        self.assertFalse((self.project / setup.RUNTIME_PATH / "src/cache.sqlite").exists())
        shutil.rmtree(self.bundle)
        installed = self.project / setup.SKILL_PATH / "scripts/research_setup.py"
        completed = subprocess.run([sys.executable, str(installed), "init", "--project", str(self.project),
                                    "--question", "Can it work offline?", "--json"], capture_output=True, text=True)
        self.assertEqual(completed.returncode, 0, completed.stderr + completed.stdout)
        self.assertEqual(json.loads(completed.stdout)["status"], "initialized")
        completed = subprocess.run([sys.executable, str(installed), "connect", "--project", str(self.project),
                                    "--peers", "claude-code", "--node", str(self.node), "--json"], capture_output=True, text=True)
        self.assertEqual(completed.returncode, 0, completed.stderr + completed.stdout)
        entries = tomllib.loads((self.project / ".research-orchestrator/mcp/codex.toml").read_text())["mcp_servers"]
        self.assertTrue(Path(entries["cro_claude_code"]["args"][0]).is_file())

    def test_standalone_skill_install_and_missing_optional_runtime(self):
        shutil.rmtree(self.bundle / "runtimes")
        output = self.install()
        self.assertEqual(output["mode"], "skill-only")
        self.assertIsNone(output["runtime"])
        self.run_cli("init", "--question", "A self-contained question")
        self.run_cli("connect", "--peers", "claude-code", "--node", str(self.node), code=2)
        self.assertTrue(self.run_cli("doctor")["basic_research_ready"])

    def test_repeat_install_is_noop_and_receipt_paths_are_relative(self):
        self.install()
        before = self.snapshot()
        result = self.install()
        self.assertEqual(result["changed"], [])
        self.assertEqual(before, self.snapshot())
        receipt = json.loads((self.project / setup.RECEIPT_PATH).read_text())
        self.assertTrue(all(not Path(p).is_absolute() for p in receipt["components"]))

    def test_upgrade_backs_up_managed_files_and_preserves_user_data(self):
        self.initialize()
        for name in (".agent-bridge/bridge.sqlite", ".codex/config.toml", "research-notes.md"):
            path = self.project / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("user data")
        user_paths = (*setup.RECORDS, ".research-memory/memory.sqlite3", ".agent-bridge/bridge.sqlite", ".codex/config.toml", "research-notes.md")
        old = {name: (self.project / name).read_bytes() for name in user_paths}
        source = self.skill / "SKILL.md"
        original = source.read_text()
        source.write_text(original + "\nNew release text.\n")
        self.run_cli("install", code=2)
        changed = self.install("--upgrade")
        backup = self.project / changed["backup"]
        self.assertEqual((backup / setup.SKILL_PATH / "SKILL.md").read_text(), original)
        self.assertTrue((backup / setup.RECEIPT_PATH).is_file())
        self.assertEqual(old, {name: (self.project / name).read_bytes() for name in user_paths})

    def test_manual_skill_upgrade_and_unrelated_files_are_not_replaced(self):
        destination = self.project / setup.SKILL_PATH
        destination.parent.mkdir(parents=True)
        shutil.copytree(self.skill, destination)
        (destination / "SKILL.md").write_text((destination / "SKILL.md").read_text() + "\nPrevious version.\n")
        self.assertIsNotNone(self.install("--upgrade")["backup"])
        (destination / "my-notes.txt").write_text("keep")
        before = self.snapshot()
        self.run_cli("install", "--upgrade", code=2)
        self.assertEqual(before, self.snapshot())

    def test_overlap_and_source_and_destination_symlinks_are_rejected(self):
        with mock.patch.object(setup, "source_skill", return_value=self.project / setup.SKILL_PATH):
            self.run_cli("install", code=2)
        outside = self.root / "outside"
        outside.mkdir()
        (self.project / ".agents").symlink_to(outside, target_is_directory=True)
        self.run_cli("install", code=2)
        self.assertEqual(list(outside.iterdir()), [])
        (self.project / ".agents").unlink()
        (self.skill / "scripts/escape.py").symlink_to(self.provider)
        self.run_cli("install", code=2)
        self.assertFalse((self.project / setup.SKILL_PATH).exists())

    def test_failed_upgrade_rolls_back_old_install(self):
        self.install()
        before = self.snapshot()
        (self.skill / "SKILL.md").write_text((self.skill / "SKILL.md").read_text() + "\nNext release.\n")
        real_replace = os.replace
        failed = False

        def fail_receipt(source, target):
            nonlocal failed
            if Path(target) == self.project / setup.RECEIPT_PATH and not failed:
                failed = True
                raise OSError("injected receipt write failure")
            return real_replace(source, target)

        with mock.patch.object(setup.os, "replace", side_effect=fail_receipt):
            self.run_cli("install", "--upgrade", code=2)
        after = self.snapshot()
        self.assertEqual(before, {key: after[key] for key in before})

    def test_init_question_is_verbatim_and_memory_is_usable(self):
        self.install()
        question = "  Why?\r\n# Exact user text\nUnicode: α\n  "
        output = self.run_cli("init", "--question", question, "--title", "My topic")
        self.assertEqual(output["memory"]["status"], "ready")
        controls = (self.project / "controls.md").read_bytes().decode()
        self.assertTrue(controls.endswith(question))
        self.assertIn("Source: user-provided", controls)
        self.assertIn("not recorded", (self.project / "project.md").read_text())
        memory_script = self.project / setup.SKILL_PATH / "scripts/research_memory.py"
        packet = subprocess.run([sys.executable, str(memory_script), "--project", str(self.project), "context", "why",
                                 "--max-chars", "5000", "--output", "packet.txt"], capture_output=True, text=True)
        self.assertEqual(packet.returncode, 0, packet.stderr)
        self.assertIn(question, (self.project / "packet.txt").read_bytes().decode())
        before = self.snapshot()
        repeated = self.run_cli("init", "--question", "Do not replace the real question")
        self.assertEqual(repeated["changed"], [])
        self.assertEqual(before, self.snapshot())

    def test_partial_init_and_existing_known_project_preserve_records(self):
        (self.project / "charter.md").write_text("Original charter")
        before = self.snapshot()
        self.run_cli("init", "--question", "new", code=2)
        self.assertEqual(before, self.snapshot())
        for name in ("project.md", "state.md"):
            (self.project / name).write_text("Existing project")
        self.assertEqual(self.run_cli("init")["status"], "existing-project")
        self.assertFalse((self.project / "controls.md").exists())

    def test_init_does_not_overwrite_a_file_created_during_publication(self):
        self.install()
        link = os.link
        controls = self.project / "controls.md"

        def concurrent_writer(source, destination):
            if Path(destination) == controls:
                controls.write_text("Another writer's authoritative question")
            return link(source, destination)

        with mock.patch.object(setup.os, "link", side_effect=concurrent_writer):
            output = self.run_cli("init", "--question", "Our proposed question", code=2)
        self.assertIn("workspace changed", output["error"])
        self.assertEqual(controls.read_text(), "Another writer's authoritative question")
        self.assertFalse((self.project / ".research-memory").exists())
        self.assertFalse((self.project / ".research-orchestrator/init.lock").exists())

    def test_concurrent_init_cannot_replace_the_first_question(self):
        self.install()
        validate = setup.validate_component
        competing_result = []

        def interleaved_init(root, kind):
            competing_result.append(self.run_cli("init", "--question", "Competing question", code=2))
            return validate(root, kind)

        with mock.patch.object(setup, "validate_component", side_effect=interleaved_init):
            output = self.run_cli("init", "--question", "First question")
        self.assertEqual(output["status"], "initialized")
        self.assertIn("project lock", competing_result[0]["error"])
        self.assertTrue((self.project / "controls.md").read_text().endswith("First question"))
        self.assertFalse((self.project / ".research-orchestrator/init.lock").exists())
        self.assertEqual(self.run_cli("init", "--question", "Competing question")["changed"], [])

    def test_selected_peers_use_real_paths_same_database_and_caller(self):
        self.install()
        for client in setup.AGENTS:
            peers = tuple(name for name in setup.AGENTS if name != client)
            output = self.connect(client, peers, apply=False)
            export = Path(output["generated"])
            data = tomllib.loads(export.read_text()) if client == "codex" else json.loads(export.read_text())
            entries = data["mcp_servers" if client == "codex" else "mcpServers"]
            self.assertEqual(len(entries), 2)
            for entry in entries.values():
                self.assertEqual(entry["command"], str(self.node))
                self.assertTrue(Path(entry["args"][0]).is_file())
                self.assertEqual(entry["env"]["MCP_CALLER_AGENT"], client)
                self.assertEqual(entry["env"]["AGENT_BRIDGE_DB"], str(self.project / ".agent-bridge/bridge.sqlite"))
                if client == "codex":
                    self.assertEqual(entry["tool_timeout_sec"], 660)
                    self.assertNotIn("tool_timeout_sec", entry["env"])
                    self.assertNotIn("timeout", entry)
                elif client == "claude-code":
                    self.assertEqual(entry["timeout"], 660000)
                    self.assertNotIn("tool_timeout_sec", entry)
                else:
                    self.assertNotIn("tool_timeout_sec", entry)
                    self.assertNotIn("timeout", entry)
                    self.assertEqual(entry["timeoutSeconds"], 660)
            self.assertEqual(output["host_connectivity"], "not-verified")
        self.assertFalse((self.project / ".agent-bridge").exists())
        self.assertFalse((self.project / ".codex").exists())
        self.assertFalse((self.project / ".mcp.json").exists())

    def test_codex_preserves_exact_unrelated_text_and_repeat_apply(self):
        self.install()
        config = self.project / ".codex/config.toml"
        config.parent.mkdir()
        original = '# User settings\r\nmodel = "existing"\r\n[mcp_servers.other]\r\ncommand = "custom"'
        config.write_bytes(original.encode())
        output = self.connect()
        actual = setup.read_text(config)
        self.assertTrue(actual.startswith(original))
        self.assertEqual((self.project / output["backup"] / ".codex/config.toml").read_bytes(), original.encode())
        before = self.snapshot()
        self.assertEqual(self.connect()["changed"], [])
        self.assertEqual(before, self.snapshot())
        self.connect(peers=("antigravity",))
        parsed = tomllib.loads(config.read_text())
        self.assertEqual(set(parsed["mcp_servers"]), {"other", "cro_antigravity"})
        self.assertTrue(setup.read_text(config).startswith(original))

    def test_codex_quoted_dotted_and_inline_namespace_collisions_fail(self):
        self.install()
        config = self.project / ".codex/config.toml"
        config.parent.mkdir()
        for text in ('[mcp_servers."cro_claude_code"]\ncommand="mine"\n',
                     'mcp_servers.cro_claude_code.command="mine"\n',
                     'mcp_servers={cro_claude_code={command="mine"}}\n'):
            config.write_text(text)
            before = self.snapshot()
            self.run_cli("connect", "--peers", "claude-code", "--node", str(self.node), "--apply", code=2)
            self.assertEqual(before, self.snapshot())

    def test_codex_reapply_preserves_tables_added_after_the_managed_block(self):
        self.install()
        config = self.project / ".codex/config.toml"
        config.parent.mkdir()
        original = 'model = "existing"'
        config.write_text(original)
        self.connect()
        suffix = "[features]\nx=true\n"
        with config.open("a") as handle:
            handle.write(suffix)
        expected = config.read_bytes()
        for _ in range(3):
            self.assertEqual(self.connect()["changed"], [])
            self.assertEqual(config.read_bytes(), expected)
        self.connect(peers=("antigravity",))
        parsed = tomllib.loads(config.read_text())
        self.assertEqual(parsed["model"], "existing")
        self.assertEqual(parsed["features"], {"x": True})
        self.assertTrue(config.read_text().startswith(original + "\n"))
        self.assertTrue(config.read_text().endswith(suffix))

    def test_codex_changed_managed_block_is_not_overwritten(self):
        self.install()
        self.connect()
        config = self.project / ".codex/config.toml"
        config.write_text(config.read_text().replace('MCP_CALLER_AGENT" = "codex', 'MCP_CALLER_AGENT" = "user-edited'))
        before = self.snapshot()
        self.run_cli("connect", "--peers", "claude-code", "--node", str(self.node), "--apply", code=2)
        self.assertEqual(before, self.snapshot())

    def test_claude_preserves_unrelated_entries_and_tracks_ownership(self):
        self.install()
        config = self.project / ".mcp.json"
        original = {"custom": {"credential": "keep locally"}, "mcpServers": {"other": {"command": "other"}}}
        config.write_text(json.dumps(original))
        self.connect("claude-code", ("codex",))
        data = json.loads(config.read_text())
        self.assertEqual(data["custom"], original["custom"])
        self.assertEqual(data["mcpServers"]["other"], original["mcpServers"]["other"])
        before = self.snapshot()
        self.assertEqual(self.connect("claude-code", ("codex",))["changed"], [])
        self.assertEqual(before, self.snapshot())
        self.connect("claude-code", ("antigravity",))
        self.assertEqual(set(json.loads(config.read_text())["mcpServers"]), {"other", "cro_antigravity"})
        data = json.loads(config.read_text())
        data["mcpServers"]["cro_antigravity"]["command"] = "user edited"
        config.write_text(json.dumps(data))
        before = self.snapshot()
        self.run_cli("connect", "--client", "claude-code", "--peers", "codex", "--node", str(self.node), "--apply", code=2)
        self.assertEqual(before, self.snapshot())

    def test_claude_unowned_collision_and_config_symlink_fail(self):
        self.install()
        config = self.project / ".mcp.json"
        config.write_text('{"mcpServers":{"cro_codex":{"command":"mine"}}}')
        before = self.snapshot()
        self.run_cli("connect", "--client", "claude-code", "--peers", "codex", "--node", str(self.node), "--apply", code=2)
        self.assertEqual(before, self.snapshot())
        config.unlink()
        outside = self.root / "outside-config"
        outside.write_text("{}")
        config.symlink_to(outside)
        self.run_cli("connect", "--client", "claude-code", "--peers", "codex", "--node", str(self.node), "--apply", code=2)
        self.assertEqual(outside.read_text(), "{}")

    def test_failed_config_write_rolls_back_config_and_manifests(self):
        self.install()
        self.connect()
        before = self.snapshot()
        real_replace = os.replace
        failed = False
        manifest = self.project / setup.connection_paths("codex")[1]

        def fail_manifest(source, target):
            nonlocal failed
            if Path(target) == manifest and not failed:
                failed = True
                raise OSError("injected manifest failure")
            return real_replace(source, target)

        with mock.patch.object(setup.os, "replace", side_effect=fail_manifest):
            self.run_cli("connect", "--peers", "antigravity", "--node", str(self.node), "--apply", code=2)
        after = self.snapshot()
        self.assertEqual(before, {key: after[key] for key in before})

    def test_prepare_after_apply_does_not_claim_new_selection_is_applied(self):
        self.initialize()
        self.connect()
        before = (self.project / ".codex/config.toml").read_bytes()
        self.connect(peers=("antigravity",), apply=False)
        self.assertEqual(before, (self.project / ".codex/config.toml").read_bytes())
        status = self.run_cli("doctor")["checks"]["configuration"]
        self.assertEqual(status["applied"], "consistent")
        self.assertFalse(status["selection_applied"])

    def test_doctor_compares_explicit_peers_with_the_applied_selection(self):
        self.initialize()
        self.connect()
        before = self.snapshot()
        output = self.run_cli("doctor", "--peers", "antigravity")
        status = output["checks"]["configuration"]
        self.assertEqual(status["applied"], "consistent")
        self.assertEqual(status["requested_peers"], ["antigravity"])
        self.assertFalse(status["selection_generated"])
        self.assertFalse(status["selection_applied"])
        self.assertIn("connect", output["next_action"])
        self.assertIn("--peers antigravity", output["next_action"])
        self.assertEqual(before, self.snapshot())

    def test_antigravity_project_apply_preserves_other_servers(self):
        self.install()
        config = self.project / ".agents/mcp_config.json"
        config.write_text(json.dumps({"mcpServers": {"other": {"command": "existing"}}}))
        output = self.connect("antigravity", ("codex",))
        self.assertEqual(output["applied"], str(config))
        self.assertEqual(json.loads(config.read_text())["mcpServers"]["other"], {"command": "existing"})
        self.assertTrue((self.project / output["backup"] / ".agents/mcp_config.json").is_file())
        self.assertEqual(self.connect("antigravity", ("codex",))["changed"], [])
        self.assertFalse((self.project / ".codex").exists())
        self.assertFalse((self.project / ".mcp.json").exists())

    def test_doctor_is_read_only_and_missing_optional_node_is_nonblocking(self):
        self.initialize()
        before = self.snapshot()
        with mock.patch.object(setup.shutil, "which", return_value=None):
            output = self.run_cli("doctor", "--peers", "claude-code")
        self.assertTrue(output["basic_research_ready"])
        self.assertEqual(output["checks"]["node"]["status"], "missing")
        self.assertEqual(before, self.snapshot())
        self.assertFalse((self.project / ".agent-bridge").exists())
        self.assertEqual(output["authentication"], "not-verified")
        untouched = self.root / "nonexistent"
        output = self.run_cli("doctor", project=untouched)
        self.assertFalse(untouched.exists())
        self.assertEqual(output["checks"]["skill"]["status"], "source-only")

    def test_doctor_recognizes_manual_skill_and_provider_presence_only(self):
        self.initialize()
        (self.project / setup.RECEIPT_PATH).unlink()
        with mock.patch.object(setup.shutil, "which", side_effect=lambda value: str(self.node) if value == "node" else str(self.provider)):
            output = self.run_cli("doctor", "--peers", "claude-code")
        self.assertEqual(output["checks"]["skill"]["status"], "manual-install")
        self.assertEqual(output["checks"]["providers"]["claude-code"]["authentication"], "not-verified")

    def test_unsupported_python_has_an_actionable_error_in_both_entries(self):
        for script in (self.bundle / "setup.py", self.skill / "scripts/research_setup.py"):
            program = ("import runpy, sys; sys.version_info = (3, 10, 0); "
                       "sys.argv = [sys.argv[1], '--json']; runpy.run_path(sys.argv[0], run_name='__main__')")
            completed = subprocess.run([sys.executable, "-c", program, str(script)], capture_output=True, text=True)
            self.assertEqual(completed.returncode, 2, completed.stderr)
            self.assertIn("Python 3.11", json.loads(completed.stdout)["error"])
            self.assertNotIn("Traceback", completed.stderr)

    def test_doctor_incomplete_optional_runtime_does_not_block_research(self):
        self.initialize()
        (self.project / setup.RUNTIME_PATH / "package.json").unlink()
        before = self.snapshot()
        output = self.run_cli("doctor")
        self.assertTrue(output["basic_research_ready"])
        self.assertEqual(output["checks"]["runtime"]["status"], "needs-attention")
        self.assertEqual(before, self.snapshot())

    def test_cli_errors_and_root_entry_are_helpful(self):
        self.install()
        for args in (("connect",), ("connect", "--peers", "codex"), ("init",), ("unknown",)):
            output = self.run_cli(*args, code=2)
            self.assertIn("next_action", output)
        self.node.write_text("#!/bin/sh\nprintf 'v22.1.0\\n'\n")
        self.run_cli("connect", "--peers", "claude-code", "--node", str(self.node), code=2)
        completed = subprocess.run([sys.executable, str(self.bundle / "setup.py"), "--help"], capture_output=True, text=True)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("install", completed.stdout)
        self.assertIn("doctor", completed.stdout)


if __name__ == "__main__":
    unittest.main()
