#!/usr/bin/env python3
"""Create a secret-scrubbed ZIP grounding bundle for ChatGPT Web Pro (`pro_macro`)."""

import argparse
import fnmatch
import hashlib
import json
import subprocess
import sys
import zipfile
from pathlib import Path

BLOCKED_SECRET_PATTERNS = (
    ".env",
    ".env.*",
    "*secret*",
    "*credential*",
    "*token*",
    "*.pem",
    "*.key",
    "*.p12",
    "id_rsa*",
    "id_ed25519*",
    "ssh_document.md",
    "*ssh_config*",
)

BLOCKED_DIRS = {
    ".git",
    ".pi",
    ".agent-bridge",
    ".research-memory",
    ".research-orchestrator",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
}

BLOCKED_SUFFIXES = (".pyc", ".pt", ".ckpt", ".safetensors")
DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024


def _is_secret_name(rel_path: Path) -> bool:
    for part in rel_path.parts:
        low = part.lower()
        for pat in BLOCKED_SECRET_PATTERNS:
            if fnmatch.fnmatch(low, pat):
                return True
    return False


def _blocked_reason(rel_path: Path, size: int, max_file_bytes: int) -> str | None:
    if _is_secret_name(rel_path):
        return "blocked_secret"
    for part in rel_path.parts[:-1]:
        if part in BLOCKED_DIRS:
            return "blocked_dir"
    if rel_path.name in BLOCKED_DIRS:
        return "blocked_dir"
    low_name = rel_path.name.lower()
    if any(low_name.endswith(sfx) for sfx in BLOCKED_SUFFIXES) or ".sqlite" in low_name:
        return "blocked_artifact"
    if size > max_file_bytes:
        return "exceeds_max_file_bytes"
    return None


def _git_metadata(project: Path) -> dict:
    def _run(args):
        return subprocess.run(
            ["git", "-C", str(project), *args],
            capture_output=True,
            text=True,
            check=False,
        )

    head_res = _run(["rev-parse", "HEAD"])
    if head_res.returncode != 0:
        return {"branch": None, "commit_sha": None, "dirty_summary": "not a git repository"}
    branch_res = _run(["rev-parse", "--abbrev-ref", "HEAD"])
    status_res = _run(["status", "--porcelain"])
    dirty_lines = []
    for raw in status_res.stdout.splitlines():
        if not raw.strip():
            continue
        rel_str = raw[3:].strip().split(" -> ")[-1].strip('"')
        if _is_secret_name(Path(rel_str)):
            continue
        dirty_lines.append(raw[:2] + " " + rel_str)
    dirty_summary = f"{len(dirty_lines)} dirty path(s)" if dirty_lines else "clean"
    if dirty_lines:
        dirty_summary += ": " + ", ".join(dirty_lines[:12])
        if len(dirty_lines) > 12:
            dirty_summary += f" (+{len(dirty_lines) - 12} more)"
    return {
        "branch": branch_res.stdout.strip() or None,
        "commit_sha": head_res.stdout.strip() or None,
        "dirty_summary": dirty_summary,
    }


def _resolve_in_project(project: Path, raw_rel: str) -> Path:
    p = Path(raw_rel)
    if not raw_rel or p.is_absolute():
        raise ValueError(f"Path must be project-relative: {raw_rel}")
    resolved = (project / p).resolve()
    if not resolved.is_relative_to(project):
        raise ValueError(f"Path escapes project root: {raw_rel}")
    return resolved


def _line_count_label(data: bytes) -> str:
    if b"\x00" in data[:8192]:
        return "binary"
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return "binary"
    return str(len(text.splitlines()))


