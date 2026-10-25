# Research memory and task context

Read this file when a project has enough history that repeated file reading or manual context selection becomes costly. The bundled `scripts/research_memory.py` provides local memory and task-context assembly. It requires Python 3.10 or later with SQLite FTS5; it makes no network or model calls.

## Three layers

1. **Authoritative controls:** small project files containing the current research question, confirmed constraints, permission and resource limits, and pause instructions. Read these live, even when the memory index has not changed.
2. **Working context:** the current question, necessary materials, and the next decision. Assemble this for each task rather than replaying the full chat or reusing an old packet.
3. **Persistent research records:** source-backed evidence, claims, decisions, evaluations, proposals, and checkpoints. Search their short indexes, then read selected original material.

The existing charter, project settings, state, and original sources remain authoritative. The database stores typed records and exact source snapshots for retrieval and version checking. It is not a second charter or an automatic truth service.

An optional collaboration bridge has a separate execution source of truth: task/session/model bindings, message cursors, permission leases, artifact deliveries, and validation status. Keep scientific requirements, claims, decisions, and accepted evidence in research files and memory. Transport success cannot turn a collaborator's evaluation into a fact or override current user instructions.

## What to remember

Write records after a meaningful result or decision, not after every tool call. Each record identifies its kind, title, short search summary, source file, applicable conditions or version, and declared dependencies. Keep source cards small enough to inspect, with units, assumptions, contrary results, and qualifications intact.

- `source` and `evidence`: primary material or direct observations, without inherited judgments.
- `claim`: a conjecture, derived result, supported claim, or refuted claim, with its conditions.
- `decision`: the current choice and its reason; it can change within authorization.
- `evaluation`: a participant's assessment of a specified version. It is not primary evidence.
- `proposal`: the complete version to be reviewed.
- `checkpoint`: ongoing work, pending results, and a resumption pointer. It is not an instruction to repeat a job.

Use the existing `checkpoint` kind for a task reference, delivery revision, accepted result location, and next action. Do not add a memory kind or schema merely for bridge IDs. Leave the full inbox and patch history in execution storage, retrieving exact artifacts only for a specific judgment. A lead assessment records what a result means before it becomes a scientific claim or decision in memory.

Do not infer that a repeated statement is a fact. Do not turn a collaborator's confidence into evidence. A title or summary is a retrieval aid; inspect the source before relying on the claim.

Confirmed user constraints remain in the live control files. Only update those constraints on the user's instruction. Registering a file or labeling a record cannot authenticate the user's permission.

## Retrieve progressively

First search for a bounded set of short entries, then read only selected records and their necessary evidence. Use the current scientific question, important terms, and alternate wording to construct queries. The built-in index uses lexical full-text search, not embeddings or semantic reasoning. No hit means no lexical match in the permitted records, not proof that relevant evidence is absent.

Use explicit required records when a counterexample, disputed source, or acceptance condition must be considered even if its query score is low. A ranking cannot determine whether the evidence set is scientifically complete. Read scope and source state before treating a result as usable.

## Build context for the recipient

| Profile | Eligible material | Material boundary |
|---|---|---|
| `resume` | Current records, including decisions, claims, evaluations, and checkpoints | The lead may use the project's current history |
| `analysis` | Explicitly allowed primary sources and direct evidence, plus live controls | Withhold prior decompositions, candidate choices, and evaluations |
| `review` | Analysis material plus the complete designated proposal | Withhold prior reviews and the answer the lead expects |

For independent work, the lead first curates an allowlist. Filtering happens before retrieval and ranking. The packet uses neutral material labels; private source mappings and omission details stay in a separate lead manifest. The participant should receive the packet in a context without inherited evaluations, not the memory database, manifest, or unrestricted project history.

Classification does not remove opinions already present inside a source file. Inspect the allowed files and controls for such content before calling the work independent. The tool can restrict the packet it builds, but cannot restrict the agent's wider filesystem access or erase an inherited conversation.

Keep storage and access separate. If identical content is stored once and referenced from several places, who may read it is still an explicit per-recipient list. A shared copy, an "already seen" marker, or a global position in the history does not grant a participant access to anything.

## Budget and completeness

Stored is not the same as visible. The database keeps the full history; a recipient can use only what its packet and prompt contain. Two limits follow, and they are different:

