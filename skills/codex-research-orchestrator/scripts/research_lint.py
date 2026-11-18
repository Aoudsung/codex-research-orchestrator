#!/usr/bin/env python3
"""Read-only static and state linter for research workspaces (rules -> deterministic guards)."""
from __future__ import annotations

import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import tomllib

DOC_LINE_BUDGETS = {
    "AGENTS.md": 140,
    "controls.md": 120,
    "state.md": 120,
    "project.md": 180,
}

PROHIBITION_LINE_RE = re.compile(
    r"(?:禁止|严禁|不许|不可|不要|不得|切勿|绝不|\bDO\s+NOT\b|\bNEVER\b|\bFORBID(?:DEN)?\b)",
    re.IGNORECASE,
)
PATCH_PILE_HEADING_RE = re.compile(
    r"^#{1,6}\s+.*(?:补充说明|追加规则|新增补充|临时规则|后续补充)",
    re.MULTILINE,
)
STALE_FRAMEWORK_RE = re.compile(
    r"(?:/Users/aoudsung/Documents/Autoresearch-pipeline|\bDynaRT-RSI\b)",
    re.IGNORECASE,
)
FOREIGN_HOME_RE = re.compile(r"/Users/(?!Shared/)([A-Za-z0-9._-]+)/")
LEGACY_LEDGER_RE = re.compile(r"\b(?:research-log\.md|open-questions\.md)\b")
MEMORY_CLI_USAGE_RE = re.compile(r"python3\s+\S*research_memory\.py\b")

SECRET_OR_LEDGER_GIT_RE = re.compile(
    r"^(?:\.research-memory/|\.agent-bridge/|\.pi/|\.research-orchestrator/|(?:.*/)?\.env(?:\..*)?$|.*ssh_document.*|.*\.(?:pem|key)$)",
    re.IGNORECASE,
)

MAX_TOMBSTONE_WORDS = 40
PI_BLOAT_TOKENS = 180_000
DEFAULT_SOFT_JSONL_BYTES = 8 * 1024 * 1024

NEGATED_DYSCHOP_RE = re.compile(
    r"(?:(?:禁(?:用|止)?|严禁|不(?:准|许|可|要|得|使用|启用|允许)|avoid|without|forbid(?:den|s)?|prohibit(?:ed|s)?|ban(?:ned)?|never\s+use|do\s+not\s+use|don't\s+use|\bno\b)[^。\n]*?\bdyschop\b)"
    r"|(?:\bdyschop\b[^。\n]*?(?:disabled|banned|prohibited|forbidden|禁用|禁止|不用))",
    re.IGNORECASE,
)

NEGATED_LUNA_RE = re.compile(
    r"(?:禁止|严禁|勿|不要|不得|不可|never|do\s+not|don't|forbid(?:den)?|prohibit(?:ed)?|not\s+use|only\s+for\s+effort|仅用于[^\n。]*?强度|effort[_\s-]*judge[_\s-]*only)",
    re.IGNORECASE,
)

LUNA_EXEC_PAIR_RE = re.compile(
    r"(?:agent_type\s*=\s*['\"]?Luna['\"]?[^\n。]*?(?:monitor|watch|observe|status|ssh|log|exec|worker|写|读|监控|状态|巡检|执行))"
    r"|(?:(?:monitor|watch|observe|status|ssh|log|exec|worker|监控|状态|巡检|执行)[^\n。]*?agent_type\s*=\s*['\"]?Luna['\"]?)",
    re.IGNORECASE,
)


def _strip_historical_sections(text: str) -> str:
    lines = text.splitlines()
    kept = []
    skip_level = None
    for ln in lines:
        m = re.match(r"^(#{1,6})\s+(.*)$", ln)
        if m:
            level = len(m.group(1))
            heading = m.group(2)
            if skip_level is not None and level <= skip_level and not re.search(r"历史指令|historical", heading, re.IGNORECASE):
                skip_level = None
            if re.search(r"历史指令|historical\s+instructions", heading, re.IGNORECASE):
                skip_level = level
                continue
        if skip_level is None:
            kept.append(ln)
    return "\n".join(kept)


def _has_active_dyschop(text: str, strip_history: bool = False) -> bool:
    src = _strip_historical_sections(text) if strip_history else text
    for raw_line in src.splitlines():
        for clause in re.split(r"[。；;，,！!\r\n\"']+", raw_line):
            c = clause.strip()
            if not c or not re.search(r"\bdyschop\b", c, re.IGNORECASE):
                continue
            if not NEGATED_DYSCHOP_RE.search(c):
                return True
    return False


def _load_collaborator_policy(project: Path) -> dict | None:
    collab_path = project / ".agent-bridge" / "collaborators.json"
    if not collab_path.is_file() or collab_path.is_symlink():
        return None
    try:
        data = json.loads(collab_path.read_text(encoding="utf-8", errors="replace"))
        return data if isinstance(data, dict) else None
    except ValueError:
        return None