def build_pro_bundle(
    project: Path,
    output: Path,
    includes: list[str],
    prompt_file: str | None = None,
    max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
    include_sha256: bool = False,
) -> dict:
    project = project.resolve()
    if not project.is_dir():
        raise ValueError(f"Project directory does not exist: {project}")
    if not includes:
        raise ValueError("At least one --include path or glob is required.")

    output_resolved = output.resolve()
    selected: dict[str, Path] = {}
    skipped: dict[str, int] = {
        "blocked_secret": 0,
        "blocked_dir": 0,
        "blocked_artifact": 0,
        "exceeds_max_file_bytes": 0,
    }

    for pattern in includes:
        if any(ch in pattern for ch in "*?["):
            if Path(pattern).is_absolute():
                raise ValueError(f"Glob --include must be project-relative: {pattern}")
            matches = sorted(project.glob(pattern))
            if not matches:
                raise ValueError(f"Include glob matched no paths: {pattern}")
            for match in matches:
                resolved = match.resolve()
                if not resolved.is_relative_to(project):
                    raise ValueError(f"Include escapes project root: {pattern}")
                candidates = (
                    [resolved]
                    if resolved.is_file()
                    else sorted(p for p in resolved.rglob("*") if p.is_file())
                )
                for file_path in candidates:
                    if file_path.resolve() == output_resolved:
                        continue
                    rel = file_path.relative_to(project)
                    reason = _blocked_reason(rel, file_path.stat().st_size, max_file_bytes)
                    if reason:
                        skipped[reason] += 1
                        continue
                    selected[rel.as_posix()] = file_path
        else:
            target = _resolve_in_project(project, pattern)
            if not target.exists():
                raise ValueError(f"Included path does not exist: {pattern}")
            if target.is_file():
                rel = target.relative_to(project)
                reason = _blocked_reason(rel, target.stat().st_size, max_file_bytes)
                if reason:
                    raise ValueError(f"Explicitly included file rejected ({reason}): {rel.as_posix()}")
                if target.resolve() != output_resolved:
                    selected[rel.as_posix()] = target
            elif target.is_dir():
                for file_path in sorted(p for p in target.rglob("*") if p.is_file()):
                    resolved = file_path.resolve()
                    if not resolved.is_relative_to(project) or resolved == output_resolved:
                        continue
                    rel = resolved.relative_to(project)
                    reason = _blocked_reason(rel, resolved.stat().st_size, max_file_bytes)
                    if reason:
                        skipped[reason] += 1
                        continue
                    selected[rel.as_posix()] = resolved

    prompt_bytes = None
    prompt_rel = None
    if prompt_file:
        resolved_prompt = _resolve_in_project(project, prompt_file)
        if not resolved_prompt.is_file():
            raise ValueError(f"--prompt-file does not exist: {prompt_file}")
        rel_prompt = resolved_prompt.relative_to(project)
        if _is_secret_name(rel_prompt):
            raise ValueError(f"--prompt-file matches blocked secret pattern: {rel_prompt.as_posix()}")
        prompt_bytes = resolved_prompt.read_bytes()
        prompt_rel = rel_prompt.as_posix()

    git_meta = _git_metadata(project)
    manifest_rows = []
    total_bytes = 0
    output_resolved.parent.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(output_resolved, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for rel_posix in sorted(selected):
            data = selected[rel_posix].read_bytes()
            sha = hashlib.sha256(data).hexdigest() if include_sha256 else None
            lines = _line_count_label(data)
            total_bytes += len(data)
            manifest_rows.append((rel_posix, lines, len(data), sha))
            zf.writestr(rel_posix, data)

        if prompt_bytes is not None:
            zf.writestr("PRO_PROMPT.md", prompt_bytes)

        manifest_lines = [
            "# ChatGPT Web Pro Grounding Bundle Manifest",
            "",
            f"- Git Branch: `{git_meta['branch'] or 'UNOBSERVED'}`",
            f"- Git Commit: `{git_meta['commit_sha'] or 'UNOBSERVED'}`",
            f"- Working Tree: {git_meta['dirty_summary']}",
            f"- Included Files: {len(manifest_rows)} ({total_bytes} bytes)",
            f"- Skipped Counts: {json.dumps(skipped, sort_keys=True)}",
        ]
        if prompt_rel:
            manifest_lines.append(f"- Included Prompt: `PRO_PROMPT.md` (from `{prompt_rel}`)")
        if include_sha256:
            manifest_lines.extend(
                [
                    "",
                    "| Path | Lines | Bytes | SHA256 |",
                    "|---|---|---|---|",
                ]
            )
            for rel_posix, lines, size, sha in manifest_rows:
                manifest_lines.append(f"| `{rel_posix}` | {lines} | {size} | `{sha[:16]}` |")
        else:
            manifest_lines.extend(
                [
                    "",
                    "| Path | Lines | Bytes |",
                    "|---|---|---|",
                ]
            )
            for rel_posix, lines, size, _sha in manifest_rows:
                manifest_lines.append(f"| `{rel_posix}` | {lines} | {size} |")
        zf.writestr("BUNDLE_MANIFEST.md", "\n".join(manifest_lines) + "\n")

    return {
        "ok": True,
        "output": str(output_resolved),
        "commit_sha": git_meta["commit_sha"],
        "branch": git_meta["branch"],
        "file_count": len(manifest_rows),
        "total_bytes": total_bytes,
        "skipped": skipped,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--include", action="append", default=[])
    parser.add_argument("--prompt-file", default=None)
    parser.add_argument("--max-file-bytes", type=int, default=DEFAULT_MAX_FILE_BYTES)
    parser.add_argument("--include-sha256", action="store_true", help="Include truncated SHA-256 column in BUNDLE_MANIFEST.md")
    args = parser.parse_args(argv)

    try:
        receipt = build_pro_bundle(
            project=args.project,
            output=args.output,
            includes=args.include,
            prompt_file=args.prompt_file,
            max_file_bytes=args.max_file_bytes,
            include_sha256=args.include_sha256,
        )
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        return 2
    print(json.dumps(receipt, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
