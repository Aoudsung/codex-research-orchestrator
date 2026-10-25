# Memory tool guide

The bundled helper provides a local research index and bounded context packets. It uses Python 3.10+ and SQLite FTS5, with no external service, model call, or third-party Python package.

Codex normally handles these operations for you. For a first project, use the [getting-started guide](getting-started.md). This page is the advanced command reference. Run commands in the environment authorized by your project; do not replace existing research files with the example contents.

## Initialize once, then use the installed helper

From a research workspace where the skill is installed:

```sh
python3 .agents/skills/codex-research-orchestrator/scripts/research_setup.py init \
  --project . --question "When are minimum vertex cover and maximum matching equal?"
```

Setup requires Python 3.11+ and creates minimal records, a live `controls.md`, and the memory database. It does not overwrite an existing research project. Existing projects keep their current records; when enabling memory there, explicitly register suitable existing control files with the lower-level helper's `init --control` command.

The commands below run from the research workspace and use its installed helper. A checkout used for development instead has the same script at `skills/codex-research-orchestrator/scripts/research_memory.py`.

Control files are authoritative inputs, not copies of every evolving conclusion. Keep them current and suitable for the intended recipient. The helper rereads them for each context packet. The lower-level memory tool remains compatible with Python 3.10+.

## Remember source-backed material

Create a small source file, such as `matching-bound.md`:

```markdown
For any finite simple graph, each edge of a matching requires a distinct
vertex in any vertex cover. The minimum cover size is therefore at least
the maximum matching size. This establishes a lower bound, not equality.
```

Create `bound-record.json`:

```json
{
  "kind": "evidence",
  "title": "Matching lower bound for vertex cover",
  "summary": "A matching gives a lower bound on every vertex cover.",
  "source": "matching-bound.md",
  "scope": "Finite simple graphs; lower bound only."
}
```

Import the record:

```sh
python3 .agents/skills/codex-research-orchestrator/scripts/research_memory.py \
  --project . remember bound-record.json
```

The result includes the assigned numeric ID. Use the returned ID rather than assuming an ID in an existing database.

Supported kinds are `source`, `evidence`, `claim`, `decision`, `evaluation`, `checkpoint`, and `proposal`. A claim can declare `claim_status` as `conjecture`, `derived`, `supported`, or `refuted`. Use `depends_on` for the IDs of records that support a claim or decision. To replace an earlier record explicitly, provide `supersedes` and a `reason`.

Both the source path and JSON input path are relative to the research project and must remain inside it. The database retains the source's full text as a version snapshot; it does not replace or edit that source.

## Search first, then read

```sh
python3 .agents/skills/codex-research-orchestrator/scripts/research_memory.py \
  --project . search "matching cover" --limit 5

python3 .agents/skills/codex-research-orchestrator/scripts/research_memory.py \
  --project . read 1
```

Search returns compact entries rather than all source bodies. A summary is a retrieval aid, not the evidence itself. Inspect a selected source and its scope before relying on it.

Queries use lexical full-text retrieval. Use explicit terms and alternate wording where needed; the helper does not expand synonyms or run semantic embeddings. Tokenization can limit recall, including for languages without spaces. A failed lexical search is not a finding that evidence does not exist.

## Assemble a task packet

For ordinary continuation:

```sh
python3 .agents/skills/codex-research-orchestrator/scripts/research_memory.py \
  --project . context "matching cover" \
  --profile resume --max-chars 12000 --output resume-01.md
```

The output path is relative to the research project. The helper also writes `resume-01.md.manifest.json` for the lead. Its command response contains only paths, sizes, and counts; read the packet separately when needed. Existing packet or manifest files are not silently overwritten.

For independent analysis, explicitly allow the source and evidence IDs the participant may see:

```sh
python3 .agents/skills/codex-research-orchestrator/scripts/research_memory.py \
  --project . context "matching cover" \
  --profile analysis --allow 1 --require 1 \
  --max-chars 12000 --output analysis-01.md
```

For independent review, first save the complete proposal to a source file and import a `proposal` record. If its returned ID is 2:

```sh
python3 .agents/skills/codex-research-orchestrator/scripts/research_memory.py \
  --project . context "matching cover" \
  --profile review --allow 1 --allow 2 --target 2 --require 1 \
  --max-chars 16000 --output review-01.md
```

