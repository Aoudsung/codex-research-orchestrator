"""Focused memory/context regressions; run with stdlib unittest discovery."""

import contextlib
import importlib.util
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "skills/codex-research-orchestrator/scripts/research_memory.py"
SPEC = importlib.util.spec_from_file_location("research_memory", SCRIPT)
memory_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(memory_module)
Memory = memory_module.Memory
MemoryError = memory_module.MemoryError


class MemoryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.project = Path(self.directory.name) / "project"
        self.project.mkdir()
        self.write("control.txt", "Current goal: inspect the mechanism.\nPermission: read only.\n")
        self.memory = Memory(self.project, ["control.txt"])
        self.addCleanup(lambda: self.memory.close())
        self.serial = 0

    def write(self, path, body):
        destination = self.project / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open("w", encoding="utf-8", newline="") as handle:
            handle.write(body)

    def remember(self, body="alpha evidence", kind="evidence", **overrides):
        self.serial += 1
        source = overrides.pop("source", "source-" + str(self.serial) + ".txt")
        self.write(source, body)
        data = {"kind": kind, "title": "Material " + str(self.serial), "summary": "Retrieval aid",
                "source": source, "scope": "Version 1; stated conditions only"}
        data.update(overrides)
        return self.memory.remember(data)

    def context(self, output="packet.txt", **kwargs):
        options = {"query": "alpha", "profile": "resume", "max_chars": 100000, "output": output}
        options.update(kwargs)
        return self.memory.context(**options)

    def packet(self, output="packet.txt"):
        return memory_module.text_file(self.project / output)

    def test_durable_search_and_full_read_preserve_snapshot_and_provenance(self):
        body = "alpha\r\nFull source, including line endings.\r\n" + "detail " * 200
        record_id = self.remember(body, claim_status="supported")
        self.memory.close()
        self.memory = Memory(self.project)
        result = self.memory.search("alpha")
        self.assertEqual([record_id], [row["id"] for row in result["results"]])
        self.assertNotIn("body", result["results"][0])
        self.assertEqual(len(body), result["results"][0]["chars"])
        row = self.memory.read(record_id)
        self.assertEqual(body, row["body"])
        self.assertEqual("current", row["state"])
        self.assertEqual("source-1.txt", row["source"])
        self.assertTrue(row["created_at"])

    def test_changed_source_invalidates_transitive_dependents_during_search(self):
        source = self.remember("alpha raw", kind="source")
        claim = self.remember("alpha derivation", kind="claim", depends_on=[source], claim_status="derived")
        decision = self.remember("alpha action", kind="decision", depends_on=[claim])
        self.write("source-1.txt", "beta raw")
        result = self.memory.search("alpha")
        self.assertEqual([], result["results"])
        for record_id in (source, claim, decision):
            self.assertEqual("needs_review", self.memory.record(record_id)["state"])
        self.assertEqual("derived", self.memory.record(claim)["claim_status"])
        self.assertEqual("alpha raw", self.memory.read(source)["body"])
        with self.assertRaises(MemoryError):
            self.remember(depends_on=[decision])

    def test_newer_claim_does_not_automatically_refute_older_claim(self):
        old = self.remember("alpha holds under condition A", kind="claim", claim_status="supported")
        new = self.remember("alpha fails under condition B", kind="claim", claim_status="refuted")
        self.assertEqual("current", self.memory.read(old)["state"])
        self.assertEqual("supported", self.memory.read(old)["claim_status"])
        self.assertEqual("refuted", self.memory.read(new)["claim_status"])
        self.assertEqual(2, len(self.memory.search("alpha")["results"]))

    def test_supersession_and_withdrawal_propagate_without_refutation(self):
        old = self.remember("alpha old", kind="source")
        child = self.remember("alpha child", kind="claim", depends_on=[old], claim_status="supported")
        grandchild = self.remember("alpha consequence", kind="decision", depends_on=[child])
        new = self.remember("alpha new", kind="source", supersedes=old, reason="Corrected measurement")
        self.assertEqual("superseded", self.memory.record(old)["state"])
        self.assertEqual(old, self.memory.read(new)["supersedes"])
        for record_id in (child, grandchild):
            self.assertEqual("needs_review", self.memory.record(record_id)["state"])
        self.assertEqual("supported", self.memory.record(child)["claim_status"])
        next_child = self.remember("alpha new child", depends_on=[new])
        self.memory.withdraw(new, "Measurement withdrawn by author")
        self.assertEqual("withdrawn", self.memory.read(new)["state"])
        self.assertEqual("needs_review", self.memory.read(next_child)["state"])
        self.assertEqual("alpha old", self.memory.read(old)["body"])

    def test_supersession_cannot_make_its_own_dependency_unavailable(self):
        old = self.remember(kind="source")
        child = self.remember(depends_on=[old])
        count = self.memory.db.execute("SELECT count(*) FROM records").fetchone()[0]
        with self.assertRaises(MemoryError):
            self.remember(supersedes=old, reason="Replacement", depends_on=[child])
        self.assertEqual(count, self.memory.db.execute("SELECT count(*) FROM records").fetchone()[0])
        self.assertEqual("current", self.memory.record(old)["state"])

    def test_control_append_is_fresh_and_full_without_reindex(self):
        record_id = self.remember()
        self.context(output="before.txt", profile="analysis", allow=[record_id])
        control = memory_module.text_file(self.project / "control.txt") + "PAUSE: do not run experiments until authorized.\n"
        self.write("control.txt", control)
        self.context(profile="analysis", allow=[record_id])
        self.assertIn(control, self.packet())
        self.assertNotIn("PAUSE", self.packet("before.txt"))
        self.assertNotIn("control.txt", self.packet())
        (self.project / "control.txt").unlink()
        with self.assertRaises(MemoryError):
            self.context(output="missing-control.txt", profile="analysis", allow=[record_id])
        self.assertFalse((self.project / "missing-control.txt").exists())

    def test_mandatory_overflow_does_not_create_packet_or_manifest(self):
        required = self.remember("alpha " + "required text " * 200)
        manifest = self.context(output="large.txt", required=[required])
        with self.assertRaises(MemoryError):
            self.context(output="too-small.txt", required=[required], max_chars=manifest["packet_chars"] - 1)
        self.assertFalse((self.project / "too-small.txt").exists())
        self.assertFalse((self.project / "too-small.txt.manifest.json").exists())
        with self.assertRaises(MemoryError):
            self.context(output="control-overflow.txt", max_chars=1)
        self.assertFalse((self.project / "control-overflow.txt").exists())

    def test_review_requires_full_current_proposal_even_without_query_match(self):
        source = self.remember("alpha source", kind="source")
        body = "Complete proposal\n" + "Definition, assumption, and derivation.\n" * 120 + "FINAL CONDITION"
        target = self.remember(body, kind="proposal", depends_on=[source])
        manifest = self.context(profile="review", allow=[source, target], target=target)
        self.assertIn(body, self.packet())
        self.assertEqual(target, manifest["selected_ids"][0])
        self.assertIn("Target proposal", self.packet())
        self.write("source-2.txt", body + "\nNew version")
        with self.assertRaises(MemoryError):
            self.context(output="stale-target.txt", profile="review", allow=[source, target], target=target)
        self.assertFalse((self.project / "stale-target.txt").exists())
        with self.assertRaises(MemoryError):
            self.context(output="no-target.txt", profile="review", allow=[source])

    def test_whole_record_budget_and_unicode_character_count(self):
        first_body = "alpha " + "\U0001f9ea e\u0301 \u03bb \u65e5\u672c\u8a9e\n" * 50
        first = self.remember(first_body)
        second_body = "alpha " + "second record " * 100
        second = self.remember(second_body)
        with patch.object(memory_module, "now", return_value="2026-10-21T00:00:00+00:00"):
            one = self.context(output="one.txt", profile="analysis", allow=[first], required=[first])
            exact = self.context(output="exact.txt", profile="analysis", allow=[first, second], required=[first], max_chars=one["packet_chars"])
        packet = self.packet("exact.txt")
        self.assertEqual(one["packet_chars"], len(packet))
        self.assertEqual(len(packet), exact["packet_chars"])
        self.assertGreater(len(packet.encode("utf-8")), len(packet))
        self.assertEqual([first], exact["selected_ids"])
        self.assertIn(first_body, packet)
        self.assertNotIn(second_body, packet)
        self.assertTrue(any(entry["id"] == second and "budget" in entry["reason"] for entry in exact["omissions"]))

    def test_excluded_evaluations_do_not_change_independent_ranking_or_packet(self):
        first = self.remember("alpha alpha beta " + "padding " * 30, title="First admitted")
        second = self.remember("alpha beta beta", title="Second admitted")
        allow = [first, second]
        with patch.object(memory_module, "now", return_value="2026-10-21T00:00:00+00:00"):
            before_search = self.memory.search("alpha beta", profile="analysis", allow=allow)
            before = self.context(output="before.txt", query="alpha beta", profile="analysis", allow=allow)
            for index in range(12):
                self.remember("alpha " * 300, kind="evaluation", title="SECRET_EXPECTED_ANSWER_" + str(index),
                              source="secret-review-" + str(index) + ".txt", scope="PRIVATE_REVIEW_SCOPE")
            after_search = self.memory.search("alpha beta", profile="analysis", allow=allow)
            after = self.context(output="after.txt", query="alpha beta", profile="analysis", allow=allow,
                                 max_chars=before["packet_chars"])
        self.assertEqual(before_search, after_search)
        self.assertEqual(before["selected_ids"], after["selected_ids"])
        self.assertEqual(self.packet("before.txt"), self.packet("after.txt"))
        for forbidden in ("SECRET_EXPECTED_ANSWER", "secret-review-", "PRIVATE_REVIEW_SCOPE", "evaluation"):
            self.assertNotIn(forbidden, self.packet("after.txt"))

    def test_disallowed_and_transitively_disallowed_material_is_rejected(self):
        evaluation = self.remember(kind="evaluation")
        evidence = self.remember(depends_on=[evaluation])
        downstream = self.remember(kind="source", depends_on=[evidence])
        for allow in ([evaluation], [evidence], [downstream, evidence], [downstream, evidence, evaluation]):
            with self.assertRaises(MemoryError):
                self.context(profile="analysis", allow=allow)
            self.assertFalse((self.project / "packet.txt").exists())
        with self.assertRaises(MemoryError):
            self.context(profile="analysis")
        with self.assertRaises(MemoryError):
            self.context(profile="analysis", allow=[self.remember()], required=[evaluation])

    def test_allowed_dependency_changes_invalidate_selected_evidence(self):
        source = self.remember("unrelated origin", kind="source")
        evidence = self.remember("alpha consequence", depends_on=[source])
        self.write("source-1.txt", "different origin")
        with self.assertRaises(MemoryError):
            self.context(profile="analysis", allow=[source, evidence], required=[evidence])
        self.assertEqual("needs_review", self.memory.record(evidence)["state"])
        self.assertFalse((self.project / "packet.txt").exists())

    def test_missing_source_is_explicit_and_does_not_disappear_after_first_check(self):
        record_id = self.remember()
        (self.project / "source-1.txt").unlink()
        for _ in range(2):
            with self.assertRaises(MemoryError):
                self.memory.search("unmatched")
        row = self.memory.read(record_id)
        self.assertEqual("needs_review", row["state"])
        self.assertIn("Cannot read", row["state_reason"])

    def test_exact_word_retrieval_and_literal_query_safety(self):
        record_id = self.remember("alpha measurement")
        self.assertEqual([], self.memory.search("alph")["results"])
        self.assertEqual([record_id], [row["id"] for row in self.memory.search('alpha OR \" ) NOT unknown*')["results"]])
        with self.assertRaises(MemoryError):
            self.memory.search('"***()')

    def test_reinitialization_preserves_data_and_rejects_config_changes(self):
        record_id = self.remember()
        repeated = Memory(self.project, ["control.txt"])
        try:
            self.assertEqual(record_id, repeated.read(record_id)["id"])
        finally:
            repeated.close()
        self.write("other-control.txt", "Different permissions")
        with self.assertRaises(MemoryError):
            Memory(self.project, ["other-control.txt"])
        self.assertEqual("current", self.memory.read(record_id)["state"])

    def test_project_isolation_and_source_path_escape(self):
        outside = Path(self.directory.name) / "outside.txt"
        outside.write_text("secret external text", encoding="utf-8")
        data = {"kind": "source", "title": "Unsafe", "summary": "Unsafe", "scope": "Test"}
        (self.project / "escape.txt").symlink_to(outside)
        for source in (str(outside), "../outside.txt", "escape.txt"):
            with self.assertRaises(MemoryError):
                self.memory.remember(dict(data, source=source))
        other = Path(self.directory.name) / "other-project"
        other.mkdir()
        (other / "control.txt").write_text("Other project", encoding="utf-8")
        other_memory = Memory(other, ["control.txt"])
        try:
            self.remember("alpha local only")
            self.assertEqual([], other_memory.search("alpha")["results"])
        finally:
            other_memory.close()
        shutil.copy2(self.project / ".research-memory/memory.sqlite3", other / ".research-memory/memory.sqlite3")
        with self.assertRaises(MemoryError):
            Memory(other)

    def test_changed_source_symlink_cannot_escape_project(self):
        record_id = self.remember()
        outside = Path(self.directory.name) / "outside.txt"
        outside.write_text("alpha evidence", encoding="utf-8")
        (self.project / "source-1.txt").unlink()
        (self.project / "source-1.txt").symlink_to(outside)
        with self.assertRaises(MemoryError):
            self.memory.search("alpha")
        self.assertEqual("needs_review", self.memory.record(record_id)["state"])

    def test_existing_output_or_manifest_is_never_overwritten(self):
        self.remember()
        self.context()
        original = self.packet()
        with self.assertRaises(MemoryError):
            self.context()
        self.assertEqual(original, self.packet())
        self.write("other.txt.manifest.json", "keep existing manifest")
        with self.assertRaises(MemoryError):
            self.context(output="other.txt")
        self.assertFalse((self.project / "other.txt").exists())
        self.assertEqual("keep existing manifest", self.packet("other.txt.manifest.json"))

    def test_cli_round_trip_and_failure_exit_code(self):
        self.write("record.json", json.dumps({"kind": "source", "title": "CLI source", "summary": "Short",
                                              "scope": "Current", "source": "control.txt"}))
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = memory_module.main(["--project", str(self.project), "remember", "record.json"])
        self.assertEqual(0, code)
        record_id = json.loads(output.getvalue())["id"]
        with contextlib.redirect_stdout(io.StringIO()):
            code = memory_module.main(["--project", str(self.project), "context", "mechanism", "--profile", "analysis",
                                       "--allow", str(record_id), "--require", str(record_id), "--max-chars", "10000", "--output", "cli.txt"])
        self.assertEqual(0, code)
        self.assertTrue((self.project / "cli.txt.manifest.json").exists())
        with contextlib.redirect_stderr(io.StringIO()):
            code = memory_module.main(["--project", str(self.project), "context", "mechanism", "--max-chars", "1", "--output", "failure.txt"])
        self.assertEqual(2, code)
        self.assertFalse((self.project / "failure.txt").exists())

    def test_context_cli_keeps_large_omission_manifest_out_of_response(self):
        selected = self.remember("alpha relevant source")
        for index in range(30):
            self.remember("unrelated material " + str(index))
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = memory_module.main(["--project", str(self.project), "context", "alpha",
                                       "--max-chars", "10000", "--output", "compact.txt"])
        self.assertEqual(0, code)
        result = json.loads(output.getvalue())
        manifest = json.loads((self.project / result["manifest"]).read_text())
        self.assertEqual([selected], manifest["selected_ids"])
        self.assertEqual(30, result["omitted_count"])
        self.assertEqual(30, result["indexed_omission_count"])
        self.assertEqual(1, result["selected_count"])
        self.assertEqual(len(self.packet("compact.txt")), result["packet_chars"])
        self.assertNotIn("omissions", result)
        self.assertNotIn("sources", result)
        self.assertLess(len(output.getvalue()), 500)

    def test_packet_counts_and_indexes_every_omitted_record_within_budget(self):
        matched = self.remember("alpha matched")
        large_body = "alpha " + "large body " * 400
        large = self.remember(large_body)
        unmatched = [self.remember("unrelated " + str(index)) for index in range(3)]
        manifest = self.context(max_chars=3000)
        packet = self.packet()
        self.assertLessEqual(len(packet), 3000)
        self.assertEqual([matched], manifest["selected_ids"])
        self.assertIn("Not shown: 4 of 5 admitted records. Indexed below: 4.", packet)
        order = [entry["id"] for entry in manifest["omissions"]]
        self.assertEqual([large] + unmatched[::-1], order)
        self.assertIn("Record " + str(large) + " | evidence | Material 2 | " + str(len(large_body)) + " chars | over budget\n", packet)
        self.assertEqual(["Record " + str(value) for value in order], [entry["index_label"] for entry in manifest["omissions"]])
        tight = self.context(output="tight.txt", max_chars=len(packet) - 1)
        tight_packet = self.packet("tight.txt")
        self.assertLessEqual(len(tight_packet), len(packet) - 1)
        indexed = [entry["id"] for entry in tight["omissions"] if "index_label" in entry]
        self.assertEqual(order[:len(indexed)], indexed)
        self.assertEqual(3, len(indexed))
        self.assertIn("Not shown: 4 of 5 admitted records. Indexed below: 3.", tight_packet)
        self.assertEqual(order, [entry["id"] for entry in tight["omissions"]])

    def test_independent_index_uses_neutral_labels_without_titles_or_paths(self):
        shown = self.remember("alpha shown", title="PRIVATE_TITLE_SHOWN")
        hidden = self.remember("unmatched text", title="PRIVATE_TITLE_HIDDEN", source="private-path.txt",
                               scope="Lab protocol B;\nfirst run only")
        manifest = self.context(profile="analysis", allow=[shown, hidden])
        packet = self.packet()
        self.assertIn("Not shown: 1 of 2 admitted records. Indexed below: 1.", packet)
        self.assertIn("Omitted material 1 | 14 chars | no query match | Scope: Lab protocol B; first run only\n", packet)
        for forbidden in ("PRIVATE_TITLE", "private-path", "Record "):
            self.assertNotIn(forbidden, packet)
        self.assertEqual([{"id": hidden, "reason": "no lexical query match", "index_label": "Omitted material 1"}],
                         manifest["omissions"])

    def test_fill_recent_adds_unmatched_records_newest_first_within_budget(self):
        matched = self.remember("alpha matched")
        older = self.remember("older unmatched " + "x" * 300)
        newer = self.remember("newer unmatched " + "y" * 300)
        self.assertEqual([matched], self.context(output="plain.txt")["selected_ids"])
        filled = self.context(output="filled.txt", fill_recent=True)
        self.assertEqual([matched, newer, older], filled["selected_ids"])
        self.assertEqual([], filled["omissions"])
        tight = self.context(output="tight.txt", fill_recent=True, max_chars=filled["packet_chars"] - 1)
        self.assertEqual([matched, newer], tight["selected_ids"])
        self.assertEqual([{"id": older, "reason": "whole record exceeds remaining character budget",
                           "index_label": "Record " + str(older)}], tight["omissions"])
        self.assertLessEqual(tight["packet_chars"], filled["packet_chars"] - 1)

    def test_timestamp_is_last_so_rebuilt_packets_share_all_leading_text(self):
        self.remember()
        with patch.object(memory_module, "now", return_value="2026-10-21T00:00:00+00:00"):
            self.context(output="first.txt")
        with patch.object(memory_module, "now", return_value="2026-10-22T09:30:00+00:00"):
            self.context(output="second.txt")
        first, second = self.packet("first.txt"), self.packet("second.txt")
        cut = first.index("Assembled at ")
        self.assertEqual(first[:cut], second[:cut])
        self.assertNotEqual(first, second)
        self.assertTrue(first.endswith("Assembled at 2026-10-21T00:00:00+00:00.\n"))

    def test_refresh_preserves_concurrent_withdrawal_and_supersession(self):
        other = Memory(self.project)
        self.addCleanup(other.close)
        for terminal in ("withdrawn", "superseded"):
            with self.subTest(terminal=terminal):
                record_id = self.remember("alpha original")
                source = self.memory.record(record_id)["source"]
                self.write(source, "alpha changed")
                self.write("replacement.txt", "alpha replacement")
                original_read = self.memory.read_source
                switched = False

                def interleaved_read(path):
                    nonlocal switched
                    body = original_read(path)
                    if path == source and not switched:
                        switched = True
                        if terminal == "withdrawn":
                            other.withdraw(record_id, "Withdrawn while refresh was reading")
                        else:
                            other.remember({"kind": "evidence", "title": "Replacement", "summary": "Current",
                                            "source": "replacement.txt", "scope": "Corrected conditions",
                                            "supersedes": record_id, "reason": "Replaced while refresh was reading"})
                    return body

                with patch.object(self.memory, "read_source", side_effect=interleaved_read):
                    result = self.memory.check([record_id])
                self.assertTrue(switched)
                self.assertEqual(terminal, self.memory.record(record_id)["state"])
                self.assertEqual(terminal, result[0]["state"])
                self.assertNotIn("Source text differs", result[0]["reason"])


if __name__ == "__main__":
    unittest.main()