def _is_pinned_project_session(entry: object, proj_resolved: Path) -> bool:
    if not isinstance(entry, dict):
        return False
    if entry.get("status") == "historical_not_selected_for_future_dispatch":
        return False
    sid = entry.get("sessionId")
    if not isinstance(sid, str) or not sid.strip():
        return False
    raw_cwd = entry.get("cwd") or entry.get("workspaceRoot")
    if not isinstance(raw_cwd, str) or not raw_cwd.strip():
        return False
    cpath = Path(raw_cwd).resolve(strict=False)
    return cpath == proj_resolved or cpath.is_relative_to(proj_resolved)


HISTORICAL_OR_PROSE_KEYS = frozenset({"authority", "note", "notes", "reason", "description"})


def _strip_historical_json(obj: object) -> object:
    if isinstance(obj, dict):
        if obj.get("status") == "historical_not_selected_for_future_dispatch":
            return None
        cleaned = {}
        for k, v in obj.items():
            kl = str(k).lower()
            if kl in HISTORICAL_OR_PROSE_KEYS or re.match(r"^(?:previous|historical|archive)", kl):
                continue
            cv = _strip_historical_json(v)
            if cv is not None:
                cleaned[k] = cv
        return cleaned
    if isinstance(obj, list):
        return [cv for cv in (_strip_historical_json(x) for x in obj) if cv is not None]
    return obj


def _finding(rule_id: str, severity: str, path: str, message: str, detail: dict | None = None) -> dict:
    item = {
        "rule": rule_id,
        "severity": severity,
        "path": path,
        "message": message,
    }
    if detail:
        item["detail"] = detail
    return item


def _open_sqlite_ro(db_path: Path) -> sqlite3.Connection | None:
    if not db_path.is_file() or db_path.is_symlink():
        return None
    resolved = db_path.resolve()
    for suffix in ("?mode=ro", "?mode=ro&immutable=1"):
        uri = resolved.as_uri() + suffix
        conn = None
        try:
            conn = sqlite3.connect(uri, uri=True, timeout=0.5)
            conn.row_factory = sqlite3.Row
            conn.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchone()
            return conn
        except sqlite3.Error:
            if conn is not None:
                try:
                    conn.close()
                except sqlite3.Error:
                    pass
    return None


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    try:
        rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
        return {str(row[1]) for row in rows}
    except sqlite3.Error:
        return set()


def _controls_claude_disabled(controls_text: str) -> bool:
    if re.search(r"forbid_claude_code\s*[:：=]\s*(?:true|on|1)\b", controls_text, re.IGNORECASE):
        return True
    if re.search(
        r"(?:disable|forbid|exclude|no)\s+claude(?:-code)?|(?:禁用|不启用|不使用|排除)\s*claude",
        controls_text,
        re.IGNORECASE,
    ):
        return True
    has_peers = re.search(
        r"(?:^|\n)\s*(?:[-*]\s*)?(?:allowed[_\s-]*peers|participants|启用协作者|可用智能体)\s*[:：]",
        controls_text,
        re.IGNORECASE,
    )
    if has_peers and not re.search(r"\bclaude(?:-code)?\b", controls_text, re.IGNORECASE):
        return True
    return False


def _roots_overlap(a_raw: str, b_raw: str, base_a: Path, base_b: Path) -> bool:
    def norm(raw: str, base: Path) -> Path:
        p = Path(raw)
        return p.resolve(strict=False) if p.is_absolute() else (base / p).resolve(strict=False)

    pa, pb = norm(a_raw, base_a), norm(b_raw, base_b)
    return pa == pb or pa.is_relative_to(pb) or pb.is_relative_to(pa)


