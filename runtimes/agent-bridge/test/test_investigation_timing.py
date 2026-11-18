"""Check observable and missing timing data through the installed CLI contract."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


CLI = Path(__file__).resolve().parents[1] / "src/runtime/investigation_timing.py"


class InvestigationTimingTest(unittest.TestCase):
    def test_deadline_with_no_reviewer_and_incomplete_native_trace(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = Path(tmp)
            controller = run / "controller"
            provider = run / "provider-author"
            controller.mkdir()
            provider.mkdir()
            receipt = {"status": "incomplete", "elapsedSeconds": 19,
                       "phaseTimings": [{"phase": "edit", "status": "deadline", "durationSeconds": 17}]}
            (run / "receipt.json").write_text(json.dumps(receipt))
            request = {"direction": "request", "wallTime": 12,
                       "message": {"method": "tools/call", "id": 3, "params": {"name": "execute"}}}
            (controller / "edit.mcp.jsonl").write_text(json.dumps(request))
            (controller / "plan.mcp.jsonl").write_text(json.dumps({"wallTime": 10}))
            capture = provider / "exec-13000000000.ndjson"
            steps = [
                {"step_index": 1, "state": "RUNNING", "step_type": "agent_response", "duration_seconds": 4},
                {"step_index": 1, "state": "DONE", "step_type": "agent_response", "duration_seconds": 6},
                {"step_index": 2, "state": "DONE", "step_type": "tool"},
            ]
            capture.write_text("".join(json.dumps({"step_update": step}) + "\n" for step in steps) + '{"event"')
            result = subprocess.run([
                sys.executable, str(CLI), str(run), "--rpc-method", "execute", "--origin-trace", "plan",
                "--phase", "edit=author", "--phase", "review=reviewer",
            ], capture_output=True, check=True, text=True)
            record = json.loads(result.stdout)
            edit = record["phases"]["edit"]
            self.assertEqual(record["recordedRunElapsedSeconds"], 19)
            self.assertEqual(edit["originToRequestSeconds"], 2)
            self.assertEqual(edit["controllerTiming"]["durationSeconds"], 17)
            self.assertIsNone(edit["requestToResponseSeconds"])
            self.assertEqual(edit["provider"]["stepSamples"]["model"]["completedDurationSeconds"], 6)
            self.assertIsNone(edit["provider"]["stepSamples"]["tool"]["completedDurationSeconds"])
            self.assertIsNone(edit["provider"]["latestStreamToTerminationSeconds"])
            self.assertEqual(record["phases"]["review"]["status"], "not started")
            self.assertIn(str(capture.relative_to(run)), record["partialTraceFiles"])
