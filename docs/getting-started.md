# Start your first research project

Give Codex a goal. It handles ordinary setup, keeps the research records, and works out the next useful step with you. You do not need to fill a long form or learn the internal commands.

## Install once in your project

Use Python 3.11 or later. From a downloaded release or a clone of this repository, run:

```sh
python3 setup.py install --project /path/to/your-research-project
```

Replace the example path with your project directory. If you have not downloaded the repository yet:

```sh
git clone https://github.com/Aoudsung/codex-research-orchestrator.git
cd codex-research-orchestrator
python3 setup.py install --project /path/to/your-research-project
```

Open that project in Codex. Approve project trust or reload the host if it asks, then invoke `$codex-research-orchestrator` in a conversation or select it in the skill picker.

The full bundle installs the skill in `.agents/skills/codex-research-orchestrator` and optional collaboration files in `.research-orchestrator/runtime/agent-bridge`. It does not set up accounts, connect other agents, or start background services. You can use the research skill without connecting any other provider.

Repeating the installation is safe. To update managed components, run the install command with `--upgrade`. The installer backs them up and preserves your research documents, databases, and project configuration.

If you installed only the standalone skill, you can start research immediately. Install the full bundle in the same project when you want the optional bridge runtime.

## Say what you want to learn

Start with a question and whatever context you already have:

```text
Use $codex-research-orchestrator to investigate whether retrieval can
reduce factual errors in our support assistant. Start from the notes
in this project and help me identify the key question.
```

Codex reads relevant materials, preserves your original request, and creates minimal research records when needed. It asks only about gaps that affect the scientific question, deliverable, resources, or permissions. You can add constraints in ordinary language, such as “Use public sources only” or “Do not run experiments yet.”

The work stays centered on the question: what is uncertain, what evidence could change the judgment, and what follows from that evidence. Methods and candidate claims can change. Your confirmed requirements stay authoritative. A persuasive proposal or agreement among agents does not establish that a claim is true.

## Continue or check progress

```text
Use $codex-research-orchestrator to continue this project's research.
```

Codex uses the current records, checks pauses and pending work, and continues the next authorized action. Existing research keeps its own entry points; it is not replaced with a new project.

For a short update:

```text
Use $codex-research-orchestrator to show the current conclusion,
the evidence behind it, and the next step.
```

The project records let another session resume without replaying the full conversation. Codex handles recordkeeping as work produces meaningful results.

## Add collaborators when useful

You can keep working with Codex alone. When a partner would help, name the peers and the job:

```text
Use $codex-research-orchestrator to help connect Claude Code to this
project so we can investigate separate explanations and compare them.
```

Peers can exchange questions, evidence, revisions, and results in both directions within the agreed scope. You choose their responsibilities; a provider name does not fix who leads, implements, or reviews. Independent analysis and review receive selected original materials and the relevant proposal, without prior evaluations that would bias the judgment.

Connection setup needs Node.js 24 or later and the full bundle's bridge runtime. It generates configuration with real absolute paths. Codex can apply requested project settings for Codex or Claude Code; Antigravity configuration is exported for manual import. The host may still require trust approval or a reload. Each provider keeps its own supported authentication setup.

A configuration file does not establish a live connection. Codex checks the tools available in the current session before using them. Setup does not launch provider models or authorize experiments, external sharing, publication, or ongoing background work. See [connection details](mcp-setup.md) when you need them.

## If setup needs attention

Tell Codex what happened:

```text
Use $codex-research-orchestrator to check this project's setup and
fix the issue preventing me from starting.
```

The bundled diagnosis is read-only and reports the next action. If you want to run it yourself from the project directory:

```sh
python3 .agents/skills/codex-research-orchestrator/scripts/research_setup.py doctor --project .
```

Missing Node.js does not block research without the optional bridge. If configuration was applied but tools are absent, follow the host's trust or reload steps and check again. The helper cannot establish whether a provider is logged in or a host has loaded a connection.

You can ask Codex to initialize records or connect peers without remembering command syntax. For manual use, the installed helper exposes `install`, `init`, `connect`, and `doctor`; add `--help` for the relevant options.