def _check_docs(project: Path, findings: list[dict], checked: list[str]) -> str:
    controls_text = ""
    has_memory_db = (project / ".research-memory" / "memory.sqlite3").is_file()

    for rel, max_lines in DOC_LINE_BUDGETS.items():
        path = project / rel
        if not path.is_file() or path.is_symlink():
            continue
        checked.append(rel)
        text = path.read_text(encoding="utf-8", errors="replace")
        if rel == "controls.md":
            controls_text = text
        lines = text.splitlines()
        line_count = len(lines)
        if line_count > max_lines:
            sev = "error" if line_count > max_lines * 2 else "warning"
            findings.append(
                _finding(
                    "DOC-001",
                    sev,
                    rel,
                    f"{rel} has {line_count} lines (budget <= {max_lines}); promote repeatable constraints to automated lint/guards instead of appending prose.",
                    {"lines": line_count, "budget": max_lines},
                )
            )

        if rel in {"AGENTS.md", "controls.md"}:
            non_empty = [ln for ln in lines if ln.strip()]
            if len(non_empty) >= 8:
                neg_hits = sum(1 for ln in non_empty if PROHIBITION_LINE_RE.search(ln))
                ratio = neg_hits / len(non_empty)
                if ratio > 0.25:
                    findings.append(
                        _finding(
                            "DOC-001",
                            "warning",
                            rel,
                            f"{rel} has high negative-prohibition prose ratio ({neg_hits}/{len(non_empty)} lines, {ratio:.0%}); prefer deterministic runtime checks over repeated '禁止/DO NOT' rules.",
                            {"negative_lines": neg_hits, "non_empty_lines": len(non_empty)},
                        )
                    )
            if PATCH_PILE_HEADING_RE.search(text):
                findings.append(
                    _finding(
                        "DOC-001",
                        "warning",
                        rel,
                        f"{rel} contains patch-pile section headers (e.g. '补充说明/追加规则'); consolidate durable policy cleanly.",
                    )
                )

        if STALE_FRAMEWORK_RE.search(text):
            findings.append(
                _finding(
                    "DOC-002",
                    "error",
                    rel,
                    f"{rel} contains stale hardcoded paths or project names ('Autoresearch-pipeline' / 'DynaRT-RSI').",
                )
            )
        if has_memory_db and LEGACY_LEDGER_RE.search(text):
            findings.append(
                _finding(
                    "DOC-002",
                    "warning",
                    rel,
                    f"{rel} references legacy flat ledgers (research-log.md / open-questions.md) alongside .research-memory/memory.sqlite3 (double-ledger drift).",
                )
            )
        if rel == "AGENTS.md":
            cli_count = len(MEMORY_CLI_USAGE_RE.findall(text))
            if cli_count >= 4:
                findings.append(
                    _finding(
                        "DOC-002",
                        "warning",
                        rel,
                        f"AGENTS.md embeds {cli_count} local research_memory.py CLI invocations; prefer concise pointer to setup.py / MCP tools.",
                        {"cli_invocations": cli_count},
                    )
                )

    # Check other top-level/skill markdown docs (skip large trees or node_modules)
    project_owner = None
    m_owner = FOREIGN_HOME_RE.search(str(project.resolve()))
    if m_owner:
        project_owner = m_owner.group(1)

    for rel_md in ("charter.md", "README.md"):
        p = project / rel_md
        if not p.is_file() or p.is_symlink():
            continue
        checked.append(rel_md)
        txt = p.read_text(encoding="utf-8", errors="replace")
        if STALE_FRAMEWORK_RE.search(txt):
            findings.append(
                _finding("DOC-002", "error", rel_md, f"{rel_md} contains stale template path/project reference.")
            )
        for match in FOREIGN_HOME_RE.finditer(txt):
            if project_owner and match.group(1) != project_owner and match.group(1) not in {"your-name"}:
                findings.append(
                    _finding(
                        "DOC-002",
                        "warning",
                        rel_md,
                        f"{rel_md} references foreign home path '/Users/{match.group(1)}/'.",
                    )
                )
                break

    return controls_text


def _check_git(project: Path, findings: list[dict], checked: list[str]) -> None:
    if not (project / ".git").exists():
        return
    try:
        proc = subprocess.run(
            ["git", "-C", str(project), "ls-files", "-z"],
            capture_output=True,
            timeout=5,
            check=False,
        )
    except OSError:
        return
    if proc.returncode != 0:
        return
    checked.append(".git/index")
    tracked = [item.decode("utf-8", errors="replace") for item in proc.stdout.split(b"\x00") if item]
    flagged = [p for p in tracked if SECRET_OR_LEDGER_GIT_RE.match(p)]
    for path in flagged[:20]:
        findings.append(
            _finding(
                "GIT-001",
                "error",
                path,
                f"Git tracks runtime/ledger/secret path '{path}'; keep .research-memory/.agent-bridge/.pi/secrets untracked and gitignored.",
            )
        )


def _check_mcp(project: Path, controls_text: str, findings: list[dict], checked: list[str]) -> None:
    claude_disabled = _controls_claude_disabled(controls_text)
    candidates = (
        ("toml", project / ".codex" / "config.toml", ".codex/config.toml"),
        ("json", project / ".mcp.json", ".mcp.json"),
        ("json", project / ".agents" / "mcp_config.json", ".agents/mcp_config.json"),
    )
    for kind, cfg, rel in candidates:
        if not cfg.is_file() or cfg.is_symlink():
            continue
        checked.append(rel)
        try:
            if kind == "toml":
                data = tomllib.loads(cfg.read_text(encoding="utf-8"))
                servers = data.get("mcp_servers", {})
            else:
                data = json.loads(cfg.read_text(encoding="utf-8"))
                servers = data.get("mcpServers", {})
        except (OSError, ValueError, tomllib.TOMLDecodeError):
            continue
        if not isinstance(servers, dict):
            continue

        bridge_entries = []
        for name, entry in servers.items():
            if not isinstance(entry, dict):
                continue
            low_name = str(name).lower()
            env = entry.get("env") if isinstance(entry.get("env"), dict) else {}
            args_str = " ".join(str(a) for a in (entry.get("args") or []))
            is_claude = "claude" in low_name or "claude-code-mcp" in args_str.lower()
            if claude_disabled and is_claude:
                findings.append(
                    _finding(
                        "MCP-001",
                        "error",
                        rel,
                        f"MCP server '{name}' registers Claude while controls disable Claude; remove disabled peer entries to shrink schema footprint.",
                    )
                )
            is_bridge = any(tok in low_name or tok in args_str.lower() for tok in ("cro_", "_bridge", "research_memory", "-mcp.mjs"))
            if is_bridge:
                bridge_entries.append((name, env))

        if len(bridge_entries) >= 2 and all("BRIDGE_TOOL_PROFILE" not in env for _, env in bridge_entries):
            findings.append(
                _finding(
                    "MCP-001",
                    "warning",
                    rel,
                    f"{len(bridge_entries)} bridge MCP servers configured without BRIDGE_TOOL_PROFILE schema deduplication.",
                    {"servers": [n for n, _ in bridge_entries]},
                )
            )


