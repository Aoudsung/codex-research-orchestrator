#!/usr/bin/env python3
"""Install, start, connect and inspect a project without global configuration."""
from __future__ import annotations

import argparse
import difflib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone

if sys.version_info < (3, 11):
    message = {"error": "Python 3.11 or newer is required.", "changed": [],
               "next_action": "Run this command with Python 3.11 or newer."}
    print(json.dumps(message) if "--json" in sys.argv else "Error: " + message["error"] + "\nNext action: " + message["next_action"])
    raise SystemExit(2)

import tomllib

sys.dont_write_bytecode = True
NAME = "codex-research-orchestrator"
SKILL_PATH = Path(".agents/skills") / NAME
RUNTIME_PATH = Path(".research-orchestrator/runtime/agent-bridge")
RECEIPT_PATH = Path(".research-orchestrator/install.json")
BASELINES_PATH = Path(".research-orchestrator/baselines")
TEMPLATE_UPDATES_PATH = Path(".research-orchestrator/template-updates.json")
RECORDS = ("controls.md", "charter.md", "project.md", "state.md")
AGENTS = {"codex": ("codex", "CODEX_BIN"), "claude-code": ("claude", "CLAUDE_BIN"),
          "antigravity": ("agy", "AGY_BIN")}
DRIVER_TO_AGENT = {
    "codex": "codex",
    "codex_ipc": "codex",
    "codex_exec": "codex",
    "claude-code": "claude-code",
    "claude_exec": "claude-code",
    "antigravity": "antigravity",
    "antigravity_exec": "antigravity",
}
BEGIN = "# BEGIN codex-research-orchestrator"
END = "# END codex-research-orchestrator"
SKILL_ITEMS = {"SKILL.md", "LICENSE", "README.md", "scripts", "assets", "references", "agents"}
RUNTIME_ITEMS = {"README.md", "LICENSE", "package.json", "src", "examples", "test"}
EXCLUDED = {".git", "node_modules", "__pycache__", "state", "logs", ".agent-bridge", ".research-memory"}


class SetupError(ValueError):
    pass


def read_text(path):
    with path.open(encoding="utf-8", newline="") as handle:
        return handle.read()


def json_text(value):
    return json.dumps(value, indent=2, ensure_ascii=False) + "\n"


def read_json(path):
    return json.loads(read_text(path))


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_text(text: str) -> str:
    return sha256_bytes(text.encode("utf-8"))


def safe_path(project, relative):
    path = project / relative
    if not path.is_relative_to(project) or ".." in Path(relative).parts:
        raise SetupError("Path escapes the project: " + str(relative))
    for part in (path, *path.parents):
        if part.is_symlink():
            raise SetupError("Refusing a symlink in a managed path: " + str(part))
        if part == project:
            break
    return path


def source_skill():
    return Path(__file__).resolve().parents[1]


def version(skill):
    body = read_text(skill / "SKILL.md")
    if not re.search(r"(?m)^name: codex-research-orchestrator\s*$", body):
        raise SetupError("The directory is not the codex-research-orchestrator skill")
    match = re.search(r'(?m)^  version:\s*[\"\']?([^\s\"\']+)', body)
    if not match:
        raise SetupError("Skill metadata has no version")
    return match.group(1)


def bundled_runtime(skill):
    candidate = skill.parent.parent / "runtimes/agent-bridge"
    return candidate if candidate.is_dir() else None


def runtime_at(project):
    installed = safe_path(project, RUNTIME_PATH)
    if installed.is_dir():
        return installed, "installed"
    bundled = bundled_runtime(source_skill())
    return bundled, "bundle" if bundled else "missing"


def inventory(root, allowed=None):
    """List public regular files; never follow a source or destination symlink."""
    if root.is_symlink() or not root.is_dir():
        raise SetupError("Expected a regular directory: " + str(root))
    found = {}
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if allowed is not None and relative.parts[0] not in allowed:
            continue
        if any(part in EXCLUDED or part.startswith(".") for part in relative.parts):
            continue
        if path.suffix in {".pyc", ".db", ".sqlite", ".sqlite3", ".log"} or re.search(
                r"\.(?:db|sqlite3?)-(?:wal|shm|journal)$", path.name):
            continue
        if path.is_symlink():
            raise SetupError("Refusing a symlink in component: " + str(path))
        if path.is_file():
            found[relative.as_posix()] = path
        elif not path.is_dir():
            raise SetupError("Unsupported component entry: " + str(path))
    return found


def all_entries(root):
    if root.is_symlink() or not root.is_dir():
        raise SetupError("Expected a regular managed directory: " + str(root))
    paths = set()
    for path in root.rglob("*"):
        if path.is_symlink():
            raise SetupError("Refusing a symlink in managed component: " + str(path))
        if not path.is_dir():
            paths.add(path.relative_to(root).as_posix())
    return paths


def validate_component(root, kind):
    required = ("SKILL.md", "LICENSE", "scripts/research_setup.py", "scripts/research_memory.py") if kind == "skill" else (
        "LICENSE", "package.json", *(f"src/servers/{agent}-mcp.mjs" for agent in AGENTS))
    for name in required:
        if not (root / name).is_file():
            raise SetupError(f"Incomplete {kind}: missing {name}")
    if kind == "skill":
        version(root)
    else:
        package = read_json(root / "package.json")
        if package.get("name") != "@aoudsung/research-agent-bridge":
            raise SetupError("Unrecognized runtime package")


def validate_workbench(runtime):
    for relative in ("src/workbench/server.mjs", "src/workbench/public/index.html",
                     "src/workbench/public/app.js", "src/workbench/public/styles.css",
                     "src/workbench/public/demo-data.json"):
        if not (runtime / relative).is_file():
            raise SetupError("Workbench files are missing; install or upgrade the complete bundle: " + relative)


def same_tree(root, files):
    return root.is_dir() and all_entries(root) == set(files) and all(
        (root / name).read_bytes() == path.read_bytes() for name, path in files.items())


def same_bytes_tree(root, files_bytes):
    return root.is_dir() and all_entries(root) == set(files_bytes) and all(
        (root / name).read_bytes() == content for name, content in files_bytes.items())


def skill_template_bases(skill):
    """Collect builtInBase templates mapped to their workspace-relative customizable paths."""
    bases = {}
    tpl_dir = skill / "assets/project-template"
    if tpl_dir.is_dir():
        for rel, path in inventory(tpl_dir).items():
            text = read_text(path)
            bases[rel] = {
                "kind": "project-template",
                "source": f"assets/project-template/{rel}",
                "text": text,
                "sha256": sha256_text(text),
            }
    roles_dir = skill / "references/roles"
    if roles_dir.is_dir():
        for rel, path in inventory(roles_dir).items():
            target_rel = f".agents/roles/{rel}"
            text = read_text(path)
            bases[target_rel] = {
                "kind": "role-template",
                "source": f"references/roles/{rel}",
                "text": text,
                "sha256": sha256_text(text),
            }
    return bases


def skill_protocol_references(skill):
    refs = {}
    refs_dir = skill / "references"
    if refs_dir.is_dir():
        for rel, path in inventory(refs_dir).items():
            if rel.startswith("roles/"):
                continue
            refs[rel] = {"sha256": sha256_bytes(path.read_bytes())}
    return refs


def read_baselines(project):
    if not project.exists() or not project.is_dir():
        return None, {}
    base_dir = safe_path(project, BASELINES_PATH)
    manifest_file = base_dir / "manifest.json"
    if not manifest_file.is_file():
        return None, {}
    try:
        manifest = read_json(manifest_file)
        if not isinstance(manifest, dict) or not isinstance(manifest.get("files"), dict):
            return None, {}
        texts = {}
        for rel in manifest["files"]:
            stored = safe_path(project, BASELINES_PATH / "files" / rel)
            if stored.is_file():
                texts[rel] = read_text(stored)
        return manifest, texts
    except (ValueError, OSError):
        return None, {}


def read_template_updates(project):
    if not project.exists() or not project.is_dir():
        return {}
    updates_file = safe_path(project, TEMPLATE_UPDATES_PATH)
    if not updates_file.is_file():
        return {}
    try:
        data = read_json(updates_file)
        updates = data.get("updates", {}) if isinstance(data, dict) else {}
        return dict(updates) if isinstance(updates, dict) else {}
    except (ValueError, OSError):
        return {}


def build_baseline_tree(skill_ver, files_meta, texts_by_rel, protocol_refs):
    manifest = {
        "name": NAME,
        "version": skill_ver,
        "files": dict(sorted(files_meta.items())),
        "protocol_references": dict(sorted(protocol_refs.items())),
    }
    tree = {"manifest.json": json_text(manifest).encode("utf-8")}
    for rel, text in sorted(texts_by_rel.items()):
        tree[f"files/{rel}"] = text.encode("utf-8")
    return tree