The target must be allowlisted. Declared dependencies must also be permitted; the tool does not silently follow a link into an excluded evaluation.

Give the independent participant the packet in an isolated context. Keep the manifest, database, prior judgments, and unrestricted history with the lead. Neutral labels hide internal titles and paths, but cannot remove a judgment written inside an allowed source or its scope. Curating those contents remains the lead's responsibility.

## Budget behavior

The budget is the Python character count of the entire rendered packet, not a token estimate. Choose it from the recipient's input window, leaving space for instructions, reasoning, tool results, and the final answer. The database itself has no such limit; stored history reaches a recipient only through a packet, a `read`, or the lead.

Controls, the complete review target, and required records must fit intact. If any required input is invalid or too large, generation fails without producing a partial packet.

Optional retrieved records enter whole, in ranked order. By default, admitted records with no lexical match stay out even when budget remains. Add `--fill-recent` to let them fill the remaining budget, newest first:

```sh
python3 .agents/skills/codex-research-orchestrator/scripts/research_memory.py \
  --project . context "matching cover" \
  --profile resume --fill-recent --max-chars 12000 --output resume-02.md
```

Every packet ends with a `Not shown` section. It states how many admitted records are absent and indexes as many as fit in the remaining budget: query matches over budget first, then invalid records, then the rest, newest first. A `resume` entry gives the record ID, kind, title, size, and reason, so the lead can `read` it. An independent entry gives a neutral label, size, reason, and up to 120 characters of scope; titles, paths, and IDs stay in the manifest. Index entries never push the packet over budget, so a small budget may show only the count.

The manifest records the actual character count, selected records, source mappings, every omission, and which omissions were indexed, by their packet label. The independent packet does not reveal excluded evaluation titles or paths.

Text that does not change between builds comes first; the assembly time is the last line. Two packets built from the same inputs therefore agree up to that line. A provider can reuse a cached prefix only if the leading tokens match exactly, the model and settings are the same, and the cache entry has not been evicted. The helper does not observe or measure cache reuse.

## Change and invalidation

```sh
python3 .agents/skills/codex-research-orchestrator/scripts/research_memory.py \
  --project . check

python3 .agents/skills/codex-research-orchestrator/scripts/research_memory.py \
  --project . withdraw 1 --reason "The source was withdrawn."
```

Selected records and their declared dependencies are checked against the current source text during use. Source changes trigger `needs_review`; explicit supersession or withdrawal also invalidates registered downstream records. Historical snapshots are retained. Restore a usable record by making a fresh, justified entry rather than silently relabeling the old one as current.

Record validity is separate from scientific truth. `needs_review` does not mean `refuted`. Newer evidence does not automatically supersede older evidence, and the helper does not decide scientific contradictions.

## Guarantees and limits

The tool checks project-local paths, explicit record relationships, source snapshots, live controls, profile eligibility, and packet size. Each guarantee below holds only under the stated condition:

- Excluded records do not affect independent ranking, because ranking statistics are computed from the admitted records alone. The same query, allowlist, and record contents give the same ranking.
- Every admitted record is either in the packet or counted in its `Not shown` section. Whether it is also indexed depends on the remaining budget.
- A packet never exceeds `--max-chars` Python characters. That bound is on characters, not on the recipient's tokens.
- Each write commits all of its changes or none of them: a new record with its dependencies, index entry, and any supersession; a withdrawal with its downstream invalidations; a check with all of its invalidations. Invalidations found while checking a new record's dependencies are committed first, and they remain if the record is then rejected. The packet and manifest are created together, and a failed write removes whichever file was created. A process killed between the two writes can still leave the manifest alone.

It cannot verify the truth of a claim, the user's identity or authorization, the completeness of declared dependencies, the scientific adequacy of a selected evidence set, or the independence of the wider agent context. It checks locally saved sources; external sources need deliberate refresh. Generated packets describe the moment they were built and must be rebuilt after relevant changes.

For the collaboration rules, see [research memory and task context](../skills/codex-research-orchestrator/references/memory.md). For the upstream ideas and how they were adapted, see [memory foundations](memory-foundations.md).