def _check_routing_and_pi(project: Path, controls_text: str, findings: list[dict], checked: list[str]) -> None:
    if _has_active_dyschop(controls_text, strip_history=True):
        findings.append(
            _finding("ROUTE-001", "error", "controls.md", "controls.md enables prohibited legacy provider 'dyschop/*'; use magpie 'auto/*' for PI.")
        )

    pi_dir = project / ".pi"
    bridge_dir = project / ".agent-bridge"
    proj_resolved = project.resolve()

    if bridge_dir.is_dir():
        for json_file in sorted(bridge_dir.glob("*.json"))[:20]:
            if json_file.is_symlink() or not json_file.is_file():
                continue
            rel = json_file.relative_to(project).as_posix()
            checked.append(rel)
            txt = json_file.read_text(encoding="utf-8", errors="replace")
            try:
                payload = json.loads(txt)
            except ValueError:
                payload = None
            if isinstance(payload, dict) and (
                "transportOutcome" in payload or payload.get("status") == "historical_not_selected_for_future_dispatch"
            ):
                continue
            if isinstance(payload, dict):
                cleaned_str = json.dumps(_strip_historical_json(payload), ensure_ascii=False)
                if _has_active_dyschop(cleaned_str):
                    findings.append(_finding("ROUTE-001", "error", rel, f"{rel} references prohibited 'dyschop/*' provider."))
            elif _has_active_dyschop(txt):
                findings.append(_finding("ROUTE-001", "error", rel, f"{rel} references prohibited 'dyschop/*' provider."))

    if pi_dir.is_dir():
        for pfile in sorted(pi_dir.rglob("*.json"))[:40]:
            if pfile.is_symlink() or not pfile.is_file():
                continue
            rel_parts = pfile.relative_to(project).parts
            if any(part in {"pi-runs", "executions"} for part in rel_parts):
                continue
            rel = pfile.relative_to(project).as_posix()
            checked.append(rel)
            txt = pfile.read_text(encoding="utf-8", errors="replace")
            try:
                payload = json.loads(txt)
            except ValueError:
                if re.search(r"\bdyschop\b", txt, re.IGNORECASE):
                    findings.append(_finding("ROUTE-001", "error", rel, f"{rel} uses banned 'dyschop/*' gateway."))
                continue
            if isinstance(payload, dict) and (
                "transportOutcome" in payload or payload.get("status") == "historical_not_selected_for_future_dispatch"
            ):
                continue
            cleaned_payload = _strip_historical_json(payload)
            serialized = json.dumps(cleaned_payload, ensure_ascii=False).lower()
            if _has_active_dyschop(serialized):
                findings.append(_finding("ROUTE-001", "error", rel, f"{rel} uses banned 'dyschop/*' gateway."))

            # Permit user-pinned project Gemini PI sessions; flag unpinned Gemini or any GPT/Codex/Astra in PI
            if re.search(r'"model"\s*:\s*"[^"]*(?:gpt-|codex|astra)', serialized):
                findings.append(
                    _finding(
                        "ROUTE-001",
                        "warning",
                        rel,
                        f"{rel} routes GPT/Codex/Astra inside PI; keep GPT exclusively in Codex.",
                    )
                )
            elif re.search(r'"model"\s*:\s*"[^"]*(?:gemini|carbon|argon)', serialized):
                sessions_map = cleaned_payload.get("sessions") if isinstance(cleaned_payload, dict) else None
                unpinned_found = False
                if isinstance(sessions_map, dict) and sessions_map:
                    for entry in sessions_map.values():
                        if isinstance(entry, dict) and re.search(r"gemini|carbon|argon", str(entry.get("model") or ""), re.IGNORECASE):
                            if not _is_pinned_project_session(entry, proj_resolved):
                                unpinned_found = True
                                break
                elif not _is_pinned_project_session(cleaned_payload, proj_resolved):
                    unpinned_found = True
                if unpinned_found:
                    findings.append(
                        _finding(
                            "ROUTE-001",
                            "warning",
                            rel,
                            f"{rel} configures unpinned/external-cwd Gemini in PI; PI Gemini requires a pinned project session (otherwise fall back to Antigravity).",
                        )
                    )

            if isinstance(cleaned_payload, dict):
                cwds = []
                if isinstance(cleaned_payload.get("cwd"), str):
                    cwds.append(cleaned_payload["cwd"])
                for key in ("sessions", "workers", "roles"):
                    sub = cleaned_payload.get(key)
                    if isinstance(sub, dict):
                        for item in sub.values():
                            if isinstance(item, dict) and isinstance(item.get("cwd"), str):
                                cwds.append(item["cwd"])
                for raw_cwd in cwds:
                    cpath = Path(raw_cwd).resolve(strict=False)
                    if cpath != proj_resolved and not cpath.is_relative_to(proj_resolved):
                        findings.append(
                            _finding(
                                "ROUTE-001",
                                "warning",
                                rel,
                                f"{rel} stores PI cwd '{raw_cwd}' outside project root.",
                            )
                        )

        for jsonl in sorted(pi_dir.rglob("*.jsonl"))[:30]:
            if jsonl.is_symlink() or not jsonl.is_file():
                continue
            if any(part in {"pi-runs", "executions"} for part in jsonl.relative_to(project).parts):
                continue
            rel = jsonl.relative_to(project).as_posix()
            checked.append(rel)
            max_input = 0
            assistant_turns = 0
            total_cache_read = 0
            try:
                for line in jsonl.read_text(encoding="utf-8", errors="replace").splitlines():
                    if not line.strip().startswith("{"):
                        continue
                    ev = json.loads(line)
                    msg = ev.get("message") if isinstance(ev.get("message"), dict) else ev
                    if msg.get("role") == "assistant" and isinstance(msg.get("usage"), dict):
                        usage = msg["usage"]
                        assistant_turns += 1
                        inp = int(usage.get("input") or usage.get("input_tokens") or 0)
                        max_input = max(max_input, inp)
                        total_cache_read += int(usage.get("cacheRead") or usage.get("cache_read_input_tokens") or 0)
            except (OSError, ValueError, TypeError):
                continue
            if max_input > PI_BLOAT_TOKENS:
                findings.append(
                    _finding(
                        "ROUTE-001",
                        "warning",
                        rel,
                        f"PI session history reached {max_input} input tokens (> {PI_BLOAT_TOKENS}); rotate session or hand off shorter summary.",
                        {"max_input_tokens": max_input},
                    )
                )
            elif assistant_turns >= 3 and total_cache_read == 0:
                findings.append(
                    _finding(
                        "ROUTE-001",
                        "warning",
                        rel,
                        f"PI session had {assistant_turns} turns with 0 cache-read tokens; inspect gateway/prompt stability.",
                        {"assistant_turns": assistant_turns},
                    )
                )