def staging(project):
    directory = safe_path(project, ".research-orchestrator")
    directory.mkdir(parents=True, exist_ok=True)
    return tempfile.TemporaryDirectory(prefix=".setup-", dir=directory)


def replace_components(project, prepared, stage, backup=()):
    """Stage first, preserve backups, and roll back all replacements on error."""
    targets = {name: safe_path(project, name) for name in prepared}
    backup_names = [name for name in backup if targets[name].exists()]
    backup_dir = None
    if backup_names:
        base = safe_path(project, ".research-orchestrator/backups")
        base.mkdir(parents=True, exist_ok=True)
        backup_dir = Path(tempfile.mkdtemp(prefix="setup-", dir=base))
        for name in backup_names:
            old, saved = targets[name], backup_dir / name
            saved.parent.mkdir(parents=True, exist_ok=True)
            if old.is_dir():
                shutil.copytree(old, saved)
            else:
                shutil.copy2(old, saved)
    moved, published = [], []
    try:
        for index, (name, incoming) in enumerate(prepared.items()):
            target = targets[name]
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                old = stage / f"previous-{index}"
                os.replace(target, old)
                moved.append((target, old))
            os.replace(incoming, target)
            published.append(target)
    except BaseException:
        for path in reversed(published):
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()
        for target, old in reversed(moved):
            os.replace(old, target)
        raise
    return str(backup_dir.relative_to(project)) if backup_dir else None


def write_files(project, contents, backup=()):
    changed = {Path(name): body for name, body in contents.items()
               if not safe_path(project, name).is_file() or read_text(safe_path(project, name)) != body}
    if not changed:
        return [], None
    with staging(project) as temporary:
        stage = Path(temporary)
        prepared = {}
        for index, (name, body) in enumerate(changed.items()):
            target = safe_path(project, name)
            if target.exists() and not target.is_file():
                raise SetupError("Expected a regular file: " + str(target))
            incoming = stage / f"new-{index}"
            incoming.write_text(body, encoding="utf-8", newline="")
            if target.exists():
                shutil.copymode(target, incoming)
            prepared[name] = incoming
        saved = replace_components(project, prepared, stage, [Path(p) for p in backup if Path(p) in prepared])
    return [str(name) for name in changed], saved


def cli_command(project, command, *args):
    installed = safe_path(project, SKILL_PATH / "scripts/research_setup.py")
    script = installed if installed.is_file() else Path(__file__).resolve()
    return shlex.join([sys.executable, str(script), command, "--project", str(project), *args])


def resume_action(project):
    return (f'Open your research client in {project} and send: '
            '"Use $codex-research-orchestrator to resume from controls.md, charter.md, project.md and state.md."')


def result(command, changed, next_action, **details):
    return dict(command=command, changed=changed, next_action=next_action, **details)


def install(args, project):
    skill = source_skill()
    runtime = bundled_runtime(skill)
    components = {SKILL_PATH: (skill, "skill", SKILL_ITEMS)}
    if runtime and not args.skill_only:
        components[RUNTIME_PATH] = (runtime, "runtime", RUNTIME_ITEMS)
    for relative, (source, _, _) in components.items():
        dest = safe_path(project, relative)
        if source == dest or source.is_relative_to(dest) or dest.is_relative_to(source):
            raise SetupError("Source and installation destination overlap; choose another --project")
    receipt_file = safe_path(project, RECEIPT_PATH)
    receipt = read_json(receipt_file) if receipt_file.exists() else None
    if receipt is not None and (not isinstance(receipt, dict) or receipt.get("name") != NAME):
        raise SetupError("Unrecognized install receipt; inspect it before installing")
    previous = receipt.get("components", {}) if receipt else {}
    files_by_component = {}
    changed_components = []
    for relative, (source, kind, allowed) in components.items():
        validate_component(source, kind)
        if kind == "runtime":
            validate_workbench(source)
        files = inventory(source, allowed)
        files_by_component[relative] = files
        dest = safe_path(project, relative)
        if dest.exists():
            existing = all_entries(dest)
            owned = previous.get(str(relative), {}).get("files")
            if owned is None:
                if kind == "skill":
                    version(dest)
                elif read_json(dest / "package.json").get("name") != "@aoudsung/research-agent-bridge":
                    raise SetupError("Refusing to replace an unrelated runtime directory")
                owned = list(files)
            unknown = existing - set(owned)
            if unknown:
                raise SetupError("Unmanaged files in installation; move them before upgrading: " + ", ".join(sorted(unknown)))
        if not same_tree(dest, files):
            if dest.exists() and not args.upgrade:
                raise SetupError("A different installation exists; rerun install with --upgrade to back it up")
            changed_components.append(relative)

    skill_ver = version(skill)
    new_bases = skill_template_bases(skill)
    new_refs = skill_protocol_references(skill)
    old_manifest, old_texts = read_baselines(project)
    existing_updates = read_template_updates(project)
    pending_updates = dict(existing_updates)
    auto_upgraded_templates = {}

    if args.upgrade and old_texts:
        for rel, info in sorted(new_bases.items()):
            old_text = old_texts.get(rel)
            new_text = info["text"]
            target_file = safe_path(project, rel) if project.exists() else None
            if old_text is not None and old_text != new_text and target_file is not None and target_file.is_file():
                current_text = read_text(target_file)
                if current_text == old_text:
                    auto_upgraded_templates[Path(rel)] = new_text
                    pending_updates.pop(rel, None)
                elif current_text != new_text:
                    diff_lines = list(difflib.unified_diff(
                        old_text.splitlines(keepends=True),
                        new_text.splitlines(keepends=True),
                        fromfile=f"a/builtInBase/{rel}",
                        tofile=f"b/builtInBase/{rel}",
                    ))
                    pending_updates[rel] = {
                        "status": "default-updated",
                        "kind": info["kind"],
                        "version": skill_ver,
                        "old_base_sha256": sha256_text(old_text),
                        "new_base_sha256": info["sha256"],
                        "current_sha256": sha256_text(current_text),
                        "diff": "".join(diff_lines),
                    }
                else:
                    pending_updates.pop(rel, None)

    merged_files_meta = {}
    merged_texts = {}
    if old_manifest and isinstance(old_manifest.get("files"), dict):
        for rel, meta in old_manifest["files"].items():
            if rel not in new_bases and rel in old_texts:
                merged_files_meta[rel] = meta
                merged_texts[rel] = old_texts[rel]
    for rel, info in new_bases.items():
        entry = {"kind": info["kind"], "source": info["source"], "sha256": info["sha256"]}
        if old_manifest and isinstance(old_manifest.get("files", {}).get(rel), dict):
            prev_entry = old_manifest["files"][rel]
            if "workspace_sha256" in prev_entry:
                entry["workspace_sha256"] = prev_entry["workspace_sha256"]
        merged_files_meta[rel] = entry
        merged_texts[rel] = info["text"]

    desired_baseline_tree = build_baseline_tree(skill_ver, merged_files_meta, merged_texts, new_refs)
    baselines_dest = safe_path(project, BASELINES_PATH) if project.exists() else (project / BASELINES_PATH)
    baselines_changed = not (project.exists() and same_bytes_tree(baselines_dest, desired_baseline_tree))

    updates_file = safe_path(project, TEMPLATE_UPDATES_PATH) if project.exists() else (project / TEMPLATE_UPDATES_PATH)
    desired_updates_body = None
    updates_changed = False
    if pending_updates:
        desired_updates_body = json_text({"version": skill_ver, "updates": dict(sorted(pending_updates.items()))})
        updates_changed = not (project.exists() and updates_file.is_file() and read_text(updates_file) == desired_updates_body)
    elif existing_updates and project.exists() and updates_file.is_file():
        desired_updates_body = json_text({"version": skill_ver, "updates": {}})
        updates_changed = read_text(updates_file) != desired_updates_body

    installed_components = dict(previous)
    for relative, (_, kind, _) in components.items():
        installed_components[str(relative)] = {"kind": kind, "files": sorted(files_by_component[relative])}
    new_receipt = {"name": NAME, "version": skill_ver, "components": installed_components}
    body = json_text(new_receipt)
    receipt_changed = not receipt_file.is_file() or read_text(receipt_file) != body
    changed = [str(path) for path in changed_components]
    saved = None
    if changed or receipt_changed or baselines_changed or auto_upgraded_templates or updates_changed:
        project.mkdir(parents=True, exist_ok=True)
        with staging(project) as temporary:
            stage = Path(temporary)
            prepared = {}
            for index, relative in enumerate(changed_components):
                incoming = stage / f"component-{index}"
                incoming.mkdir()
                for name, source in files_by_component[relative].items():
                    target = incoming / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, target)
                validate_component(incoming, components[relative][1])
                prepared[relative] = incoming
            for index, (tpl_rel, tpl_body) in enumerate(auto_upgraded_templates.items()):
                incoming = stage / f"tpl-{index}"
                incoming.write_text(tpl_body, encoding="utf-8", newline="")
                existing_tpl = safe_path(project, tpl_rel)
                if existing_tpl.is_file():
                    shutil.copymode(existing_tpl, incoming)
                prepared[tpl_rel] = incoming
                changed.append(str(tpl_rel))
            if baselines_changed:
                incoming_base = stage / "baselines"
                incoming_base.mkdir()
                for name, raw_bytes in desired_baseline_tree.items():
                    target = incoming_base / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(raw_bytes)
                prepared[BASELINES_PATH] = incoming_base
                changed.append(str(BASELINES_PATH))
            if updates_changed and desired_updates_body is not None:
                incoming_updates = stage / "template-updates.json"
                incoming_updates.write_text(desired_updates_body, encoding="utf-8", newline="")
                prepared[TEMPLATE_UPDATES_PATH] = incoming_updates
                changed.append(str(TEMPLATE_UPDATES_PATH))
            if receipt_changed or changed_components:
                incoming = stage / "receipt.json"
                incoming.write_text(body, encoding="utf-8")
                prepared[RECEIPT_PATH] = incoming
                changed.append(str(RECEIPT_PATH))
            saved = replace_components(project, prepared, stage, prepared)
    return result("install", changed, cli_command(project, "init", "--question", "Your research question"),
                  version=skill_ver, mode="full-bundle" if RUNTIME_PATH in components else "skill-only",
                  skill=str(project / SKILL_PATH), runtime=str(project / RUNTIME_PATH) if (project / RUNTIME_PATH).is_dir() else None,
                  backup=saved, template_updates=sorted(pending_updates.keys()),
                  note="Runtime files do not start a service. Basic research needs no Node or providers.")


