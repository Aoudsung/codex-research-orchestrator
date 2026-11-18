#!/usr/bin/env python3
"""Summarize phase timing from a retained controller and provider capture."""

import argparse
from datetime import datetime
import json
from math import isfinite
from pathlib import Path
import re
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


TRACE_NAME = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9._-]*")
PROVIDER_TRACE = re.compile(r"exec-(\d+)\.ndjson")
CLI_STAMP = re.compile(r"^[IWEF](\d{4}) (\d{2}:\d{2}:\d{2}\.\d{1,6})")
CLI_MARKERS = {
    "startup": "Starting language server process",
    "prompt": "Sending user message to conversation",
    "latestStream": "streamGenerateContent?alt=sse",
    "terminated": "Got signal terminated",
}


def number(value):
    return value if type(value) in (int, float) and isfinite(value) and value >= 0 else None


def delta(start, end):
    return round(end - start, 3) if start is not None and end is not None and end >= start else None


def read_object(path):
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected a JSON object")
    return data


def read_records(path, partial_files):
    rows = []
    if not path.is_file():
        return rows
    with path.open(encoding="utf-8") as stream:
        for line_no, line in enumerate(stream, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as error:
                if not line.endswith("\n"):
                    partial_files.append(path)
                    break
                raise ValueError(f"{path}:{line_no}: invalid JSON record") from error
            if not isinstance(row, dict):
                raise ValueError(f"{path}:{line_no}: expected a JSON object")
            rows.append(row)
    return rows


def rpc_interval(rows, method):
    for index, row in enumerate(rows):
        if row.get("direction") != "request":
            continue
        message = row["message"]
        if "id" not in message:
            continue
        name = message.get("method")
        params = message.get("params")
        tool = params.get("name") if name == "tools/call" and isinstance(params, dict) else None
        if method not in (name, tool):
            continue
        for reply in rows[index + 1:]:
            if reply.get("direction") == "response" and reply["message"].get("id") == message["id"]:
                return True, number(row.get("wallTime")), True, number(reply.get("wallTime"))
        return True, number(row.get("wallTime")), False, None
    return False, None, False, None


def cli_wall_time(stamp, start, end, timezone):
    launch = datetime.fromtimestamp(start, timezone).replace(tzinfo=None)
    dates = []
    for year in (launch.year - 1, launch.year, launch.year + 1):
        try:
            dates.append(datetime.strptime(f"{year}{stamp[1]} {stamp[2]}", "%Y%m%d %H:%M:%S.%f"))
        except ValueError:
            continue
    if not dates:
        return None
    # The launch anchors the yearless stamp. An ambiguous local time needs a process bound.
    local = min(dates, key=lambda value: abs(value - launch))
    candidates = set()
    for fold in (0, 1):
        wall = local.replace(tzinfo=timezone, fold=fold).timestamp()
        if wall >= start and (end is None or wall <= end) and (
            datetime.fromtimestamp(wall, timezone).replace(tzinfo=None) == local
        ):
            candidates.add(wall)
    return next(iter(candidates)) if len(candidates) == 1 else None


def cli_timestamps(path, start, end, timezone):
    events = dict.fromkeys(CLI_MARKERS)
    if timezone is None or not path.is_file():
        return events
    with path.open(encoding="utf-8") as stream:
        for line in stream:
            stamp = CLI_STAMP.match(line)
            if not stamp:
                continue
            for key, marker in CLI_MARKERS.items():
                if marker not in line or (key != "latestStream" and events[key] is not None):
                    continue
                events[key] = cli_wall_time(stamp, start, end, timezone)
    return events


def step_samples(rows):
    latest = {
        step["step_index"]: step
        for row in rows
        if isinstance(step := row.get("step_update"), dict) and type(step.get("step_index")) is int
    }
    samples = {}
    for label, kind in (("model", "agent_response"), ("tool", "tool")):
        completed = [step for step in latest.values() if step.get("step_type") == kind and step.get("state") == "DONE"]
        durations = [seconds for step in completed if (seconds := number(step.get("duration_seconds"))) is not None]
        samples[label] = {
            "completedCount": len(completed),
            "timedCompletedCount": len(durations),
            "completedDurationSeconds": round(sum(durations), 3) if durations else None,
        }
    return samples


def provider_captures(directory):
    for path in sorted(directory.glob("exec-*.ndjson")):
        serial = PROVIDER_TRACE.fullmatch(path.name)
        if serial is None:
            continue
        receipt_path = path.with_suffix(".process.json")
        receipt = read_object(receipt_path) if receipt_path.is_file() else {}
        start = number(receipt.get("startedWallTime"))
        yield {
            "path": path,
            "launchWallTime": start if start is not None else int(serial[1]) / 1e9,
            "launchTimeSource": "process receipt" if start is not None else "trace filename",
            "endWallTime": number(receipt.get("endedWallTime")),
            "recordedProcessElapsedSeconds": number(receipt.get("hostDurationSeconds")),
        }


def summarize_capture(capture, request, timezone, partial_files):
    path = capture["path"]
    start, end = capture["launchWallTime"], capture["endWallTime"]
    markers = cli_timestamps(path.with_suffix(".agy.log"), start, end, timezone)
    rows = read_records(path, partial_files)
    return {
        **{key: value for key, value in capture.items() if key != "path"},
        "requestToLaunchSeconds": delta(request, start),
        "requestToCliMarkersSeconds": {key: delta(request, stamp) for key, stamp in markers.items()},
        "latestStreamToTerminationSeconds": delta(markers["latestStream"], markers["terminated"]),
        "resultEventRecorded": any(row.get("event") == "result" for row in rows),
        "stepSamples": step_samples(rows),
    }


def timeline(run, phases, rpc_method, origin_trace=None, timezone=None):
    receipt = read_object(run / "receipt.json")
    partial_files = []

    def controller_rows(label):
        return read_records(run / "controller" / f"{label}.mcp.jsonl", partial_files)

    origin_rows = controller_rows(origin_trace) if origin_trace else []
    origin = number(origin_rows[0].get("wallTime")) if origin_rows else None
    recorded = {item["phase"]: item for item in receipt.get("phaseTimings", [])}
    profiles = {profile: run / f"provider-{profile}" for _, profile in phases}
    sessions = {}
    for profile, directory in profiles.items():
        _, start, _, end = rpc_interval(read_records(directory / "acp.jsonl", partial_files), "session/new")
        sessions[profile] = delta(start, end)

    reports = {}
    for label, _ in phases:
        requested, request, responded, response = rpc_interval(controller_rows(label), rpc_method)
        report = {
            "status": "response recorded" if responded else "request recorded" if requested else "not started",
            "requestWallTime": request,
            "responseWallTime": response,
            "originToRequestSeconds": delta(origin, request),
            "requestToResponseSeconds": delta(request, response),
            "providerCaptureStatus": "not observed",
            "provider": None,
        }
        if label in recorded:
            record = recorded[label]
            report["controllerTiming"] = {
                key: record[key] for key in (
                    "status", "startedWallTime", "startedOffsetSeconds", "endedOffsetSeconds", "durationSeconds"
                ) if key in record
            }
            if not requested:
                report["status"] = "controller phase recorded"
        reports[label] = report

    for profile, directory in profiles.items():
        matching = {}
        ambiguous = set()
        for capture in provider_captures(directory):
            launch = capture["launchWallTime"]
            labels = [
                label for label, bound in phases if bound == profile
                and (request := reports[label]["requestWallTime"]) is not None and request <= launch
                and ((response := reports[label]["responseWallTime"]) is None or launch <= response)
            ]
            if len(labels) == 1:
                matching.setdefault(labels[0], []).append(capture)
            else:
                ambiguous.update(labels)
        for label, bound in phases:
            if bound != profile:
                continue
            captures = matching.get(label, [])
            if label in ambiguous or len(captures) > 1:
                reports[label]["providerCaptureStatus"] = "ambiguous"
            elif captures:
                reports[label]["providerCaptureStatus"] = "matched by profile and request window"
                reports[label]["provider"] = summarize_capture(
                    captures[0], reports[label]["requestWallTime"], timezone, partial_files
                )

    return {
        "status": receipt.get("status"),
        "recordedRunElapsedSeconds": number(receipt.get("elapsedSeconds")),
        "originTrace": origin_trace,
        "originWallTime": origin,
        "cliTimezone": timezone.key if timezone else None,
        "acpSessionNewSeconds": sessions,
        "phases": reports,
        "partialTraceFiles": sorted({str(path.relative_to(run)) for path in partial_files}),
    }


def phase_pair(value):
    phase, _, profile = value.partition("=")
    if not TRACE_NAME.fullmatch(phase) or not TRACE_NAME.fullmatch(profile):
        raise argparse.ArgumentTypeError("expected TRACE=PROFILE using letters, digits, dots, hyphens or underscores")
    return phase, profile


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path, help="directory containing receipt.json and the retained traces")
    parser.add_argument("--phase", action="append", type=phase_pair, required=True,
                        help="repeat TRACE=PROFILE for controller/TRACE.mcp.jsonl and provider-PROFILE/")
    parser.add_argument("--rpc-method", required=True, help="find the first request for this RPC method or MCP tool")
    parser.add_argument("--origin-trace", help="use the first wall time in controller/TRACE.mcp.jsonl as an origin")
    parser.add_argument("--cli-timezone", help="IANA timezone of provider CLI timestamps, if known")
    args = parser.parse_args(argv)
    if args.origin_trace and not TRACE_NAME.fullmatch(args.origin_trace):
        parser.error("--origin-trace requires a trace name")
    if len(dict(args.phase)) != len(args.phase):
        parser.error("each --phase trace name must be unique")
    try:
        timezone = ZoneInfo(args.cli_timezone) if args.cli_timezone else None
        result = timeline(args.run, args.phase, args.rpc_method, args.origin_trace, timezone)
    except (KeyError, OSError, ValueError, ZoneInfoNotFoundError) as error:
        parser.exit(1, f"{parser.prog}: {error}\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