def _check_bridge_tasks(project: Path, findings: list[dict], checked: list[str]) -> None:
    db_path = project / ".agent-bridge" / "bridge.sqlite"
    if not db_path.is_file():
        return
    conn = _open_sqlite_ro(db_path)
    if conn is None:
        return
    checked.append(".agent-bridge/bridge.sqlite")
    with closing(conn):
        cols = _table_columns(conn, "tasks")
        if not cols or "id" not in cols or "status" not in cols:
            return
        wanted = [c for c in ("id", "from_agent", "assigned_to", "status", "prompt", "cwd", "permissions_json", "required_model", "metadata_json") if c in cols]
        rows = conn.execute(f"SELECT {', '.join(wanted)} FROM tasks WHERE status NOT IN ('completed', 'failed', 'cancelled')").fetchall()

        active_roots: list[tuple[str, Path, list[str]]] = []
        for row in rows:
            rec = dict(row)
            tid = str(rec["id"])
            perms = {}
            meta = {}
            try:
                perms = json.loads(rec.get("permissions_json") or "{}")
            except ValueError:
                pass
            try:
                meta = json.loads(rec.get("metadata_json") or "{}")
            except ValueError:
                pass
            write_roots = perms.get("writeRoots") if isinstance(perms.get("writeRoots"), list) else []
            role = str(meta.get("role") or meta.get("workerRole") or "").lower()
            task_kind = str(meta.get("taskKind") or role).lower()
            model = str(rec.get("required_model") or meta.get("requiredModel") or "").lower()
            isolation = str(meta.get("isolationProfile") or "").lower()

            if write_roots:
                base = Path(rec.get("cwd") or project)
                active_roots.append((tid, base, [str(r) for r in write_roots if r]))
                if role in {"coordinator", "lead", "lead_researcher", "orchestrator"} or meta.get("coordinationOnly") is True:
                    findings.append(
                        _finding(
                            "TASK-001",
                            "error",
                            ".agent-bridge/bridge.sqlite",
                            f"Active task '{tid}' is coordinator/coordinationOnly but holds writeRoots {write_roots}.",
                        )
                    )
                if "luna" in model:
                    findings.append(
                        _finding(
                            "TASK-001",
                            "error",
                            ".agent-bridge/bridge.sqlite",
                            f"Active task '{tid}' assigns GPT-6 Luna (L0 read-only observer) with writeRoots {write_roots}.",
                        )
                    )

            if "carbon" in model and (isolation == "blind_review" or "blind_review" in role or "formal_falsification" in role):
                findings.append(
                    _finding(
                        "TASK-001",
                        "error",
                        ".agent-bridge/bridge.sqlite",
                        f"Active task '{tid}' assigns Gemini Carbon to blind_review/formal_falsification (use GPT Astra).",
                    )
                )

            if task_kind in {"experiment", "ablation", "verification", "benchmark"}:
                claims = meta.get("claimIds") or (meta.get("experimentSpec") or {}).get("claimIds") or []
                inline = re.findall(r"\bC\d+\b", str(rec.get("prompt") or ""))
                if not claims and not inline:
                    findings.append(
                        _finding(
                            "TASK-001",
                            "warning",
                            ".agent-bridge/bridge.sqlite",
                            f"Active experiment task '{tid}' lacks explicit claim binding (claimIds / C1..).",
                        )
                    )

        for i in range(len(active_roots)):
            id_a, base_a, roots_a = active_roots[i]
            for j in range(i + 1, len(active_roots)):
                id_b, base_b, roots_b = active_roots[j]
                if any(_roots_overlap(ra, rb, base_a, base_b) for ra in roots_a for rb in roots_b):
                    findings.append(
                        _finding(
                            "TASK-001",
                            "error",
                            ".agent-bridge/bridge.sqlite",
                            f"Active tasks '{id_a}' and '{id_b}' hold overlapping writeRoots.",
                            {"task_a": id_a, "task_b": id_b},
                        )
                    )