def memory_status(project):
    if not project.exists() or not project.is_dir():
        return {"status": "missing", "path": str(project / ".research-memory/memory.sqlite3")}
    database = safe_path(project, ".research-memory/memory.sqlite3")
    if not database.is_file():
        return {"status": "missing", "path": str(database)}
    try:
        with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as db:
            config = dict(db.execute("SELECT key, value FROM config"))
            controls = json.loads(config.get("controls", "[]"))
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            recorded_project = config.get("project")
            same_project = (recorded_project == str(project) or
                            (bool(recorded_project) and Path(recorded_project).resolve() == project.resolve()))
            good = (config.get("version") == "1" and same_project
                    and bool(controls) and {"records", "dependencies", "memory_fts"} <= tables
                    and all(safe_path(project, name).is_file() for name in controls))
        return {"status": "ready" if good else "needs-attention", "path": str(database), "controls": controls}
    except (sqlite3.Error, ValueError, TypeError):
        return {"status": "needs-attention", "path": str(database)}


def fts_status():
    try:
        with sqlite3.connect(":memory:") as db:
            db.execute("CREATE VIRTUAL TABLE probe USING fts5(body)")
        return "ready"
    except sqlite3.Error:
        return "missing"


def init(args, project):
    directory = safe_path(project, ".research-orchestrator")
    directory.mkdir(parents=True, exist_ok=True)
    lock = safe_path(project, ".research-orchestrator/init.lock")
    try:
        lock.mkdir()
    except FileExistsError:
        raise SetupError("Another init holds the project lock; wait for it to finish. If it stopped, "
                         "inspect the workspace before removing .research-orchestrator/init.lock") from None
    try:
        return initialize_workspace(args, project)
    finally:
        lock.rmdir()


def initialize_workspace(args, project):
    existing = [name for name in RECORDS if safe_path(project, name).exists()]
    memory = memory_status(project)
    if existing:
        if all(safe_path(project, name).is_file() for name in ("charter.md", "project.md", "state.md")):
            return result("init", [], resume_action(project), status="existing-project", memory=memory,
                          note="Existing records were preserved; the supplied question was not substituted.")
        raise SetupError("Partial research workspace; inspect existing " + ", ".join(existing)
                         + " and complete or resume its records manually; nothing was overwritten")
    if safe_path(project, ".research-memory").exists():
        raise SetupError("Existing research memory found; locate its original records and resume that project")
    if args.question is None or not args.question.strip():
        raise SetupError("A new project needs --question with the user's exact question")
    skill = safe_path(project, SKILL_PATH)
    if not skill.is_dir():
        raise SetupError("Install the skill into this project before init")
    validate_component(skill, "skill")
    if fts_status() != "ready":
        raise SetupError("This Python SQLite lacks FTS5; use a Python build with SQLite FTS5")
    title = args.title or "Research Project"
    texts = {
        "controls.md": "# Authoritative Research Question\n\nSource: user-provided via --question.\n\n## Question (verbatim)\n\n" + args.question,
        "charter.md": f"# {title}\n\nThe authoritative user-provided question is in [controls.md](controls.md).\n"
                      "No scientific conclusion or additional user constraint has been recorded.\n",
        "project.md": "# Project Settings\n\n" + f"Project directory: {project}\nSkill directory: {skill}\n"
                      + f"Memory directory: {project / '.research-memory'}\n"
                      + f"Optional bridge runtime: {runtime_at(project)[0] or 'not installed'}\n"
                      + f"Optional bridge database: {project / '.agent-bridge/bridge.sqlite'} (separate from research memory).\n\n"
                      "Controls: controls.md. Current checkpoint: state.md.\n"
                      "This command records the question and initializes local records and memory.\n"
                      "Participants, external sharing, implementation, experiments, execution resources, budget, "
                      "and publication authorization: not recorded here; follow the user's actual instructions.\n",
        "state.md": "# Current Research State\n\nStatus: ready to begin.\n"
                    "Question: controls.md. Settings and authorization sources: project.md.\n"
                    "No research results, active jobs, or participant bindings have been recorded.\n\n"
                    "Next action: read controls.md and project.md, identify the question's scope and relevant "
                    "evidence, and begin analysis within the user's recorded authorization.\n",
    }
    spec = importlib.util.spec_from_file_location("cro_setup_memory", skill / "scripts/research_memory.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with staging(project) as temporary:
        stage = Path(temporary)
        workspace = stage / "workspace"
        workspace.mkdir()
        for name, text in texts.items():
            (workspace / name).write_text(text, encoding="utf-8", newline="")
        memory_instance = module.Memory(workspace, ["controls.md"])
        try:
            with memory_instance.db:
                memory_instance.db.execute("UPDATE config SET value=? WHERE key='project'", (str(project),))
        finally:
            memory_instance.close()
        try:
            # Hard links publish complete files without replacing a concurrent writer's files.
            for name in texts:
                os.link(workspace / name, safe_path(project, name))
            memory_directory = safe_path(project, ".research-memory")
            memory_directory.mkdir()
            os.link(workspace / ".research-memory/memory.sqlite3", memory_directory / "memory.sqlite3")
        except FileExistsError:
            raise SetupError("The workspace changed during init. Existing and newly created records were preserved; "
                             "inspect and complete this partial workspace before resuming") from None
    return result("init", [*RECORDS, ".research-memory"], resume_action(project), status="initialized",
                  memory=memory_status(project))


def selected_peers(raw, client):
    peers = list(dict.fromkeys(part for value in (raw or []) for part in re.split(r"[,\s]+", value) if part))
    if not peers:
        raise SetupError("Select other agents explicitly with --peers (codex, claude-code, antigravity)")
    if any(peer not in AGENTS or peer == client for peer in peers):
        raise SetupError("--peers must name only other agents: " + ", ".join(a for a in AGENTS if a != client))
    return sorted(peers)


def node_status(explicit=None):
    executable = shutil.which(explicit or "node")
    if not executable:
        return {"status": "missing", "path": None}
    executable = str(Path(executable).resolve())
    try:
        completed = subprocess.run([executable, "--version"], capture_output=True, text=True, timeout=10, check=False)
        match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)\s*", completed.stdout)
        if completed.returncode or not match:
            return {"status": "invalid", "path": executable}
        return {"status": "ready" if int(match[1]) >= 24 else "too-old", "path": executable,
                "version": match[0].strip()}
    except (OSError, subprocess.TimeoutExpired):
        return {"status": "invalid", "path": executable}


def provider_status(peers):
    return {peer: {"executable": shutil.which(AGENTS[peer][0]), "authentication": "not-verified"} for peer in peers}


def entries_for(project, client, peers, runtime, node, providers):
    entries = {}
    for peer in peers:
        environment = {"AGENT_BRIDGE_DB": str(safe_path(project, ".agent-bridge/bridge.sqlite")), "MCP_CALLER_AGENT": client}
        if providers[peer]["executable"]:
            environment[AGENTS[peer][1]] = str(Path(providers[peer]["executable"]).resolve())
        entries["cro_" + peer.replace("-", "_")] = {
            "command": node, "args": [str(runtime / f"src/servers/{peer}-mcp.mjs")], "env": environment}
        if client == "codex":
            entries["cro_" + peer.replace("-", "_")]["tool_timeout_sec"] = 660
        elif client == "claude-code":
            entries["cro_" + peer.replace("-", "_")]["timeout"] = 660000
        else:
            entries["cro_" + peer.replace("-", "_")]["timeoutSeconds"] = 660
    return entries


