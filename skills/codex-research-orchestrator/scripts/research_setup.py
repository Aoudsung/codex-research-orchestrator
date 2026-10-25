#!/usr/bin/env python3
"""Install, start, connect and inspect a project without global configuration."""
from __future__ import annotations

import argparse
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
RECORDS = ("controls.md", "charter.md", "project.md", "state.md")
AGENTS = {"codex": ("codex", "CODEX_BIN"), "claude-code": ("claude", "CLAUDE_BIN"),
          "antigravity": ("agy", "AGY_BIN")}
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


def same_tree(root, files):
    return root.is_dir() and all_entries(root) == set(files) and all(
        (root / name).read_bytes() == path.read_bytes() for name, path in files.items())


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
    installed_components = dict(previous)
    for relative, (_, kind, _) in components.items():
        installed_components[str(relative)] = {"kind": kind, "files": sorted(files_by_component[relative])}
    new_receipt = {"name": NAME, "version": version(skill), "components": installed_components}
    body = json_text(new_receipt)
    receipt_changed = not receipt_file.is_file() or read_text(receipt_file) != body
    changed = [str(path) for path in changed_components]
    saved = None
    if changed or receipt_changed:
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
            if receipt_changed or changed_components:
                incoming = stage / "receipt.json"
                incoming.write_text(body, encoding="utf-8")
                prepared[RECEIPT_PATH] = incoming
                changed.append(str(RECEIPT_PATH))
            saved = replace_components(project, prepared, stage, prepared)
    return result("install", changed, cli_command(project, "init", "--question", "Your research question"),
                  version=version(skill), mode="full-bundle" if RUNTIME_PATH in components else "skill-only",
                  skill=str(project / SKILL_PATH), runtime=str(project / RUNTIME_PATH) if (project / RUNTIME_PATH).is_dir() else None,
                  backup=saved, note="Runtime files do not start a service. Basic research needs no Node or providers.")


def memory_status(project):
    database = safe_path(project, ".research-memory/memory.sqlite3")
    if not database.is_file():
        return {"status": "missing", "path": str(database)}
    try:
        with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as db:
            config = dict(db.execute("SELECT key, value FROM config"))
            controls = json.loads(config.get("controls", "[]"))
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            good = (config.get("version") == "1" and config.get("project") == str(project)
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
    config = {"codex": Path(".codex/config.toml"), "claude-code": Path(".mcp.json")}.get(client)
    return export, state, config


def connection_state(project, client):
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
    if args.client == "antigravity":
        next_action = f"Import the mcpServers entries from {project / export} using your Antigravity client's MCP configuration interface."
    elif applied:
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
    skill = safe_path(project, SKILL_PATH)
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
    runtime, location = runtime_at(project)
    checks["runtime"] = {"status": location, "path": str(runtime) if runtime else None}
    if runtime:
        try:
            validate_component(runtime, "runtime")
            checks["runtime"]["version"] = read_json(runtime / "package.json").get("version")
        except (ValueError, OSError) as error:
            checks["runtime"].update(status="needs-attention", detail=str(error))
    checks["records"] = {name: "present" if safe_path(project, name).is_file() else "missing" for name in RECORDS}
    checks["memory"] = memory_status(project)
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
        if args.client == "antigravity" and checks["configuration"].get("selection_generated"):
            action = f"Import the mcpServers entries from {project / connection_paths(args.client)[0]} in Antigravity."
        else:
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


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise SetupError(message)


def parser():
    root = Parser(description=__doc__, epilog="No global settings, login, provider calls or experiments are performed.")
    root.add_argument("--project", default=argparse.SUPPRESS, help="Project directory (default: current directory)")
    root.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help="Print structured output")
    commands = root.add_subparsers(dest="command", required=True)
    for name, description in (("install", "Copy the skill and optional bundled runtime into a project"),
                              ("init", "Create records and memory, or resume an existing workspace"),
                              ("connect", "Prepare project MCP configuration; apply only when requested"),
                              ("doctor", "Inspect readiness without modifying project state")):
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
            command.add_argument("--apply", action="store_true", help="Register project Codex/Claude config; Antigravity exports only")
    return root


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
        output = {"install": install, "init": init, "connect": connect, "doctor": doctor}[args.command](args, project)
        if structured:
            print(json_text(output), end="")
        else:
            print(f"{args.command}: " + ("changed " + ", ".join(output["changed"]) if output["changed"] else "no files changed"))
            for key in ("mode", "status", "generated", "applied", "backup", "basic_research_ready", "note"):
                if key in output and output[key] is not None:
                    print(f"{key}: {output[key]}")
            if "checks" in output:
                for name, value in output["checks"].items():
                    print(name + ": " + json.dumps(value, ensure_ascii=False))
            if "providers" in output:
                print("providers: " + json.dumps(output["providers"], ensure_ascii=False))
            if "host_connectivity" in output:
                print("Authentication: not verified. Live host connection: not verified.")
            print("Next action: " + output["next_action"])
        return 0
    except (ValueError, OSError, sqlite3.Error) as error:
        output = {"error": str(error), "changed": [], "next_action": "Resolve the reported issue, then rerun the same command."}
        print(json_text(output) if structured else "Error: " + output["error"] + "\nNext action: " + output["next_action"],
              file=sys.stdout if structured else sys.stderr, end="" if structured else "\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