def _check_memory_db(project: Path, findings: list[dict], checked: list[str]) -> None:
    db_path = project / ".research-memory" / "memory.sqlite3"
    if not db_path.is_file():
        return
    conn = _open_sqlite_ro(db_path)
    if conn is None:
        return
    checked.append(".research-memory/memory.sqlite3")
    with closing(conn):
        cols = _table_columns(conn, "records")
        if not cols or "id" not in cols or "state" not in cols:
            return
        reason_col = "state_reason" if "state_reason" in cols else ("reason" if "reason" in cols else None)
        if reason_col:
            rows = conn.execute(
                f"SELECT id, {reason_col} FROM records WHERE state IN ('withdrawn', 'superseded')"
            ).fetchall()
            for row in rows:
                text = str(row[1] or "").strip()
                words = [w for w in text.split() if w]
                if len(words) > MAX_TOMBSTONE_WORDS:
                    findings.append(
                        _finding(
                            "MEM-001",
                            "warning",
                            ".research-memory/memory.sqlite3",
                            f"Record #{row[0]} has bloated tombstone reason ({len(words)} words > {MAX_TOMBSTONE_WORDS}).",
                            {"record_id": row[0], "words": len(words)},
                        )
                    )

        if "kind" in cols and "claim_status" in cols:
            has_deps = bool(_table_columns(conn, "dependencies"))
            has_rels = bool(_table_columns(conn, "relations"))
            if has_deps:
                rows = conn.execute(
                    "SELECT id, kind, claim_status FROM records WHERE state = 'current' AND (kind = 'decision' OR (kind = 'claim' AND claim_status IN ('supported', 'verified')))"
                ).fetchall()
                for row in rows:
                    rid = int(row[0])
                    dep_cnt = conn.execute("SELECT COUNT(*) FROM dependencies WHERE record_id = ?", (rid,)).fetchone()[0]
                    rel_cnt = 0
                    if has_rels:
                        rel_cnt = conn.execute(
                            "SELECT COUNT(*) FROM relations WHERE record_id = ? AND type IN ('depends_on', 'supports')",
                            (rid,),
                        ).fetchone()[0]
                    if dep_cnt == 0 and rel_cnt == 0:
                        findings.append(
                            _finding(
                                "MEM-001",
                                "warning",
                                ".research-memory/memory.sqlite3",
                                f"Current {row[1]} record #{rid} lacks evidence/source dependencies.",
                                {"record_id": rid, "kind": row[1], "claim_status": row[2]},
                            )
                        )