def toml_config(entries):
    lines = []
    for name, entry in entries.items():
        lines += [f'[mcp_servers.{json.dumps(name)}]', "command = " + json.dumps(entry["command"]),
                  "args = " + json.dumps(entry["args"])]
        if "tool_timeout_sec" in entry:
            lines.append("tool_timeout_sec = " + str(entry["tool_timeout_sec"]))
        lines.append(f'[mcp_servers.{json.dumps(name)}.env]')
        lines += [json.dumps(key) + " = " + json.dumps(value) for key, value in entry["env"].items()]
        lines.append("")
    text = "\n".join(lines)
    tomllib.loads(text)
    return text


def connection_paths(client):
    root = Path(".research-orchestrator/mcp")
    export = root / (client + (".toml" if client == "codex" else ".json"))
    state = root / (client + ".managed.json")
    config = {"codex": Path(".codex/config.toml"), "claude-code": Path(".mcp.json"),
              "antigravity": Path(".agents/mcp_config.json")}[client]
    return export, state, config


def connection_state(project, client):
    if not project.exists() or not project.is_dir():
        return {"client": client, "generated": {}, "applied": {}}
    path = safe_path(project, connection_paths(client)[1])
    if not path.exists():
        return {"client": client, "generated": {}, "applied": {}}
    state = read_json(path)
    if (not isinstance(state, dict) or state.get("client") != client
            or not isinstance(state.get("generated"), dict) or not isinstance(state.get("applied"), dict)
            or any(not key.startswith("cro_") for group in ("generated", "applied") for key in state[group])):
        raise SetupError("Unrecognized connection ownership record: " + str(path))
    return state


def merged_config(client, old, owned, desired):
    if client == "codex":
        parsed = tomllib.loads(old)
        pattern = re.compile(r"\n" + re.escape(BEGIN) + r"\n(.*?)\n" + re.escape(END) + r"\n", re.S)
        blocks = list(pattern.finditer(old))
        if owned:
            if len(blocks) != 1 or old.count(BEGIN) != 1 or old.count(END) != 1:
                raise SetupError("Managed Codex block is missing or changed; inspect the project config")
            block_data = tomllib.loads(blocks[0][1])
            if block_data != {"mcp_servers": owned}:
                raise SetupError("Managed Codex configuration was edited; preserve and reconcile it before applying")
            prefix, suffix = old[:blocks[0].start()], old[blocks[0].end():]
            base = prefix + "\n" + suffix
        else:
            if BEGIN in old or END in old:
                raise SetupError("Unowned Codex managed block; inspect it before applying")
            base = old
        base_data = tomllib.loads(base)
        servers = base_data.get("mcp_servers", {})
        if not isinstance(servers, dict):
            raise SetupError("mcp_servers must be a TOML table")
        for name in desired:
            if name in servers:
                raise SetupError("Unmanaged MCP name collision: " + name)
        if owned and any(parsed.get("mcp_servers", {}).get(name) != entry for name, entry in owned.items()):
            raise SetupError("Managed Codex entries no longer match their ownership record")
        block = "\n" + BEGIN + "\n" + toml_config(desired).rstrip("\n") + "\n" + END + "\n"
        new = prefix + block + suffix if owned else base + block
        tomllib.loads(new)
        return new
    data = json.loads(old) if old else {}
    if not isinstance(data, dict) or not isinstance(data.get("mcpServers", {}), dict):
        raise SetupError("Client config must contain an mcpServers object")
    servers = data.setdefault("mcpServers", {})
    for name, entry in owned.items():
        if servers.get(name) != entry:
            raise SetupError("Managed MCP entry was removed or edited: " + name)
        del servers[name]
    for name in desired:
        if name in servers:
            raise SetupError("Unmanaged MCP name collision: " + name)
    servers.update(desired)
    return json_text(data)


def connect(args, project):
    peers = selected_peers(args.peers, args.client)
    runtime, location = runtime_at(project)
    if runtime is None:
        raise SetupError("Optional bridge runtime is missing; install from the complete bundle before connect")
    validate_component(runtime, "runtime")
    node = node_status(args.node)
    if node["status"] != "ready":
        raise SetupError("Connect needs Node >=24; install it or pass --node /absolute/path/to/node")
    providers = provider_status(peers)
    entries = entries_for(project, args.client, peers, runtime, node["path"], providers)
    export, manifest, config = connection_paths(args.client)
    state = connection_state(project, args.client)
    state["generated"] = entries
    state["peers"] = peers
    generated = toml_config(entries) if args.client == "codex" else json_text({"mcpServers": entries})
    files = {export: generated}
    applied = bool(args.apply and config)
    if applied:
        path = safe_path(project, config)
        old = read_text(path) if path.exists() else ""
        files[config] = merged_config(args.client, old, state["applied"], entries)
        state["applied"] = entries
    files[manifest] = json_text(state)
    changed, saved = write_files(project, files, [config] if applied else [])
    if applied:
        next_action = f"Reopen {args.client} in {project} and inspect its MCP server status."
    else:
        extra = ["--client", args.client, "--peers", *peers, "--node", node["path"], "--apply"]
        next_action = cli_command(project, "connect", *extra)
    return result("connect", changed, next_action, generated=str(project / export),
                  applied=str(project / config) if applied else None, client=args.client, peers=peers,
                  runtime_source=location, providers=providers, backup=saved,
                  authentication="not-verified", host_connectivity="not-verified",
                  note="Configuration only; no providers, models, bridge database or background services were started.")


def config_status(project, client, state, peers):
    export, _, config = connection_paths(client)
    path = safe_path(project, export)
    generated = "missing"
    if path.is_file():
        parsed = tomllib.loads(read_text(path)) if client == "codex" else read_json(path)
        generated = "consistent" if parsed == {"mcp_servers" if client == "codex" else "mcpServers": state["generated"]} else "changed"
    applied = "not-applied"
    if state["applied"] and config:
        path = safe_path(project, config)
        if path.is_file():
            old = read_text(path)
            merged_config(client, old, state["applied"], state["applied"])
            applied = "consistent"
        else:
            applied = "missing"
    requested = {"cro_" + peer.replace("-", "_") for peer in peers}
    selection_generated = generated == "consistent" and set(state["generated"]) == requested
    return {"generated": generated, "applied": applied, "requested_peers": peers,
            "selection_generated": selection_generated,
            "selection_applied": applied == "consistent" and selection_generated
            and state["applied"] == state["generated"]}