- **Packet budget:** set from the recipient's input window, minus task instructions, reasoning, tool results, and the answer. This is a strict Python character count, not a model-token estimate; no universal character-to-token conversion is assumed. Near the window limit, count the complete final prompt (packet plus instructions) with the recipient's actual tokenizer.
- **Stored history:** has no packet limit. It reaches a recipient only through a new packet, an explicit `read`, or material the lead supplies.

Fill the packet in tiers:

1. **Required:** live controls, the designated full proposal, and `--require` records must fit in full. If they do not fit, generation fails rather than truncating conditions or quietly reducing review scope. Increase the budget, split the question with an explicit scope, or use a suitable context window.
2. **Fill:** optional records enter whole, in permitted retrieval order. With `--fill-recent`, admitted records without a lexical match then fill the remaining budget, newest first. Without it, a query word that does not occur leaves those records out even when budget remains.
3. **Index:** a closing section counts every admitted record that is not in the packet and indexes as many as still fit. The order is query matches over budget, then invalid records, then the rest, newest first. A `resume` index shows record IDs and titles; an independent index shows only neutral labels, sizes, reasons, and a short scope. The count is always present, so omitted material is never silently absent.

The lead manifest records every selection and omission and which omissions were indexed. A packet is a dated snapshot: rebuild it after new instructions, changed evidence, or a new proposal version. Unchanging text comes first and the assembly time last. A model provider can reuse a cached prefix only when the leading tokens match exactly, the same model and settings are used, and the cache entry still exists. The tool does not measure cache reuse.

## Updates and invalidation

The helper compares selected source text with the saved snapshot and checks declared dependencies. An edited or missing source makes the affected material unusable as current; dependent records require review. Explicit supersession or withdrawal also invalidates registered downstream conclusions. The prior record remains available as history.

Record validity and scientific status are different. `needs_review` does not mean a theorem is false or an experiment has refuted a hypothesis. A later entry does not automatically replace an earlier one. The lead determines whether a new result supports, limits, conflicts with, or refutes a claim, then records that judgment and its evidence.

The tool cannot detect unregistered dependencies or changes to an online source that has not been updated locally. Preserve source versions and refresh external evidence deliberately. It does not resolve scientific contradictions with a recency rule or an LLM guess.

## Resumption and compaction

Before a handoff or context compaction, update the existing state with the next action, pending feedback, source pointers, running-job identifiers, and latest permissions. Store a checkpoint if it will aid retrieval.

For incremental collaboration, retain a reference to the processed cursor and current artifact revision rather than replaying every message. A source read-set can help reuse unchanged context but grants no access and establishes no independence. Build a fresh recipient-specific packet when the question, evidence, or revision changes; independent participants must not receive the execution inbox or prior evaluations as general continuation context.

On resumption, read live controls first, check active jobs through the actual environment, and assemble a fresh working context. A checkpoint or cached packet cannot authorize a new run or override a pause received later. Independent tasks start from curated materials and must not load the general resumption context.

For CLI usage and concrete examples, see `scripts/research_memory.py --help` and the repository's memory-tool guide. The public design references are in `docs/memory-foundations.md`; they are background, not files a standalone skill needs at runtime.

Minimal invocation pattern, with paths and IDs taken from the actual project:

```sh
python3 /path/to/skill/scripts/research_memory.py --project research/topic init --control controls.md
python3 /path/to/skill/scripts/research_memory.py --project research/topic remember record.json
python3 /path/to/skill/scripts/research_memory.py --project research/topic search "key research terms" --limit 5
python3 /path/to/skill/scripts/research_memory.py --project research/topic read 1
python3 /path/to/skill/scripts/research_memory.py --project research/topic context "key research terms" --profile analysis --allow 1 --require 1 --max-chars 12000 --output analysis-01.md
```

The record JSON contains `kind`, `title`, `summary`, `source`, and `scope`, with optional `claim_status`, `depends_on`, `supersedes`, and `reason`. Both JSON input and source paths are relative to the project. The project and its control/source files must already exist. Use returned IDs. Repeat `--allow` or give a quoted comma/space-separated list. For a review, use `--profile review` and a complete allowlisted `proposal` record as `--target`.

The context command returns a compact receipt; the packet and a separate `.manifest.json` are written in the project. Read only the packet into the participant's context. Run `check` to inspect source drift or `withdraw ID --reason TEXT` to record a justified withdrawal. Do not use either operation to decide scientific truth automatically.
