# Model Hierarchy, Three Session Lanes & Effort Routing

Assignments compile along `Role × Epistemic Stance × Model Adapter` via `research_context(..., role=..., stance=..., recipient_profile=...)`. Channel/role boundaries are machine-enforced at task intake (`intake.mjs` & `research_setup.py lint`).

## Capability Hierarchy & Empirical Responsibilities

Tier ranking: **`ChatGPT Web Pro` > (`GPT Astra` ≈ `Gemini Carbon`) > `Gemini Argon` >= `GPT-6.2 Sol` >= `Kimi 3.1 Pro` > `DeepSeek V4.1 Flash` > `GPT-6 Luna (low)`**. **`Claude` (`claude-code`) is disabled by default.**

| Model / Tier | Session Lane | Primary Responsibility | Enforced Boundary |
|---|---|---|---|
| **ChatGPT Web `Pro`** (`pro_max`) | Designated ChatGPT Web project (standing bundle/repo auth; 15-min `Luna` status check) | Chief macro architect, SOTA framing, multi-layer structural derivations at unrestricted answer depth | No pasted diffs/ledgers in chat; **no SHA-256 verification ceremony** (`pack_pro_bundle.py`) |
| **GPT `Astra`** (`high`/`xhigh`) | `Codex` CLI / subagent (`role` orthogonal to model/effort) | Mathematical/contract formalization, efficiency audits & independent `blind_review` (`formal_falsification`) | Never runs in Antigravity or PI |
| **Gemini `Carbon`** (`high`) | **Pinned project PI session first** (`google-vertex`/`pi`); fallback to pinned `Antigravity` desktop conversation | Mechanism & architecture co-design, full-repo/log panoramic scans (`gemini_panoramic`) | **Never `blind_review`** (barred at intake); preserve pinned PI retry/compaction settings & max concurrency 1; map native IDs (`gemini-pro-orchestrator`) via `modelAliases` |
| **Gemini `Argon`** (`medium`/`high`) / **`GPT-6.2 Sol`** | **Pinned PI `Argon` first** (or pinned/dedicated `Antigravity` fallback) / `Codex` (`Sol`) | Core implementation, real-benchmark baselines, remote server experimental validation | Coordinator (`codex` lead) never edits business code; 1 active writer per `writeRoots` (`WORK_LOCK`) |
| **Kimi 3.1 Pro / DeepSeek V4.1 Flash** | Explicit project-rooted **PI** session (`.pi/sessions/`, `cwd=project`, `magpie` `auto/*`, `retries=0`) | Bounded data pipelines, structured coding submodules, evidence extraction | **Legacy `dyschop/*` banned**; never route GPT inside PI |
| **GPT-6 `Luna`** (`low`) | Tool-free `Luna` effort judge **OR** `Codex` `default`/`explorer` read-only role + `model="gpt-6-luna"`, `effort="low"` | Effort judging (`Luna`) OR L0 remote GPU/process & 15-min Web `Pro` checks (`default`/`explorer`) | **Never assign monitoring/tools to `agent_type="Luna"`**; no code writes or blind review |

## 一 / Cognitive Adapters & Packet Profiles

- **`pro_macro` (ChatGPT Web `Pro`, `<=6,000` chars):** Ground via synced GitHub repo or secret-scrubbed `.zip` (`pack_pro_bundle.py`, `.pi` ignored, default no SHA256 column) + clean 3-paragraph structural prose (`<=850` words; unrestricted answer length). Lead translates prose to formal variables/claims in SQLite.
- **`gpt_contract` (Codex — `Astra` / `6.2 Sol` / `Luna`, `focused_curated` `16k–48k`):** Strict contract/proof verification (`Astra`) or zero-drift execution (`6.2 Sol`). Ambiguities immediately trigger `bridge_handback(reasonCode='scientific_ambiguity')`.
- **`gemini_panoramic` (Pinned PI `Carbon`/`Argon` first, or Antigravity fallback, `150k–400k`):** Native long-context recall over papers, codebases, and logs in static-first prefix order. Enforce Five-Tuple Isomorphism and verbatim citations (`UNOBSERVED` if absent); keep session deltas concise and respect display/native alias mapping.
- **`claude_synthesis` (Opt-in only):** Disabled by default (`forbid_claude_code: true`); active only when user explicitly overrides in `controls.md`.

## L0–L4 Risk-Based Effort & Dynamic Triggers

| Level | Workload | Model + Effort | Profile |
|---|---|---|---|
| **L0** | Read-only status, server GPU free-VRAM check, 15-min Web `Pro` check, search/export | `Luna` (`low`) / fast PI | `worker` (11 tools) / `exec_only` |
| **L1** | Scoped coding & unified real-benchmark execution under locked spec | `Argon` / `6.2 Sol` (`medium`), `Kimi`/`DeepSeek` (`auto/*`) | `worker` (11 tools) |
| **L2** | Core math-to-code, mechanism co-design, claim-bound ablations | `Carbon` / `6.2 Sol` / `Astra` (`high`) | `lead` / `worker` |
| **L3** | Independent `blind_review` (`formal_falsification`), `<5%` tail/leakage audit, Two-Patch triage | `Astra` (`xhigh`) | `lead` (`review` packet) |
| **L4** | Structural impasse (`>=2` patches), first-principles macro redesign | `ChatGPT Web Pro` (`pro_max`) + `Carbon` / `Astra` (`xhigh`) | `pro_macro` / `gemini_panoramic` |

- **Two-Failure / Two-Patch Escalation (`engine.mjs` `jitGuidance`):** `>=2` validation failures or local patches freeze ad-hoc edits and escalate to `Astra`/`Carbon`/`Web Pro`.
- **Three Session Lanes Guard (`intake.mjs` / `research_lint.py`):** Record `(taskId, model, channel, sessionId)`; keep `codex`, `antigravity`, and `.pi/sessions/` cleanly isolated.