def doctor(args, project):
    checks = {"python": {"status": "ready" if sys.version_info >= (3, 11) else "too-old", "version": sys.version.split()[0]},
              "fts5": {"status": fts_status()}}
    skill = safe_path(project, SKILL_PATH) if project.exists() else (project / SKILL_PATH)
    if skill.is_dir():
        try:
            validate_component(skill, "skill")
            receipt = safe_path(project, RECEIPT_PATH)
            managed = receipt.is_file() and read_json(receipt).get("name") == NAME
            checks["skill"] = {"status": "installed" if managed else "manual-install",
                               "version": version(skill), "path": str(skill)}
        except (ValueError, OSError, AttributeError) as error:
            checks["skill"] = {"status": "needs-attention", "path": str(skill), "detail": str(error)}
    else:
        checks["skill"] = {"status": "source-only", "version": version(source_skill()), "path": str(source_skill())}
    runtime, location = runtime_at(project) if project.exists() else (bundled_runtime(source_skill()), "bundle" if bundled_runtime(source_skill()) else "missing")
    checks["runtime"] = {"status": location, "path": str(runtime) if runtime else None}
    if runtime:
        try:
            validate_component(runtime, "runtime")
            checks["runtime"]["version"] = read_json(runtime / "package.json").get("version")
        except (ValueError, OSError) as error:
            checks["runtime"].update(status="needs-attention", detail=str(error))
    checks["records"] = {name: "present" if project.exists() and safe_path(project, name).is_file() else "missing" for name in RECORDS}
    checks["memory"] = memory_status(project)
    if project.exists() and project.is_dir():
        pending_updates = read_template_updates(project)
        if pending_updates:
            checks["templates"] = {
                "status": "default-updated",
                "pending_updates": sorted(pending_updates.keys()),
                "path": str(safe_path(project, TEMPLATE_UPDATES_PATH)),
            }
        elif safe_path(project, BASELINES_PATH / "manifest.json").is_file():
            checks["templates"] = {"status": "tracked", "pending_updates": []}
    state = connection_state(project, args.client)
    peers = selected_peers(args.peers, args.client) if args.peers else state.get("peers", [])
    bridge_requested = bool(peers or args.node or state["generated"])
    if bridge_requested:
        prior_node = next(iter(state["generated"].values()), {}).get("command")
        checks["node"] = node_status(args.node or prior_node)
        checks["providers"] = provider_status(peers)
        try:
            checks["configuration"] = config_status(project, args.client, state, peers)
        except (ValueError, OSError) as error:
            checks["configuration"] = {"status": "needs-attention", "detail": str(error)}
    ready = (checks["skill"]["status"] in {"installed", "manual-install"} and all(value == "present" for value in checks["records"].values())
             and checks["memory"]["status"] == "ready" and checks["fts5"]["status"] == "ready")
    if checks["skill"]["status"] == "source-only":
        action = cli_command(project, "install")
    elif not any(value == "present" for value in checks["records"].values()):
        action = cli_command(project, "init", "--question", "Your research question")
    elif not ready:
        action = f"Inspect the existing research records and memory at {project} before resuming; preserve their contents."
    elif bridge_requested and checks["node"]["status"] != "ready":
        action = "Install Node 24 or newer, then rerun this doctor command with --node pointing to its executable."
    elif bridge_requested and checks["configuration"].get("status") == "needs-attention":
        action = f"Reconcile the managed MCP configuration reported by doctor in {project} before reconnecting."
    elif bridge_requested and checks["runtime"]["status"] in {"missing", "needs-attention"}:
        action = "Install the optional runtime from the complete bundle before connecting peers."
    elif bridge_requested and checks["configuration"].get("generated") == "changed":
        action = f"Inspect the edited MCP export in {project / '.research-orchestrator/mcp'} before reconnecting."
    elif bridge_requested and not checks["configuration"].get("selection_applied"):
        action = cli_command(project, "connect", "--client", args.client, "--peers", *peers,
                             "--node", checks["node"]["path"], "--apply")
    elif bridge_requested and any(not item["executable"] for item in checks["providers"].values()):
        missing = next(peer for peer, item in checks["providers"].items() if not item["executable"])
        action = f"Install the {missing} provider CLI ({AGENTS[missing][0]}) before using that peer."
    else:
        action = resume_action(project)
    return result("doctor", [], action, basic_research_ready=ready, bridge_requested=bridge_requested,
                  checks=checks, authentication="not-verified", host_connectivity="not-verified",
                  note="Optional bridge or Node absence does not block basic research. No persistent state was created.")


def discover_project_mcp_hints(project):
    """Read-only inspection of project MCP config files for bridge DB, Node, runtime, and provider binaries."""
    hints = {"bridge_db": None, "node": None, "runtime": None, "provider_bins": {}}
    if not project.exists() or not project.is_dir():
        return hints
    candidates = (
        ("codex", project / ".codex/config.toml"),
        ("claude-code", project / ".mcp.json"),
        ("antigravity", project / ".agents/mcp_config.json"),
    )
    for kind, cfg_path in candidates:
        if cfg_path.is_symlink() or not cfg_path.is_file():
            continue
        try:
            data = tomllib.loads(read_text(cfg_path)) if kind == "codex" else read_json(cfg_path)
            servers = data.get("mcp_servers" if kind == "codex" else "mcpServers", {})
            if not isinstance(servers, dict):
                continue
            for entry in servers.values():
                if not isinstance(entry, dict):
                    continue
                cmd = entry.get("command")
                args_list = entry.get("args") if isinstance(entry.get("args"), list) else []
                env = entry.get("env") if isinstance(entry.get("env"), dict) else {}
                if not hints["bridge_db"] and isinstance(env.get("AGENT_BRIDGE_DB"), str):
                    hints["bridge_db"] = Path(env["AGENT_BRIDGE_DB"])
                if not hints["node"] and isinstance(cmd, str) and any(
                        isinstance(a, str) and a.endswith("-mcp.mjs") for a in args_list):
                    hints["node"] = cmd
                for arg in args_list:
                    if isinstance(arg, str) and arg.endswith("-mcp.mjs") and "/src/servers/" in arg.replace("\\", "/"):
                        candidate_rt = Path(arg).resolve().parents[2]
                        if not hints["runtime"] and (candidate_rt / "package.json").is_file():
                            hints["runtime"] = candidate_rt
                for agent, (_, env_var) in AGENTS.items():
                    if agent not in hints["provider_bins"] and isinstance(env.get(env_var), str):
                        hints["provider_bins"][agent] = env[env_var]
        except (ValueError, OSError):
            continue
    return hints


def discover_bridge_db(project, explicit=None, hints=None):
    if explicit:
        return Path(explicit).expanduser().resolve()
    env_db = os.environ.get("AGENT_BRIDGE_DB")
    if env_db:
        return Path(env_db).expanduser().resolve()
    if project.exists() and project.is_dir():
        local_default = project / ".agent-bridge/bridge.sqlite"
        if local_default.is_file():
            return local_default.resolve()
        env_subdir = project / "environment/bridge/bridge.sqlite"
        if env_subdir.is_file():
            return env_subdir.resolve()
        hints = hints or discover_project_mcp_hints(project)
        if hints.get("bridge_db"):
            return Path(hints["bridge_db"]).expanduser().resolve()
    return (project / ".agent-bridge/bridge.sqlite").resolve()


def pid_alive(pid) -> bool:
    try:
        num = int(pid)
    except (TypeError, ValueError):
        return False
    if num <= 0:
        return False
    try:
        os.kill(num, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def inspect_bridge_readonly(db_path: Path):
    """Strictly read-only inspection of bridge.sqlite and wakeup-daemon lock/stop markers."""
    lock_path = db_path.parent / "wakeup-daemon.json"
    stop_path = db_path.parent / "wakeup-daemon.stopped"
    daemon = {"status": "stopped", "pid": None, "alive": False, "lock_path": str(lock_path),
              "manual_stop": stop_path.is_file(), "heartbeat_at": None, "heartbeat_age_sec": None}
    faults = []

    if lock_path.is_file():
        try:
            lock_data = read_json(lock_path)
            pid = lock_data.get("pid")
            alive = pid_alive(pid)
            hb = lock_data.get("heartbeatAt")
            hb_age = None
            if isinstance(hb, str) and hb:
                try:
                    dt = datetime.fromisoformat(hb.replace("Z", "+00:00"))
                    hb_age = max(0.0, (datetime.now(timezone.utc) - dt).total_seconds())
                except ValueError:
                    hb_age = None
            daemon.update(pid=pid, alive=alive, heartbeat_at=hb,
                          heartbeat_age_sec=round(hb_age, 2) if hb_age is not None else None,
                          status="running" if alive else "stale-lock")
            if not alive:
                faults.append({"code": "stale_daemon_lock", "detail": f"Daemon lock {lock_path} points to dead PID {pid}."})
            elif hb_age is not None and hb_age > 120:
                daemon["status"] = "heartbeat-stale"
                faults.append({"code": "daemon_heartbeat_stale", "detail": f"Daemon PID {pid} heartbeat is {int(hb_age)}s old (>120s)."})
        except (ValueError, OSError) as err:
            daemon["status"] = "corrupt-lock"
            faults.append({"code": "corrupt_daemon_lock", "detail": str(err)})
    elif stop_path.is_file():
        daemon["status"] = "manually-stopped"

    summary = {
        "status": "missing" if not db_path.is_file() else "ready",
        "path": str(db_path),
        "daemon": daemon,
        "router_mode": None,
        "paused": None,
        "active_tasks": 0,
        "enabled_routes": [],
        "orphaned_routes": [],
        "health_components": [],
        "effects_depth": 0,
        "pending_proposals": 0,
        "faults": faults,
    }
    if not db_path.is_file():
        return summary

    try:
        with sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True) as db:
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if "bridge_control" in tables:
                cols = {r[1] for r in db.execute("PRAGMA table_info(bridge_control)")}
                row = db.execute("SELECT * FROM bridge_control WHERE id=1").fetchone()
                if row:
                    col_names = [d[0] for d in db.execute("SELECT * FROM bridge_control WHERE id=1").description]
                    ctrl = dict(zip(col_names, row))
                    summary["paused"] = bool(ctrl.get("paused"))
                    summary["router_mode"] = ctrl.get("router_mode", "observe") if "router_mode" in cols else "observe"
            if "tasks" in tables:
                summary["active_tasks"] = db.execute(
                    "SELECT COUNT(*) FROM tasks WHERE status IN ('pending', 'in_progress')"
                ).fetchone()[0]
            if "wakeup_routes" in tables:
                route_cols = [r[1] for r in db.execute("PRAGMA table_info(wakeup_routes)")]
                for row in db.execute("SELECT * FROM wakeup_routes"):
                    r = dict(zip(route_cols, row))
                    if r.get("enabled") and r.get("driver") != "manual":
                        summary["enabled_routes"].append({
                            "task_id": r.get("task_id"),
                            "to_agent": r.get("to_agent"),
                            "driver": r.get("driver"),
                            "consecutive_failures": int(r.get("consecutive_failures") or 0),
                        })
                    if int(r.get("in_flight") or 0) == 1:
                        wpid = r.get("worker_pid")
                        if wpid is not None and not pid_alive(wpid):
                            summary["orphaned_routes"].append({"task_id": r.get("task_id"), "worker_pid": wpid})
                            faults.append({
                                "code": "orphaned_inflight_route",
                                "detail": f"Route for task {r.get('task_id')} has in_flight=1 with dead worker PID {wpid}.",
                            })
            if "bridge_health" in tables:
                h_cols = [r[1] for r in db.execute("PRAGMA table_info(bridge_health)")]
                for row in db.execute("SELECT * FROM bridge_health ORDER BY component ASC"):
                    h = dict(zip(h_cols, row))
                    summary["health_components"].append(h)
                    st = h.get("state") or h.get("status")
                    if st == "error":
                        faults.append({
                            "code": "component_health_error",
                            "detail": f"Component '{h.get('component')}' reported error: {h.get('detail') or 'unknown'}",
                        })
            if "bridge_effects" in tables:
                summary["effects_depth"] = db.execute("SELECT COUNT(*) FROM bridge_effects").fetchone()[0]
            if "router_decisions" in tables:
                summary["pending_proposals"] = db.execute(
                    "SELECT COUNT(*) FROM router_decisions WHERE outcome = 'would_dispatch'"
                ).fetchone()[0]
    except sqlite3.Error as err:
        summary["status"] = "needs-attention"
        faults.append({"code": "bridge_sqlite_error", "detail": str(err)})

    if faults and summary["status"] == "ready":
        summary["status"] = "degraded"
    return summary


