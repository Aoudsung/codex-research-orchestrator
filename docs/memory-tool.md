# Memory tool guide

The bundled helper provides a local research index and bounded context packets. It uses Python 3.10+ and SQLite FTS5, with no external service, model call, or third-party Python package.

Run it in the environment authorized by your project. The examples below assume a fresh project directory; do not replace existing research files with the example contents.

## Initialize a project

From this repository, the helper is at:

```text
skills/codex-research-orchestrator/scripts/research_memory.py
```

Create `research/demo/controls.md` with the current objective and user-confirmed boundaries. For example:

```markdown
# Current research controls

Study when minimum vertex cover and maximum matching sizes are equal
in finite simple graphs. Do not assume all graphs are bipartite.

This task permits theoretical reasoning only. Do not run experiments
or contact external collaborators.
```

Register that file:

```sh
python3 skills/codex-research-orchestrator/scripts/research_memory.py \
  --project research/demo init --control controls.md
```

You may register multiple control files. They must be inside the research project. The helper rereads their complete current contents for every context packet. Adding a pause to a registered file therefore does not require a memory import.

Choose small authoritative files that contain the active controls. Check that their content is appropriate for independent disclosure. The helper cannot determine whether a draft interpretation was actually confirmed by the user.

Data stay in the project's `.research-memory/` directory. Keep that generated directory out of public research exports unless its contents are explicitly approved for sharing.

## Remember source-backed material

Create a small source file, such as `research/demo/matching-bound.md`:

```markdown
For any finite simple graph, each edge of a matching requires a distinct
vertex in any vertex cover. The minimum cover size is therefore at least
the maximum matching size. This establishes a lower bound, not equality.
```

Create `research/demo/bound-record.json`:

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
python3 skills/codex-research-orchestrator/scripts/research_memory.py \
  --project research/demo remember bound-record.json
```

The result includes the assigned numeric ID. Use the returned ID rather than assuming an ID in an existing database.

Supported kinds are `source`, `evidence`, `claim`, `decision`, `evaluation`, `checkpoint`, and `proposal`. A claim can declare `claim_status` as `conjecture`, `derived`, `supported`, or `refuted`. Use `depends_on` for the IDs of records that support a claim or decision. To replace an earlier record explicitly, provide `supersedes` and a `reason`.

Both the source path and JSON input path are relative to the research project and must remain inside it. The database retains the source's full text as a version snapshot; it does not replace or edit that source.

## Search first, then read

```sh
python3 skills/codex-research-orchestrator/scripts/research_memory.py \
  --project research/demo search "matching cover" --limit 5

python3 skills/codex-research-orchestrator/scripts/research_memory.py \
  --project research/demo read 1
```

Search returns compact entries rather than all source bodies. A summary is a retrieval aid, not the evidence itself. Inspect a selected source and its scope before relying on it.

Queries use lexical full-text retrieval. Use explicit terms and alternate wording where needed; the helper does not expand synonyms or run semantic embeddings. Tokenization can limit recall, including for languages without spaces. A failed lexical search is not a finding that evidence does not exist.

## Assemble a task packet

For ordinary continuation:

```sh
python3 skills/codex-research-orchestrator/scripts/research_memory.py \
  --project research/demo context "matching cover" \
  --profile resume --max-chars 12000 --output resume-01.md
```

The output path is relative to the research project. The helper also writes `resume-01.md.manifest.json` for the lead. Its command response contains only paths, sizes, and counts; read the packet separately when needed. Existing packet or manifest files are not silently overwritten.

For independent analysis, explicitly allow the source and evidence IDs the participant may see:

```sh
python3 skills/codex-research-orchestrator/scripts/research_memory.py \
  --project research/demo context "matching cover" \
  --profile analysis --allow 1 --require 1 \
  --max-chars 12000 --output analysis-01.md
```

For independent review, first save the complete proposal to a source file and import a `proposal` record. If its returned ID is 2:

```sh
python3 skills/codex-research-orchestrator/scripts/research_memory.py \
  --project research/demo context "matching cover" \
  --profile review --allow 1 --allow 2 --target 2 --require 1 \
  --max-chars 16000 --output review-01.md
```

The target must be allowlisted. Declared dependencies must also be permitted; the tool does not silently follow a link into an excluded evaluation.

Give the independent participant the packet in an isolated context. Keep the manifest, database, prior judgments, and unrestricted history with the lead. Neutral labels hide internal titles and paths, but cannot remove a judgment written inside an allowed source or its scope. Curating those contents remains the lead's responsibility.

## Budget behavior

The budget is the Python character count of the entire rendered packet, not a token estimate. Controls, the complete review target, and required records must fit intact. If any required input is invalid or too large, generation fails without producing a partial packet.

Optional retrieved records enter whole. The manifest records the actual character count, selected records, source mappings, and omissions. The independent packet does not reveal excluded evaluation titles or paths. Choose a packet budget that leaves space in the model context for instructions, reasoning, tool results, and the final answer.

## Change and invalidation

```sh
python3 skills/codex-research-orchestrator/scripts/research_memory.py \
  --project research/demo check

python3 skills/codex-research-orchestrator/scripts/research_memory.py \
  --project research/demo withdraw 1 --reason "The source was withdrawn."
```

Selected records and their declared dependencies are checked against the current source text during use. Source changes trigger `needs_review`; explicit supersession or withdrawal also invalidates registered downstream records. Historical snapshots are retained. Restore a usable record by making a fresh, justified entry rather than silently relabeling the old one as current.

Record validity is separate from scientific truth. `needs_review` does not mean `refuted`. Newer evidence does not automatically supersede older evidence, and the helper does not decide scientific contradictions.

## Guarantees and limits

The tool checks project-local paths, explicit record relationships, source snapshots, live controls, profile eligibility, and packet size. Independent retrieval ranks only the admitted materials, so excluded evaluations do not contribute to that ranking.

It cannot verify the truth of a claim, the user's identity or authorization, the completeness of declared dependencies, the scientific adequacy of a selected evidence set, or the independence of the wider agent context. It checks locally saved sources; external sources need deliberate refresh. Generated packets describe the moment they were built and must be rebuilt after relevant changes.

For the collaboration rules, see [research memory and task context](../skills/codex-research-orchestrator/references/memory.md). For the upstream ideas and how they were adapted, see [memory foundations](memory-foundations.md).