def _check_collaboration_health(
    project: Path,
    controls_text: str,
    collab_policy: dict | None,
    findings: list[dict],
    checked: list[str],
) -> None:
    """Context-aware checks ROUTE-002 (epoch/retiring reuse) and ROUTE-003 (lock/Luna/effort/size)."""
    # ROUTE-003: Stale 'No delegation is allowed' lock or agent_type='Luna' monitoring misuse in docs
    for rel in ("AGENTS.md", "controls.md"):
        doc_path = project / rel
        if not doc_path.is_file() or doc_path.is_symlink():
            continue
        raw = doc_path.read_text(encoding="utf-8", errors="replace")
        active = _strip_historical_sections(raw) if rel == "controls.md" else raw
        if re.search(r"No delegation is allowed", active, re.IGNORECASE):
            findings.append(
                _finding(
                    "ROUTE-003",
                    "error",
                    rel,
                    f"{rel} contains stale 'No delegation is allowed' lock incompatible with orchestrated collaboration.",
                )
            )
        for line in active.splitlines():
            for clause in re.split(r"[。；;！!\r\n]+", line):
                c = clause.strip()
                if not c or NEGATED_LUNA_RE.search(c):
                    continue
                if LUNA_EXEC_PAIR_RE.search(c):
                    findings.append(
                        _finding(
                            "ROUTE-003",
                            "error",
                            rel,
                            f"{rel} pairs agent_type=\"Luna\" with monitoring/execution; use default/explorer + model=\"gpt-6-luna\" (low) instead.",
                        )
                    )
                    break

    if not collab_policy:
        return

    proj_resolved = project.resolve()
    active_epoch = collab_policy.get("protocolEpoch")
    lifecycle = collab_policy.get("subagentLifecyclePolicy") or {}
    retiring_map = lifecycle.get("retireAfterTaskHandback") or {}
    soft_limit = int(lifecycle.get("softSizeRotationBytes") or DEFAULT_SOFT_JSONL_BYTES)

    # ROUTE-003: Pinned PI JSONL soft rotation advisory (> 8 MiB)
    for key, entry in (collab_policy.get("pinnedSessions") or {}).get("pi", {}).items():
        if not isinstance(entry, dict):
            continue
        sp = entry.get("sessionPath")
        if not isinstance(sp, str) or not sp.strip():
            continue
        spath = Path(sp)
        if not spath.is_absolute():
            spath = proj_resolved / spath
        if spath.is_file() and not spath.is_symlink():
            try:
                sz = spath.stat().st_size
                if sz > soft_limit:
                    findings.append(
                        _finding(
                            "ROUTE-003",
                            "warning",
                            ".agent-bridge/collaborators.json",
                            f"Pinned PI session '{key}' JSONL is {sz / (1024 * 1024):.1f} MiB (> {soft_limit / (1024 * 1024):.1f} MiB advisory); consider fresh spawn/rotation on next milestone.",
                            {"sessionKey": key, "bytes": sz, "softLimitBytes": soft_limit},
                        )
                    )
            except OSError:
                pass

    # ROUTE-003: Check state.md / project.md recorded effort drift vs collaborators.json
    if isinstance(retiring_map, dict) and retiring_map:
        for rel in ("state.md", "project.md"):
            doc_path = project / rel
            if not doc_path.is_file() or doc_path.is_symlink():
                continue
            txt = doc_path.read_text(encoding="utf-8", errors="replace")
            for sub_key, info in retiring_map.items():
                if not isinstance(info, dict):
                    continue
                rec_eff = str(info.get("recordedEffort") or "").strip().lower()
                rec_mod = str(info.get("recordedModel") or "").strip().lower()
                if not rec_eff or not rec_mod:
                    continue
                short_tok = "sol" if "sol" in rec_mod else ("astra" if "astra" in rec_mod else ("argon" if "argon" in rec_mod else ("carbon" if "carbon" in rec_mod else rec_mod)))
                pat = re.compile(rf"\b{re.escape(short_tok)}\s*\(\s*(minimal|low|medium|high|xhigh)\b", re.IGNORECASE)
                for m in pat.finditer(txt):
                    doc_eff = m.group(1).lower()
                    if doc_eff != rec_eff:
                        findings.append(
                            _finding(
                                "ROUTE-003",
                                "warning",
                                rel,
                                f"{rel} reports '{m.group(0)})' which drifts from recorded effort '{rec_eff}' for '{sub_key}' in collaborators.json.",
                                {"subagentKey": sub_key, "docEffort": doc_eff, "recordedEffort": rec_eff},
                            )
                        )

    # ROUTE-002: Context-aware bridge task inspection (retiring reuse / epoch mismatch)
    db_path = project / ".agent-bridge" / "bridge.sqlite"
    if not db_path.is_file():
        return
    conn = _open_sqlite_ro(db_path)
    if conn is None:
        return
    with closing(conn):
        cols = _table_columns(conn, "tasks")
        if not cols or "id" not in cols or "status" not in cols:
            return
        wanted = [c for c in ("id", "status", "bound_conversation_id", "required_conversation_id", "session_id", "metadata_json") if c in cols]
        rows = conn.execute(
            f"SELECT {', '.join(wanted)} FROM tasks WHERE status NOT IN ('completed', 'failed', 'cancelled')"
        ).fetchall()
        retire_by_session = {}
        for sub_key, info in retiring_map.items():
            if isinstance(info, dict) and info.get("boundTaskId") and info.get("sessionId"):
                retire_by_session[str(info["sessionId"])] = (sub_key, str(info["boundTaskId"]))
        retire_by_subkey = {
            sub_key: str(info["boundTaskId"])
            for sub_key, info in retiring_map.items()
            if isinstance(info, dict) and info.get("boundTaskId")
        }
        protected_task_ids = set(retire_by_subkey.values())

        for row in rows:
            rec = dict(row)
            tid = str(rec["id"])
            meta = {}
            try:
                meta = json.loads(rec.get("metadata_json") or "{}")
            except ValueError:
                pass
            if isinstance(meta.get("agentType"), str) and meta["agentType"].lower() == "luna":
                findings.append(
                    _finding(
                        "ROUTE-003",
                        "error",
                        ".agent-bridge/bridge.sqlite",
                        f"Active task '{tid}' sets agentType='Luna'; monitoring must use default/explorer + model='gpt-6-luna'.",
                    )
                )

            conv_ids = {
                str(v)
                for v in (rec.get("bound_conversation_id"), rec.get("required_conversation_id"), rec.get("session_id"))
                if v
            }
            for cid in conv_ids:
                if cid in retire_by_session:
                    skey, bound_tid = retire_by_session[cid]
                    if tid != bound_tid:
                        findings.append(
                            _finding(
                                "ROUTE-002",
                                "warning",
                                ".agent-bridge/bridge.sqlite",
                                f"Active task '{tid}' reuses retiring session '{skey}' ({cid[:8]}) bound to '{bound_tid}' instead of spawning a fresh subagent.",
                                {"taskId": tid, "retiringSubagent": skey, "boundTaskId": bound_tid},
                            )
                        )
            sub_ref = meta.get("subagentKey") or meta.get("agentPath")
            if isinstance(sub_ref, str) and sub_ref in retire_by_subkey and tid != retire_by_subkey[sub_ref]:
                findings.append(
                    _finding(
                        "ROUTE-002",
                        "warning",
                        ".agent-bridge/bridge.sqlite",
                        f"Active task '{tid}' reuses retiring subagent '{sub_ref}' instead of spawning fresh after '{retire_by_subkey[sub_ref]}'.",
                        {"taskId": tid, "retiringSubagent": sub_ref, "boundTaskId": retire_by_subkey[sub_ref]},
                    )
                )

            task_epoch = meta.get("protocolEpoch") or (meta.get("dispatchSelection") or {}).get("protocolEpoch")
            if active_epoch and task_epoch and task_epoch != active_epoch and tid not in protected_task_ids:
                findings.append(
                    _finding(
                        "ROUTE-002",
                        "warning",
                        ".agent-bridge/bridge.sqlite",
                        f"Active task '{tid}' runs under stale protocolEpoch '{task_epoch}' (active '{active_epoch}').",
                        {"taskId": tid, "taskEpoch": task_epoch, "activeEpoch": active_epoch},
                    )
                )