def git_status():
    executable = shutil.which("git")
    if not executable:
        return {"status": "missing", "path": None}
    try:
        completed = subprocess.run([executable, "--version"], capture_output=True, text=True, timeout=5, check=False)
        if completed.returncode == 0:
            return {"status": "ready", "path": str(Path(executable).resolve()), "version": completed.stdout.strip()}
    except (OSError, subprocess.TimeoutExpired):
        pass
    return {"status": "invalid", "path": executable}


def baselines(args, project):
    """Inspect, seed, or acknowledge 3-way builtInBase template baselines."""
    skill = safe_path(project, SKILL_PATH) if project.exists() and (project / SKILL_PATH).is_dir() else source_skill()
    validate_component(skill, "skill")
    skill_ver = version(skill)

    if getattr(args, "ack_all", False) or getattr(args, "ack", None):
        if not project.exists() or not project.is_dir():
            raise SetupError("Choose an existing project directory to acknowledge template updates")
        pending = read_template_updates(project)
        changed = []
        if getattr(args, "ack_all", False):
            removed = sorted(pending.keys())
            pending.clear()
        else:
            target_key = Path(args.ack).as_posix()
            removed = [target_key] if target_key in pending else []
            pending.pop(target_key, None)
        updates_file = safe_path(project, TEMPLATE_UPDATES_PATH)
        if removed and updates_file.is_file():
            body = json_text({"version": skill_ver, "updates": dict(sorted(pending.items()))})
            written, _ = write_files(project, {TEMPLATE_UPDATES_PATH: body})
            changed.extend(written)
        return result("baselines", changed, resume_action(project),
                      status="acknowledged", acknowledged=removed,
                      pending_updates=sorted(pending.keys()))

    if getattr(args, "seed", False):
        if not project.exists() or not project.is_dir():
            raise SetupError("Choose an existing project directory to seed baselines")
        builtin_bases = skill_template_bases(skill)
        protocol_refs = skill_protocol_references(skill)
        old_manifest, old_texts = read_baselines(project)
        files_meta = {}
        texts_by_rel = {}
        if old_manifest and isinstance(old_manifest.get("files"), dict):
            for rel, meta in old_manifest["files"].items():
                if rel in old_texts:
                    files_meta[rel] = dict(meta)
                    texts_by_rel[rel] = old_texts[rel]

        # 1. Always store builtInBase for skill-managed template targets so future 3-way merges never overwrite customizations
        for rel, info in builtin_bases.items():
            entry = {"kind": info["kind"], "source": info["source"], "sha256": info["sha256"]}
            live = safe_path(project, rel)
            if live.is_file():
                ws_sha = sha256_text(read_text(live))
                entry["workspace_sha256"] = ws_sha
                entry["customized"] = ws_sha != info["sha256"]
            files_meta[rel] = entry
            texts_by_rel[rel] = info["text"]

        # 2. Non-destructively snapshot bespoke project customizations (AGENTS.md, controls.md, custom roles, custom dialogue refs)
        bespoke_candidates = ["AGENTS.md", "controls.md"]
        roles_dir = safe_path(project, ".agents/roles")
        if roles_dir.is_dir():
            for path in sorted(roles_dir.glob("*.md")):
                if path.is_file() and not path.is_symlink():
                    bespoke_candidates.append(path.relative_to(project).as_posix())
        dialogue_dir = safe_path(project, ".agents/skills/research-dialogue")
        if dialogue_dir.is_dir():
            for path in sorted(dialogue_dir.rglob("*.md")):
                if path.is_file() and not path.is_symlink():
                    bespoke_candidates.append(path.relative_to(project).as_posix())

        for rel in bespoke_candidates:
            if rel in builtin_bases:
                continue
            live = safe_path(project, rel)
            if live.is_file():
                text = read_text(live)
                digest = sha256_text(text)
                files_meta[rel] = {
                    "kind": "project-custom",
                    "source": "workspace-seed",
                    "sha256": digest,
                    "workspace_sha256": digest,
                    "customized": True,
                }
                texts_by_rel[rel] = text

        desired_tree = build_baseline_tree(skill_ver, files_meta, texts_by_rel, protocol_refs)
        dest = safe_path(project, BASELINES_PATH)
        changed = []
        if not same_bytes_tree(dest, desired_tree):
            with staging(project) as temporary:
                stage = Path(temporary)
                incoming = stage / "baselines"
                incoming.mkdir()
                for name, raw_bytes in desired_tree.items():
                    target = incoming / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(raw_bytes)
                replace_components(project, {BASELINES_PATH: incoming}, stage, ())
                changed.append(str(BASELINES_PATH))
        return result("baselines", changed, resume_action(project),
                      status="seeded", version=skill_ver,
                      tracked_files=sorted(files_meta.keys()),
                      customized_files=sorted(k for k, v in files_meta.items() if v.get("customized")),
                      pending_updates=sorted(read_template_updates(project).keys()),
                      note="Non-destructive baseline snapshot completed; zero workspace files were modified.")

    manifest, _ = read_baselines(project)
    pending = read_template_updates(project)
    tracked = sorted(manifest.get("files", {}).keys()) if manifest else []
    customized = sorted(k for k, v in (manifest.get("files", {}) if manifest else {}).items() if v.get("customized"))
    status = "default-updated" if pending else ("tracked" if manifest else "missing")
    return result("baselines", [], resume_action(project) if manifest else cli_command(project, "baselines", "--seed"),
                  status=status, version=manifest.get("version") if manifest else None,
                  tracked_files=tracked, customized_files=customized,
                  pending_updates=sorted(pending.keys()),
                  note="Read-only baseline inspection.")


def probe(args, project):
    """Single-shot read-only environment & workspace probe for SETUP.md guided onboarding."""
    hints = discover_project_mcp_hints(project)
    node_info = node_status(getattr(args, "node", None))
    if node_info["status"] == "missing" and not getattr(args, "node", None) and hints.get("node"):
        node_info = node_status(hints["node"])

    providers = {}
    for agent, (binary, _) in AGENTS.items():
        found = shutil.which(binary)
        source = "PATH" if found else None
        if not found and hints["provider_bins"].get(agent):
            candidate = shutil.which(hints["provider_bins"][agent])
            if candidate:
                found = candidate
                source = "project-mcp-config"
        providers[agent] = {
            "executable": str(Path(found).resolve()) if found else None,
            "source": source,
            "authentication": "not-verified",
        }

    exists = project.exists() and project.is_dir()
    records = {name: ("present" if exists and safe_path(project, name).is_file() else "missing") for name in RECORDS}
    agents_md = bool(exists and safe_path(project, "AGENTS.md").is_file())
    role_cards = []
    if exists and safe_path(project, ".agents/roles").is_dir():
        role_cards = sorted(
            p.relative_to(project).as_posix()
            for p in safe_path(project, ".agents/roles").glob("*.md")
            if p.is_file() and not p.is_symlink()
        )
    mem = memory_status(project)
    bridge_db = discover_bridge_db(project, hints=hints)
    bridge = inspect_bridge_readonly(bridge_db)
    manifest, _ = read_baselines(project)
    pending_updates = read_template_updates(project)
    initialized = bool(
        any(v == "present" for v in records.values())
        or mem["status"] != "missing"
        or bridge["status"] != "missing"
        or agents_md
    )

    workspace = {
        "exists": exists,
        "initialized": initialized,
        "records": records,
        "agents_md": agents_md,
        "role_cards": role_cards,
        "memory": mem,
        "bridge": bridge,
        "baselines": {
            "status": "default-updated" if pending_updates else ("tracked" if manifest else "missing"),
            "version": manifest.get("version") if manifest else None,
            "tracked_count": len(manifest.get("files", {})) if manifest else 0,
            "pending_updates": sorted(pending_updates.keys()),
        },
    }
    action = resume_action(project) if initialized else cli_command(project, "install")
    return result("probe", [], action,
                  python={"status": "ready", "version": sys.version.split()[0], "executable": sys.executable},
                  fts5={"status": fts_status()},
                  git=git_status(),
                  node=node_info,
                  providers=providers,
                  workspace=workspace,
                  note="Read-only environment probe; zero files or databases were created or modified.")


def is_workspace_initialized(project: Path, bridge_db: Path) -> bool:
    if bridge_db.is_file():
        return True
    if not project.exists() or not project.is_dir():
        return False
    return bool(
        any(safe_path(project, name).is_file() for name in RECORDS)
        or safe_path(project, ".research-memory").exists()
        or safe_path(project, ".agent-bridge").exists()
        or safe_path(project, "environment/bridge").exists()
        or safe_path(project, "AGENTS.md").is_file()
        or safe_path(project, ".codex/config.toml").is_file()
        or safe_path(project, ".mcp.json").is_file()
    )


def watchdog(args, project):
    """External watchdog CLI implementing the 4-level exit code contract (0/1/2/3)."""
    action = getattr(args, "action", "status") or "status"
    hints = discover_project_mcp_hints(project)
    db_path = discover_bridge_db(project, getattr(args, "bridge_db", None), hints=hints)

    # Exit 3: Project not initialized
    if not is_workspace_initialized(project, db_path):
        out = result(
            "watchdog", [], cli_command(project, "init", "--question", "Your research question"),
            action=action, status="uninitialized", exit_code=3,
            errors=[{"code": "project_uninitialized", "detail": f"Workspace {project} has not been initialized."}],
        )
        return 3, out

    # Resolve runtime & Node >= 24 (Exit 2 on missing/invalid config or runtime)
    runtime, location = runtime_at(project) if project.exists() else (None, "missing")
    if runtime is None and hints.get("runtime"):
        runtime, location = hints["runtime"], "configured"
    config_errors = []
    if runtime is None:
        config_errors.append({"code": "runtime_missing", "detail": "Bridge runtime is missing; install from the complete bundle."})
    else:
        try:
            validate_component(runtime, "runtime")
        except (ValueError, OSError) as err:
            config_errors.append({"code": "runtime_invalid", "detail": str(err)})

    node_info = node_status(getattr(args, "node", None))
    if node_info["status"] == "missing" and not getattr(args, "node", None) and hints.get("node"):
        node_info = node_status(hints["node"])
    if node_info["status"] != "ready":
        config_errors.append({
            "code": "node_unavailable",
            "detail": f"Node >= 24 is required for agent-bridge watchdog (found status={node_info['status']}).",
        })

    requested_peers = []
    if getattr(args, "peers", None):
        requested_peers = list(dict.fromkeys(
            part for value in args.peers for part in re.split(r"[,\s]+", value) if part
        ))
        for peer in requested_peers:
            if peer not in AGENTS:
                config_errors.append({"code": "invalid_peer", "detail": f"Unknown peer '{peer}'."})

    snap = inspect_bridge_readonly(db_path)

    # Check provider binaries for explicitly requested --peers or enabled automatic wakeup routes
    required_agents = set(p for p in requested_peers if p in AGENTS)
    for route in snap["enabled_routes"]:
        mapped = DRIVER_TO_AGENT.get(str(route.get("driver") or ""))
        if mapped:
            required_agents.add(mapped)
    for agent in sorted(required_agents):
        binary, _ = AGENTS[agent]
        found = shutil.which(binary) or (shutil.which(hints["provider_bins"][agent]) if hints["provider_bins"].get(agent) else None)
        if not found:
            config_errors.append({
                "code": "provider_cli_missing",
                "detail": f"Required provider CLI '{binary}' for '{agent}' was not found on PATH or project MCP config.",
            })

    if config_errors:
        out = result(
            "watchdog", [], "Install/configure Node >= 24 and required provider CLIs before retrying watchdog.",
            action=action, status="configuration-error", exit_code=2,
            runtime_source=location, node=node_info, bridge=snap, errors=config_errors,
        )
        return 2, out

    lock_path = db_path.parent / "wakeup-daemon.json"
    stop_path = db_path.parent / "wakeup-daemon.stopped"
    respect_stop = bool(getattr(args, "respect_stop", False))

    if action == "status":
        # Strictly read-only!
        if snap["faults"]:
            out = result(
                "watchdog", [], cli_command(project, "watchdog", "restart", "--respect-stop"),
                action=action, status="unhealthy", exit_code=1,
                runtime_source=location, node=node_info, bridge=snap, errors=snap["faults"],
            )
            return 1, out
        daemon_state = "respecting-manual-stop" if (respect_stop and stop_path.is_file()) else snap["daemon"]["status"]
        out = result(
            "watchdog", [], resume_action(project),
            action=action, status="healthy", daemon_status=daemon_state, exit_code=0,
            runtime_source=location, node=node_info, bridge=snap, errors=[],
        )
        return 0, out

    node_bin = node_info["path"]
    daemon_mod = (runtime / "src/runtime/superagent-daemon.mjs").resolve().as_uri()
    bridge_mod = (runtime / "src/core/bridge-db.mjs").resolve().as_uri()
    watchdog_mod = (runtime / "src/runtime/watchdog-service.mjs").resolve().as_uri()
    health_mod = (runtime / "src/runtime/health-board.mjs").resolve().as_uri()

    if action == "stop":
        js = (
            f'import {{ stopResidentSuperagentDaemon }} from {json.dumps(daemon_mod)};'
            f'stopResidentSuperagentDaemon(process.argv[1], {{ markManualStop: true }});'
        )
        completed = subprocess.run([node_bin, "--input-type=module", "-e", js, str(db_path)],
                                   capture_output=True, text=True, timeout=15, check=False)
        if completed.returncode != 0:
            out = result("watchdog", [], "Inspect daemon permissions and retry stop.",
                         action=action, status="unhealthy", exit_code=1,
                         errors=[{"code": "stop_failed", "detail": completed.stderr.strip() or "stop script failed"}])
            return 1, out
        post = inspect_bridge_readonly(db_path)
        out = result("watchdog", [str(stop_path)], resume_action(project),
                     action=action, status="stopped", exit_code=0,
                     runtime_source=location, node=node_info, bridge=post, errors=[])
        return 0, out

    # action in {"start", "restart"}
    if respect_stop and stop_path.is_file():
        out = result("watchdog", [], cli_command(project, "watchdog", "start"),
                     action=action, status="respecting-manual-stop", exit_code=0,
                     runtime_source=location, node=node_info, bridge=snap, errors=[],
                     note="Manual stop marker is present; skipped daemon startup because --respect-stop was set.")
        return 0, out

    js = f"""
import fs from "node:fs";
import {{ ensureResidentSuperagentDaemon, stopResidentSuperagentDaemon }} from {json.dumps(daemon_mod)};
import {{ BridgeDatabase }} from {json.dumps(bridge_mod)};
import {{ HealthBoard }} from {json.dumps(health_mod)};
import {{ WatchdogService }} from {json.dumps(watchdog_mod)};

const dbPath = process.argv[1];
const action = process.argv[2];
const respectStop = process.argv[3] === "1";

if (action === "restart") {{
  stopResidentSuperagentDaemon(dbPath, {{ markManualStop: false }});
}}
if (fs.existsSync(dbPath)) {{
  const bridgeDb = new BridgeDatabase(dbPath);
  const healthBoard = new HealthBoard({{ repos: bridgeDb.store, pid: process.pid }});
  const wd = new WatchdogService({{ engine: bridgeDb.engine, healthBoard, dbPath }});
  wd.runSweep();
}}
const res = ensureResidentSuperagentDaemon(dbPath, {{
  clearStopMarker: !respectStop,
  respectStop,
}});
console.log(JSON.stringify(res || {{ spawned: false }}));
"""
    child_env = dict(os.environ)
    child_env.pop("BRIDGE_DISABLE_WAKEUP_DAEMON", None)
    child_env.pop("BRIDGE_WAKEUP_DAEMON_PROCESS", None)
    for agent, (_, env_var) in AGENTS.items():
        if env_var not in child_env and hints["provider_bins"].get(agent):
            child_env[env_var] = hints["provider_bins"][agent]

    completed = subprocess.run(
        [node_bin, "--input-type=module", "-e", js, str(db_path), action, "1" if respect_stop else "0"],
        capture_output=True, text=True, timeout=20, env=child_env, check=False,
    )
    if completed.returncode != 0:
        out = result("watchdog", [], "Inspect bridge logs and retry watchdog restart.",
                     action=action, status="unhealthy", exit_code=1,
                     errors=[{"code": "daemon_spawn_failed", "detail": completed.stderr.strip() or completed.stdout.strip()}])
        return 1, out

    # Wait briefly for spawned resident daemon to write wakeup-daemon.json lock
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        if lock_path.is_file():
            try:
                if pid_alive(read_json(lock_path).get("pid")):
                    break
            except (ValueError, OSError):
                pass
        time.sleep(0.08)

    post = inspect_bridge_readonly(db_path)
    if not post["daemon"]["alive"] or post["faults"]:
        errs = post["faults"] or [{"code": "daemon_not_alive", "detail": "Resident daemon did not stay alive after start."}]
        out = result("watchdog", [], "Inspect bridge database permissions and daemon logs.",
                     action=action, status="unhealthy", exit_code=1,
                     runtime_source=location, node=node_info, bridge=post, errors=errs)
        return 1, out

    out = result("watchdog", [str(lock_path)], resume_action(project),
                 action=action, status="healthy", daemon_status="running", exit_code=0,
                 runtime_source=location, node=node_info, bridge=post, errors=[])
    return 0, out


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise SetupError(message)