def lint_project(project: Path | str, strict: bool = False) -> dict:
    root = Path(project).expanduser().resolve()
    if not root.is_dir():
        raise FileNotFoundError(f"Project directory does not exist: {root}")

    findings: list[dict] = []
    checked: list[str] = []

    controls_text = _check_docs(root, findings, checked)
    _check_git(root, findings, checked)
    _check_mcp(root, controls_text, findings, checked)
    _check_routing_and_pi(root, controls_text, findings, checked)
    _check_bridge_tasks(root, findings, checked)
    collab_policy = _load_collaborator_policy(root)
    _check_collaboration_health(root, controls_text, collab_policy, findings, checked)
    _check_memory_db(root, findings, checked)

    error_count = sum(1 for item in findings if item["severity"] == "error")
    warning_count = sum(1 for item in findings if item["severity"] == "warning")
    ok = error_count == 0 and (not strict or warning_count == 0)

    return {
        "ok": ok,
        "status": "passed" if ok else "failed",
        "project": str(root),
        "strict": bool(strict),
        "error_count": error_count,
        "warning_count": warning_count,
        "checked_paths": checked,
        "findings": findings,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, default=Path("."), help="Target research project root")
    parser.add_argument("--strict", action="store_true", help="Treat warnings as lint failures")
    parser.add_argument("--json", action="store_true", help="Emit JSON report")
    args = parser.parse_args(argv)

    try:
        report = lint_project(args.project, strict=args.strict)
    except Exception as exc:
        err = {"ok": False, "status": "failed", "error": str(exc)}
        print(json.dumps(err, ensure_ascii=False) if args.json else f"lint error: {exc}", file=sys.stdout if args.json else sys.stderr)
        return 2

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"lint: {report['status']} ({report['error_count']} errors, {report['warning_count']} warnings)")
        for item in report["findings"]:
            print(f"[{item['severity'].upper()}] {item['rule']} {item['path']}: {item['message']}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