def workbench(args, project):
    if getattr(args, "json", False):
        raise SetupError("Workbench runs an interactive server; omit --json and use its browser interface")
    if not project.is_dir():
        raise SetupError("Choose an existing project directory for the workbench")
    if not 0 <= args.port <= 65535:
        raise SetupError("--port must be between 0 and 65535; use 0 to select an available port")
    runtime, _ = runtime_at(project)
    if runtime is None:
        raise SetupError("Workbench needs the complete bundle's runtime; install it in this project first")
    validate_component(runtime, "runtime")
    validate_workbench(runtime)
    hints = discover_project_mcp_hints(project)
    node = node_status(args.node or hints["node"])
    if node["status"] != "ready":
        raise SetupError("Workbench needs Node >=24; install it or pass --node /absolute/path/to/node")
    command = [node["path"], str(runtime / "src/workbench/server.mjs"),
               "--project", str(project), "--port", str(args.port)]
    if not args.demo:
        explicit_db = getattr(args, "bridge_db", None)
        resolved_db = discover_bridge_db(project, explicit=explicit_db, hints=hints)
        default_local_db = (project / ".agent-bridge/bridge.sqlite").resolve()
        if explicit_db or (resolved_db != default_local_db and resolved_db.exists()):
            command.extend(["--bridge-db", str(resolved_db)])
    if args.demo:
        command.append("--demo")
    if args.open:
        command.append("--open")
    child_env = dict(os.environ)
    for agent_id, (_, env_var) in AGENTS.items():
        if env_var not in child_env and hints["provider_bins"].get(agent_id):
            child_env[env_var] = hints["provider_bins"][agent_id]
    try:
        return subprocess.run(command, cwd=project, env=child_env, check=False).returncode
    except KeyboardInterrupt:
        return 130


def parser():
    root = Parser(description=__doc__, epilog="Setup stays project-local. Workbench actions run only when explicitly submitted in its interface.")
    root.add_argument("--project", default=argparse.SUPPRESS, help="Project directory (default: current directory)")
    root.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help="Print structured output")
    commands = root.add_subparsers(dest="command", required=True)
    for name, description in (("install", "Copy the skill and optional bundled runtime into a project"),
                              ("init", "Create records and memory, or resume an existing workspace"),
                              ("connect", "Prepare project MCP configuration; apply only when requested"),
                              ("doctor", "Inspect readiness without modifying project state"),
                              ("probe", "Read-only environment and workspace probe for guided setup"),
                              ("baselines", "Inspect, seed, or acknowledge 3-way builtInBase template baselines"),
                              ("watchdog", "Inspect or heal the resident superagent watchdog daemon (exit codes 0/1/2/3)"),
                              ("workbench", "Open the local collaboration workbench or a fictional demo")):
        command = commands.add_parser(name, help=description, description=description)
        command.add_argument("--project", default=argparse.SUPPRESS, help="Project directory (default: current directory)")
        command.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help="Print structured output")
        if name == "install":
            command.add_argument("--upgrade", action="store_true", help="Back up and replace a differing managed installation")
            command.add_argument("--skill-only", action="store_true", help="Do not copy the optional runtime")
        if name == "init":
            command.add_argument("--question", help="User-provided research question, preserved verbatim")
            command.add_argument("--title", help="Short workspace title")
        if name in {"connect", "doctor"}:
            command.add_argument("--client", choices=AGENTS, default="codex")
            command.add_argument("--peers", nargs="+", help="Explicit other agents (space or comma separated)")
            command.add_argument("--node", help="Node >=24 executable path or command")
        if name == "connect":
            command.add_argument("--apply", action="store_true", help="Register project config for Codex, Claude Code or Antigravity CLI/IDE")
        if name == "probe":
            command.add_argument("--node", help="Node >=24 executable path or command")
        if name == "baselines":
            command.add_argument("--seed", action="store_true", help="Non-destructively snapshot builtInBase and custom workspace baselines")
            command.add_argument("--ack", help="Acknowledge a reviewed path in template-updates.json")
            command.add_argument("--ack-all", action="store_true", help="Acknowledge all reviewed template updates")
        if name == "watchdog":
            command.add_argument("action", nargs="?", choices=("status", "start", "stop", "restart"), default="status",
                                 help="Watchdog action (status is strictly read-only)")
            command.add_argument("--node", help="Node >=24 executable path or command")
            command.add_argument("--bridge-db", help="Explicit path to bridge.sqlite")
            command.add_argument("--peers", nargs="+", help="Explicit peer CLIs required to be present")
            command.add_argument("--respect-stop", action="store_true", help="Do not start daemon when manual .stopped marker exists")
        if name == "workbench":
            command.add_argument("--node", help="Node >=24 executable path or command")
            command.add_argument("--bridge-db", help="Explicit path to bridge.sqlite")
            command.add_argument("--port", type=int, default=8765, help="Loopback HTTP port; 0 selects an available port")
            command.add_argument("--demo", action="store_true", help="Use fictional in-memory data; never contact providers")
            command.add_argument("--open", action="store_true", help="Open the browser after the server starts")
    return root


def emit_output(command_name, output, structured):
    if structured:
        print(json_text(output), end="")
        return
    print(f"{command_name}: " + ("changed " + ", ".join(output["changed"]) if output["changed"] else "no files changed"))
    for key in ("mode", "status", "daemon_status", "exit_code", "generated", "applied", "backup", "basic_research_ready", "note"):
        if key in output and output[key] is not None:
            print(f"{key}: {output[key]}")
    if "checks" in output:
        for name, value in output["checks"].items():
            print(name + ": " + json.dumps(value, ensure_ascii=False))
    if "providers" in output:
        print("providers: " + json.dumps(output["providers"], ensure_ascii=False))
    if "errors" in output and output["errors"]:
        print("errors: " + json.dumps(output["errors"], ensure_ascii=False))
    if "host_connectivity" in output:
        print("Authentication: not verified. Live host connection: not verified.")
    print("Next action: " + output["next_action"])


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    structured = "--json" in argv
    try:
        args = parser().parse_args(argv)
        project = Path(getattr(args, "project", ".")).expanduser().absolute()
        for ancestor in (project, *project.parents):
            if ancestor.is_symlink():
                raise SetupError("Choose a project path without symlink components: " + str(ancestor))
        project = project.resolve()
        if project.exists() and not project.is_dir():
            raise SetupError("--project must be a directory")
        if args.command == "workbench":
            return workbench(args, project)
        if args.command == "watchdog":
            code, output = watchdog(args, project)
            emit_output("watchdog", output, structured)
            return code
        handlers = {
            "install": install,
            "init": init,
            "connect": connect,
            "doctor": doctor,
            "probe": probe,
            "baselines": baselines,
        }
        output = handlers[args.command](args, project)
        emit_output(args.command, output, structured)
        return 0
    except (ValueError, OSError, sqlite3.Error) as error:
        output = {"error": str(error), "changed": [], "next_action": "Resolve the reported issue, then rerun the same command."}
        print(json_text(output) if structured else "Error: " + output["error"] + "\nNext action: " + output["next_action"],
              file=sys.stdout if structured else sys.stderr, end="" if structured else "\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
