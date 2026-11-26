import { normalizeComparisonProtocol } from "./comparison-evidence.mjs";
import { WORKLOAD_TYPES } from "./dispatch-planner.mjs";

const modes = new Set(["auto", "boost", "swarm", "teamwork"]);
const boostRoutes = new Set(["coding", "investigation"]);
const teamworkRoutes = new Set(["general", "light_engineering", "document_review", "informal_math", "team_math", "lean4"]);
const namePattern = /^[a-z][a-z0-9-]{0,47}$/;
const namedMode = /^\s*(?:please\s+)?(?:use|start|run|launch|采用|启用|使用|启动)\s*(boost|swarm|teamwork)(?=\s|$|[,，、:：;；。.!])/i;
const commandPrefix = /^\s*(?:\[\/([a-z]+)\]\\?\(slashCommand;\1\\?\)|[/$]([a-z]+))(?=\s|$|[:：])\s*[:：]?\s*/i;


const strategyClauseBoundary = /[。！？!?；;\n]|\.(?=\s|$)/u;
const englishBoundary = String.raw`(?:^|[,，]\s*|\b(?:and|then|but)\s+)`;
const englishRequest = String.raw`(?:(?:please|(?:i|we)\s+(?:want|need)\s+(?:you\s+)?to)\s+)?`;
const englishNegative = String.raw`(?<negative>(?:(?:do|must|should)\s+not|don['’]t|never|no\s+need\s+to)\s+)?`;
const teamScale = String.raw`(?:(?:a\s+)?(?:(?:very|particularly|extra)\s+)?large\s+team\b|(?:many|lots\s+of)\s+(?:agents?|workers?)\b)`;
const boostName = String.raw`["'“”‘’\x60]?(?:[/$])?boost\b["'“”‘’\x60]?`;
const assignment = String.raw`(?:(?:substantive|individual|delegated|independent)\s+)*(?:sub[ -]?agents?|agents?|workers?|tracks?|workstreams?|assignments?|contributions?|milestones?)\b`;
const everyAssignment = String.raw`(?:(?:for|on|across|to(?:\s+(?:drive|guide|check|improve))?)\s+)?(?:(?:each|every|all)\s+(?:(?:of\s+)?(?:the\s+))?${assignment}|per\s+${assignment})`;
const zhNegative = "(?<negative>不需要|不打算|不想|不要|不必|禁止|不得|不能|不应|不允许|无需|别|避免|不)?";
const zhTeam = "(?:(?:超大(?:型|规模)?|大规模|大型|很大的?|很庞大的?)(?:的)?(?:团队|队伍|代理|智能体)|(?:很多|大量)(?:的)?(?:子代理|代理|智能体|工人))";
const zhEachAssignment = "(?:各个|每(?:个|条|位|项)|所有|全部)[^，,]{0,12}?(?:sub[ -]?agents?|agents?|workers?|轨道|子任务|任务|智能体|工人|成员|工作流|工作项)";

const teamDirectives = [
  new RegExp(String.raw`${englishBoundary}${englishRequest}${englishNegative}(?:(?:use|start|run|assemble|deploy|bring\s+in|create|form|want|need)\s+|(?:(?:use|run|start)\s+teamwork\s+)?with\s+)${teamScale}`, "giu"),
  new RegExp(String.raw`${englishBoundary}(?:(?:use|run|start)\s+teamwork\s+)?(?<negative>without\s+(?:using\s+)?|no\s+|avoid\s+(?:using\s+)?)${teamScale}`, "giu"),
  new RegExp(String.raw`${englishBoundary}${englishRequest}(?<small>(?:use|assemble|form|keep)\s+(?:a\s+)?(?:small|compact|lean)\s+team\b|keep\s+(?:the|your)\s+team\s+(?:small|compact|lean)\b)`, "giu"),
  new RegExp(String.raw`${zhNegative}(?:(?:请|要|得|应|必须)\s*)?(?:使用|采用|组织|组建|启动|调动|投入|安排|召集|需要|想要|用)\s*(?:一个|一支)?\s*${zhTeam}`, "giu"),
  new RegExp(String.raw`(?<negative>无需|不要|不必|别|避免)\s*(?:一个|一支)?\s*${zhTeam}|(?:团队|队伍)(?:规模)?\s*(?<small>不要|不必|不宜|别)(?:过|太)?大|(?<compact>只(?:使用|用)|保持)\s*(?:一个|一支)?\s*(?:小型?|精简)(?:的)?(?:团队|队伍)`, "giu"),
];

const boostDirectives = [
  new RegExp(String.raw`${englishBoundary}${englishRequest}${englishNegative}(?:(?:use|apply|run|enable|put)\s+|(?:(?:use|run|start)\s+teamwork\s+)?with\s+)?${boostName}\s+${everyAssignment}`, "giu"),
  new RegExp(String.raw`${englishBoundary}(?<negative>without\s+(?:using\s+)?|no\s+|avoid\s+(?:using\s+)?)${boostName}\s+${everyAssignment}`, "giu"),
  new RegExp(String.raw`${englishBoundary}(?:(?:for|on)\s+)?${everyAssignment}\s*[,，]?\s+(?:must\s+|should\s+)?${englishNegative}(?:use|apply|run|enable)\s+${boostName}`, "giu"),
  new RegExp(String.raw`${zhNegative}(?:(?:请|要|得|应|必须)\s*)?(?:(?:使用|采用|启用|运行|通过|用|让)\s*)${boostName}\s*(?:(?:来|去)?(?:驱动|辅助|驱使|审核|把关|验证|覆盖|用于|检查)|给|为|面向|到|在)?\s*${zhEachAssignment}`, "giu"),
  new RegExp(String.raw`${zhNegative}(?:(?:给|让|对|为)\s*)?${zhEachAssignment}\s*(?:都|均|一律|必须)?\s*(?<disallowed>不要|不必|禁止|不得|不允许|无需|别|避免|不用)?\s*(?:使用|采用|启用|运行|用|跑)?\s*${boostName}`, "giu"),
];

function requestedDirective(clauses, patterns) {
  let requested = false;
  for (const clause of clauses) {
    for (const pattern of patterns) {
      for (const { groups: { negative, small, compact, disallowed } } of clause.matchAll(pattern)) {
        if (negative || small || compact || disallowed) return "excluded";
        requested = true;
      }
    }
  }
  return requested ? "requested" : null;
}

function collaborationStrategy(objective) {
  const clauses = objective.replace(/\[\/boost\]\\?\(slashCommand;boost\\?\)/giu, "/boost")
    .split(strategyClauseBoundary).map(clause => clause.trim()).filter(Boolean);
  const team = requestedDirective(clauses, teamDirectives);
  const boost = requestedDirective(clauses, boostDirectives);
  return {
    requestedStrategy: {
      teamSize: team === "requested" ? "large" : "default",
      boostScope: boost === "requested" ? "substantive_tracks" : "none",
    },
    excludedStrategy: { largeTeam: team === "excluded", perAssignmentBoost: boost === "excluded" },
  };
}

function requireText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be nonempty text`);
  return value.trim();
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value;
}

function list(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

function texts(value, field) {
  return [...new Set(list(value ?? [], field).map(item => requireText(item, field)))];
}

function id(value, field) {
  if (!namePattern.test(value ?? "")) throw new Error(`${field} must be a lowercase name of up to 48 characters`);
  return value;
}

function chooseExplicit(prompt) {
  const match = commandPrefix.exec(prompt);
  const mode = (match?.[1] ?? match?.[2])?.toLowerCase();
  return modes.has(mode) && mode !== "auto" ? { mode, prefix: match[0] } : null;
}

export function collaborationSessionAttested(engine, child, root) {
  const eventId = JSON.stringify(["collaboration", child.id, "collaboration_session", root.id]);
  const binding = engine.repos.getTaskEvent(eventId)?.result;
  const conversationId = child.bound_conversation_id || child.metadata?.workflow?.owner?.conversationId || child.session_id;
  return Boolean(conversationId && binding?.actorAgent === child.assigned_to && binding.actorSessionId === conversationId);
}

export function isCollaborationCommand(prompt) {
  return typeof prompt === "string" && Boolean(chooseExplicit(prompt) || namedMode.test(prompt));
}

export function parseCollaborationIntent(originalPrompt, mode = "auto") {
  requireText(originalPrompt, "objective");
  if (!modes.has(mode)) throw new Error(`Unknown collaboration mode: ${mode}`);
  const command = chooseExplicit(originalPrompt);
  if (command && mode !== "auto" && mode !== command.mode) {
    throw new Error(`Explicit mode ${mode} conflicts with /${command.mode}`);
  }
  const naturalMode = !command ? namedMode.exec(originalPrompt)?.[1]?.toLowerCase() : null;
  if (naturalMode && mode !== "auto" && mode !== naturalMode) throw new Error(`Explicit mode ${mode} conflicts with the requested ${naturalMode} workflow`);
  const objective = requireText(command ? originalPrompt.slice(command.prefix.length) : originalPrompt, "collaboration objective");
  const { requestedStrategy, excludedStrategy } = collaborationStrategy(objective);
  const clauses = objective.split(/(?<=[。！？!?])|(?<=\.)\s+|\n/u).map(part => part.trim()).filter(Boolean);
  const comparisonConstraints = clauses.filter(part => /\b(?:fair|unfair|apples.to.apples)\b|非公平|公平实验|公平对比/iu.test(part) &&
    /(?:comparison|experiment|baseline|对比|实验|基线)/iu.test(part));
  const constraints = [...new Set([...comparisonConstraints, ...clauses.filter(part =>
    /(?:\b(?:must not|do not|never|only use|within the approved|without changing)\b|不允许|禁止|不得|仅限|不得改变|必须保留|不要)/iu.test(part))])];
  return { originalPrompt, objective, mode: command?.mode ?? naturalMode ?? mode, requestedStrategy, excludedStrategy,
    constraints, comparisonConstraints };
}

const teamworkChecks = {
  general: "Independently reproduce the checks that control delivery. Trace material claims to primary evidence, look for counterexamples and conflicting handoffs, and verify the integrated deliverable through its intended entry point.",
  light_engineering: "Perform a focused review of the diff and replay the relevant user-facing check. Check compatibility and failure cases inside the approved scope. Record commands, outputs, and exit status.",
  document_review: "Audit the delivered document against the source material. Verify citations, exact wording where it matters, calculations, internal consistency, and unresolved claims. Return a source-grounded verdict.",
  informal_math: "Check definitions, hypotheses, inference steps, boundary cases, and candidate counterexamples. Provide an independent derivation or a specific failed implication with evidence.",
  team_math: "Reconcile independently assigned constructions and audit each proof obligation. Attempt disproofs against the central claims and check edge cases before issuing an overall mathematical verdict.",
  lean4: "Validate the delivered statements against the agreed theorem and assumptions. Build the relevant Lean 4 modules in the approved environment, check for sorry or unsupported axioms, and report the exact kernel/build result.",
};

const milestoneChecks = {
  general: [
    ["correctness", "Review correctness and interface assumptions. Run the relevant approved workflow checks once and report the exact output."],
    ["challenge", "Seek a concrete failure, conflicting input, or counterexample against this milestone's current version. Replay any existing unresolved case."],
    ["audit", "Audit provenance, protocol scope and reproducibility. Verify that the logged inputs, observed commands, and evidence actually support the delivery assertion."],
  ],
  light_engineering: [
    ["focused", "Inspect the changed behavior and run the smallest user-facing test that exercises the milestone and its applicable failure cases."],
  ],
  document_review: [
    ["sources", "Cross-check consequential citations, quotes or calculations against the original approved materials."],
    ["argument", "Assess completeness, consistency, evidence strength and whether the requested document is usable by its intended reader."],
  ],
  informal_math: [
    ["construction", "Reconstruct the reasoning from the definitions and check each nontrivial inference."],
    ["disproof", "Attempt counterexamples at the weakest hypothesis or boundary and identify any unresolved proof obligation."],
  ],
  team_math: [
    ["obligations", "Reconcile independently authored proof obligations and verify the interfaces between lemmas or cases."],
    ["adversary", "Seek alternate constructions and counterexamples to the most consequential intermediate statements."],
  ],
  lean4: [
    ["kernel", "Build the exact Lean 4 modules at the current artifact version. Capture the kernel result and inspect axiom or sorry usage."],
    ["statement", "Verify the formal statements and assumptions correspond to the approved mathematical objective and preserve the intended scope."],
  ],
};

function teamworkRoute(intent, authored) {
  const leanMention = /\bLean\s*4\b/i.test(intent.objective);
  const leanDemand = /(?:\b(?:formalize|formalise|mechanize|mechanise|implement|prove|verify)\b[^.!?。！？]{0,95}\b(?:in|using|with)\s+Lean\s*4\b|用\s*Lean\s*4[^。！？]{0,28}(?:形式化|形式证明|核验|实现)|Lean\s*4\s*(?:formalization|implementation|形式化|内核验证))/iu.test(intent.objective);
  const proofDemand = /(?:\b(?:prove|disprove|derive|construct a proof|write a proof|formal proof)\b|(?:证明|证伪|推导)(?:该|此|这个|定理|引理|命题|猜想|公式)|构造.{0,10}证明)/iu.test(intent.objective);
  const documentDemand = /(?:\b(?:review|audit|critique|proofread)\b[^.!?。！？]{0,72}\b(?:document|manuscript|paper|report|draft)\b|(?:审阅|评审|校对|审核)[^。！？]{0,25}(?:文档|稿件|报告|论文))/iu.test(intent.objective);
  const lightEngineeringDemand = /(?:\b(?:small|minor|targeted|lightweight)\s+(?:fix|patch|change|implementation)\b|(?:轻量|小范围|局部)(?:实现|修复|改动))/iu.test(intent.objective);
  const baseline = leanDemand ? "lean4" : documentDemand ? "document_review"
    : proofDemand ? (intent.requestedStrategy.teamSize === "large" ? "team_math" : "informal_math")
    : lightEngineeringDemand ? "light_engineering" : "general";
  if (leanDemand && authored && authored !== "lean4") throw new Error("The original objective requires Lean 4 formalization");
  const selected = authored ?? baseline;
  if (!teamworkRoutes.has(selected)) throw new Error(`Unknown teamwork route: ${selected}`);
  if (selected === "lean4" && !leanMention) throw new Error("Lean 4 requires explicit user intent");
  if (selected === "team_math" && !(intent.requestedStrategy.teamSize === "large" &&
      /\b(?:proof|prove|theorem|conjecture|lemma)\b|定理|证明|引理|猜想/iu.test(intent.objective))) {
    throw new Error("Large-team math requires explicit large-team proof work");
  }
  return selected;
}

function normalizeTrack(value, field = "track") {
  object(value, field);
  if (value.workload !== undefined && !WORKLOAD_TYPES.includes(value.workload)) throw new Error(`Unknown workload: ${value.workload}`);
  return {
    id: id(value.id, `${field}.id`),
    title: requireText(value.title, `${field}.title`),
    objective: requireText(value.objective, `${field}.objective`),
    deliverable: requireText(value.deliverable, `${field}.deliverable`),
    acceptance: requireText(value.acceptance, `${field}.acceptance`),
    dependsOn: texts(value.dependsOn, `${field}.dependsOn`),
    writeRoots: texts(value.writeRoots, `${field}.writeRoots`),
    ...(value.workload !== undefined && { workload: value.workload }),
    ...(value.serialGroup !== undefined && { serialGroup: id(value.serialGroup, `${field}.serialGroup`) }),
  };
}

function distinct(tracks, { independent = false, field = "tracks" } = {}) {
  if (!tracks.length || (independent && tracks.length < 2)) {
    throw new Error(`${field} requires ${independent ? "two or more genuinely independent named deliverables" : "at least one deliverable"}`);
  }
  const ids = new Set(tracks.map(track => track.id));
  if (ids.size !== tracks.length) throw new Error(`Duplicate ${field} ID`);
  if (independent && new Set(tracks.map(track => track.deliverable.toLowerCase().replace(/\s+/g, " "))).size !== tracks.length) {
    throw new Error(`${field} must deliver distinct artifacts or findings`);
  }
  const order = [];
  const visiting = new Set();
  const byName = new Map(tracks.map(track => [track.id, track]));
  const done = new Set();
  function visit(track) {
    if (done.has(track.id)) return;
    if (visiting.has(track.id)) throw new Error(`Cyclic dependency in ${field}: ${track.id}`);
    visiting.add(track.id);
    for (const dep of track.dependsOn) {
      if (!byName.has(dep)) throw new Error(`Unknown ${field} dependency: ${dep}`);
      visit(byName.get(dep));
    }
    visiting.delete(track.id);
    done.add(track.id);
    order.push(track);
  }
  for (const track of tracks) visit(track);
  if (independent && tracks.some(track => track.dependsOn.length ||
      (track.serialGroup && tracks.some(other => other !== track && other.serialGroup === track.serialGroup)))) {
    throw new Error(`${field} must be independently executable. Put dependent work in an integration step or a Teamwork milestone.`);
  }
  return order;
}

function trackList(value, field, independent = false) {
  return distinct(list(value, field).map(track => normalizeTrack(track, field)), { independent, field });
}

function milestoneList(value) {
  const field = "milestones";
  return distinct(list(value, field).map(entry => {
    const milestone = normalizeTrack(entry, "milestone");
    const mode = entry.mode ?? "work";
    if (!["work", "boost", "swarm"].includes(mode)) throw new Error(`Unknown milestone mode: ${mode}`);
    if (entry.tracks !== undefined && mode !== "swarm") throw new Error("Only a Swarm milestone accepts independent tracks");
    return { ...milestone, mode, ...(mode === "swarm" && { tracks: trackList(entry.tracks, `milestone ${milestone.id} tracks`, true) }) };
  }), { field });
}

function builtInTrack(id, title, objective, deliverable, acceptance, writeRoots = []) {
  return { id, title, objective, deliverable, acceptance, writeRoots, dependsOn: [] };
}

function briefFor(track, context) {
  const { objective, originalPrompt, constraints, approval } = context;
  return [
    `Original user request:\n${originalPrompt}`,
    objective !== originalPrompt && `Working objective: ${objective}`,
    `Assignment: ${track.title}\n${track.objective}`,
    `Deliverable: ${track.deliverable}`,
    `Completion evidence: ${track.acceptance}`,
    track.writeRoots.length ? `Exclusive write scope: ${track.writeRoots.join(", ")}` : "Read-only assignment. Return findings or a proposed revision with evidence.",
    constraints.length && `User constraints:\n${constraints.join("\n")}`,
    approval?.successCriteria?.length && `Approved success conditions:\n${approval.successCriteria.join("\n")}`,
    approval?.attachmentRefs?.length && `Approved source material:\n${approval.attachmentRefs.join("\n")}`,
    "Cite exact inputs and artifact versions, provide reproducible evidence references, and state unresolved limits. Use the bound task's permissions.",
  ].filter(Boolean).join("\n\n");
}

function boostReviewBrief(brief, authorStepId, route) {
  const check = route === "coding"
    ? "Reproduce the relevant user-facing behavior against the candidate. Try a failure case, inspect the current revision, and record actual commands, outputs, and exit results."
    : "Follow important claims to their primary sources. Reproduce the decisive observation, check missing evidence and plausible alternatives, and state which observation distinguishes them.";
  return `${brief}\n\nYour challenge assignment is read-only. The candidate brief above describes the author's scope. Fresh challenger for ${authorStepId}. Read the original request and form a check before reading the candidate receipt. Then read its current version and evidence. ${check} Submit a specific counterexample and cite the author step when the candidate fails. The current author applies the repair within their existing scope. Replay the failed check on the revised candidate and cite the current evidence before delivering your verdict.`;
}

function planningBrief(intent, route) {
  return {
    objective: intent.objective, originalPrompt: intent.originalPrompt, requestedStrategy: intent.requestedStrategy,
    constraints: intent.constraints,
    instructions: [
      "The current Lead must resolve the user's actual deliverables, approved scope, success conditions, and dependencies from available project context.",
      "Author named deliverables with a distinct objective, artifact or finding, observable check, and exclusive write roots. Use read-only roles when no write is necessary.",
      "Choose Boost for a difficult implementation or investigation, Swarm for genuinely independent simultaneous work, or Teamwork for a goal requiring approved milestones and an appropriate verdict.",
      intent.mode === "swarm" && "Supply two or more independent real deliverables in tracks. Report if the objective cannot be split without inventing work.",
      intent.mode === "teamwork" && "Supply goal-derived milestones, identify predecessor milestone IDs, and choose the route by the requested outcome.",
      intent.requestedStrategy.teamSize === "large" && "Provide broad, concrete role coverage and a feasible bound on concurrent roles. Assign unique scopes and use waves for remaining roles.",
      intent.requestedStrategy.boostScope === "substantive_tracks" && "Use Boost for each substantive assignment, including delegated integration and verdicts. Its challenger is a primitive role with no recursive Boost.",
    ].filter(Boolean),
    specificationFields: ["mode", "route", "tracks", "milestones", "integration", "requirements", "strategy", "maxParallel", "comparisonProtocol"],
    ...(route && { route }),
  };
}

export function prepareCollaboration({ objective, mode = "auto", specification = null, approval = null, authorizedWriteRoots = [] } = {}) {
  const intent = parseCollaborationIntent(objective, mode);
  if (specification !== null) object(specification, "specification");
  const spec = specification ?? {};
  if (spec.strategy !== undefined) {
    const strategy = object(spec.strategy, "strategy");
    if (strategy.teamSize !== undefined && !["default", "large"].includes(strategy.teamSize)) throw new Error("Unknown team size strategy");
    if (strategy.boostScope !== undefined && !["none", "substantive_tracks"].includes(strategy.boostScope)) throw new Error("Unknown Boost inheritance strategy");
    if (strategy.teamSize === "large") {
      if (intent.excludedStrategy.largeTeam) throw new Error("The original request excludes a large team");
      intent.requestedStrategy.teamSize = "large";
    }
    if (strategy.boostScope === "substantive_tracks") {
      if (intent.excludedStrategy.perAssignmentBoost) throw new Error("The original request excludes Boost across all assignments");
      intent.requestedStrategy.boostScope = "substantive_tracks";
    }
  }
  const selected = intent.mode === "auto"
    ? spec.mode ?? (Array.isArray(spec.milestones) ? "teamwork" : Array.isArray(spec.tracks) ? (spec.tracks.length > 1 ? "swarm" : "boost") : "auto")
    : intent.mode;
  if (!modes.has(selected) || (spec.mode && spec.mode !== selected)) throw new Error("The authored plan conflicts with the requested collaboration mode");
  const route = selected === "boost" ? spec.route ?? (/\b(?:implement|patch|refactor|code)\b|实现|改代码|重构|代码修复/iu.test(intent.objective) ? "coding" : "investigation")
    : selected === "teamwork" ? teamworkRoute(intent, spec.route) : null;
  if (selected === "boost" && !boostRoutes.has(route)) throw new Error(`Unknown Boost route: ${route}`);
  const instructions = planningBrief({ ...intent, mode: selected }, route);
  if (selected === "auto" || (selected === "swarm" && spec.tracks === undefined) ||
      (selected === "teamwork" && spec.milestones === undefined)) {
    return { state: "needs_plan", mode: selected, route, planningBrief: instructions, nextAction: { action: "author_plan" } };
  }
  const comparisonProtocol = spec.comparisonProtocol == null ? null : normalizeComparisonProtocol(spec.comparisonProtocol);
  if (intent.comparisonConstraints.length && !comparisonProtocol) {
    return {
      state: "needs_plan", mode: selected, route,
      planningBrief: { ...instructions, comparisonProtocol: {
        purpose: ["design", "measurement"], dimensions: "Named axes and explicitly requested values",
        matchFields: "Conditions that must match for candidate and baseline",
        openDimensions: "Axes over which the claim goes beyond the named settings",
      } },
      nextAction: { action: "author_comparison_protocol" },
    };
  }
  const constraints = [...new Set([...intent.constraints, ...(approval?.constraints ?? [])])];
  const context = { ...intent, constraints, approval };
  const roles = [];
  const steps = [];
  const boostPairs = [];
  const milestones = [];
  const inheritedBoost = intent.requestedStrategy.boostScope === "substantive_tracks";

  function add(track, { stepId = track.id, memberId = stepId, kind = "work", dependsOn = [], primitive = false, memberRole = "author", brief = briefFor(track, context) } = {}) {
    steps.push({ stepId, memberId, kind, description: track.title, brief, dependsOn, writeRoots: track.writeRoots });
    const workload = track.workload ?? (memberRole === "orchestrator" || kind === "synthesis" ? "panoramic_design"
      : kind === "challenge" || kind === "review" ? "math_or_efficiency_audit"
      : track.writeRoots.length ? "bounded_module_or_data" : "log_evidence_extract");
    roles.push({ memberId, role: memberRole, stepId, title: track.title, brief, writeRoots: track.writeRoots, primitive, workload });
    return stepId;
  }

  function substantive(track, options = {}) {
    const authorStepId = add(track, options);
    if (!options.boost && !inheritedBoost) return authorStepId;
    const review = builtInTrack("check", `Challenge and retest ${track.title}`, "Verify the current candidate against the original assignment.", "Reproducible independent verdict on the current candidate", "State a plausible failure or alternative and cite the evidence that confirms or rules it out.");
    const reviewStepId = add(review, {
      stepId: authorStepId === "candidate" && selected === "boost" ? "candidate-challenge" : `boost-check:${authorStepId}`,
      kind: "challenge", dependsOn: [authorStepId], primitive: true, memberRole: "challenger",
      brief: boostReviewBrief(briefFor(track, context), authorStepId, options.boostRoute ??
        (selected === "boost" ? route : track.writeRoots.length ? "coding" : "investigation")),
    });
    boostPairs.push({ authorStepId, reviewStepId });
    return reviewStepId;
  }

  function parallel(tracks, milestoneId, deps, integration) {
    const namespace = milestoneId ? `${milestoneId}:` : "";
    const branches = tracks.map(track => {
      const stepId = milestoneId ? `swarm-track:${namespace}${track.id}` : `track-${track.id}`;
      return { stepId, output: substantive(track, { stepId, dependsOn: deps }) };
    });
    const reviewers = [];
    const verifierCount = Math.ceil(branches.length / 4);
    for (let group = 0; group < verifierCount; group += 1) {
      const batch = branches.slice(Math.floor(group * branches.length / verifierCount), Math.floor((group + 1) * branches.length / verifierCount));
      const verifier = builtInTrack("verify", "Verify independent contributions",
        `Review ${batch.map(item => item.stepId).join(", ")} using their current board receipt references. Send concrete defects to the original contributor as a counterexample, then recheck their current replacement.`,
        "A cross-check of the assigned tracks and unresolved conflicts", "Replay the decisive checks and check interface or evidence consistency. Cite the exact reviewed steps and versions.");
      reviewers.push(substantive(verifier, { stepId: `swarm-verify:${namespace}${group + 1}`, kind: "review", memberRole: "verifier", dependsOn: batch.map(item => item.output) }));
    }
    return substantive(integration, { stepId: `swarm-integrate${milestoneId ? ":" + milestoneId : ""}`, kind: "synthesis", memberRole: "integrator", dependsOn: reviewers });
  }

  let output;
  if (selected === "boost") {
    const tracks = spec.tracks === undefined ? [] : trackList(spec.tracks, "tracks");
    if (tracks.length > 1) throw new Error("Standalone Boost requires one candidate deliverable");
    const candidate = tracks[0] ?? builtInTrack("candidate", "Produce the first candidate", intent.objective,
      route === "coding" ? "An applicable scoped implementation with verification evidence" : "A source-backed explanation with competing hypotheses and discriminating evidence",
      route === "coding" ? "Reproduce the initial behavior and run the approved candidate check." : "Show observations that support the leading explanation and could disprove it.",
      route === "coding" ? authorizedWriteRoots : []);
    output = substantive(candidate, { stepId: "candidate", boost: true });
  } else if (selected === "swarm") {
    const tracks = trackList(spec.tracks, "tracks", true);
    const integration = spec.integration ? normalizeTrack(spec.integration, "integration") :
      builtInTrack("integration", "Integrate the verified track results", "Resolve interface or evidence conflicts across the named deliverables and assemble the complete result.",
        "Combined deliverable with source links and outstanding gaps", "Check every assigned track and cite current verifier receipts.");
    output = parallel(tracks, null, [], integration);
  } else {
    const entries = milestoneList(spec.milestones);
    const coverage = entries.flatMap(item => item.tracks ?? [item]);
    if (intent.requestedStrategy.teamSize === "large" && (coverage.length < 2 ||
        new Set(coverage.map(item => item.deliverable.toLowerCase().replace(/\s+/g, " "))).size !== coverage.length)) {
      throw new Error("A large-team plan must identify distinct goal-derived work. Explain insufficient independent work to the user before changing the requested strategy.");
    }
    const orchestration = builtInTrack("orchestrator", "Check the milestone execution plan",
      "Check the approved footprint, intended dependency graph, ownership, evidence handoffs and available concurrency. Report missing obligations and suggest versioned changes to the Sentinel. Maintain the board as work proceeds.",
      "An execution and ownership assessment against the approved brief", "Every milestone has a concrete output, an owner and an observable exit check. Explicitly report scope and resource conflicts.");
    const setup = substantive(orchestration, { kind: "milestone", memberRole: "orchestrator" });
    const finished = new Map();
    for (const entry of entries) {
      const deps = entry.dependsOn.length ? entry.dependsOn.flatMap(dep => finished.get(dep)) : [setup];
      const firstStep = steps.length;
      const end = entry.mode === "swarm"
        ? parallel(entry.tracks, entry.id, deps, entry)
        : substantive(entry, { stepId: `milestone-${entry.id}`, ...(entry.serialGroup && { memberId: `writer-${entry.serialGroup}` }),
          kind: "milestone", dependsOn: deps, boost: entry.mode === "boost",
          boostRoute: entry.writeRoots.length ? "coding" : "investigation" });
      const exitStepIds = milestoneChecks[route].map(([kind, instruction]) => {
        const gate = builtInTrack(kind, `Check ${entry.title} (${kind})`,
          `${instruction} Review the current deliverable: ${entry.deliverable}`,
          `Evidence-linked ${kind} verdict on ${entry.title}`,
          `Evaluate this success condition: ${entry.acceptance}. Record current version and evidence. Send a concrete failed check to the original author.`);
        return substantive(gate, { stepId: `milestone-gate:${entry.id}:${kind}`, kind: "review", memberRole: "verifier", dependsOn: [end] });
      });
      finished.set(entry.id, exitStepIds);
      milestones.push({ ...entry, stepIds: steps.slice(firstStep).map(step => step.stepId), exitStepIds });
    }
    const verdict = builtInTrack("verdict", "Issue the independent route verdict", teamworkChecks[route],
      "A route-specific verdict over all current milestone deliverables", "Cite every current milestone and the check results supporting the verdict. Target any counterexample at its responsible step.");
    output = substantive(verdict, { kind: "review", memberRole: "verifier", dependsOn: [...finished.values()].flat() });
  }

  const final = builtInTrack("lead-check", selected === "teamwork" ? "Sentinel final acceptance check" : "Lead independent spot-check",
    "Compare the current deliverable to the original request and each approved acceptance criterion. Independently replay or corroborate high-impact assertions and direct unresolved failures to the responsible step.",
    "An evidence-linked decision covering every requested outcome",
    comparisonProtocol ? `Submit comparisonEvidence for the approved ${comparisonProtocol.purpose} protocol. Trace every in-scope cell to current evidence and distinguish proposed checks, measured results, and claims beyond the sampled settings.`
      : "Cite checks on current artifact versions, the reviewed findings and unresolved requirements.");
  const finalStepId = add(final, { memberId: "lead", kind: "review", memberRole: "lead", primitive: true, dependsOn: [output] });
  if (new Set(steps.map(step => step.stepId)).size !== steps.length) {
    throw new Error("Named deliverables generate conflicting step IDs. Choose distinct track or milestone names.");
  }
  const requirements = [
    ...list(spec.requirements ?? [], "requirements").map(item => ({
      requirementId: id(item.id, "requirement id"), description: requireText(item.description, "requirement description"), stepIds: [finalStepId],
    })),
    ...constraints.map((description, index) => ({ requirementId: `user-constraint-${index + 1}`, description, stepIds: [finalStepId] })),
    ...(approval?.successCriteria ?? []).map((description, index) => ({
      requirementId: `approved-success-${index + 1}`, description, stepIds: [finalStepId],
    })),
  ];
  if (new Set(requirements.map(item => item.requirementId)).size !== requirements.length) throw new Error("Duplicate collaboration requirement ID");
  const maxParallel = spec.maxParallel ?? (intent.requestedStrategy.teamSize === "large" ? 3 : Math.max(2, roles.length - 1));
  if (!Number.isInteger(maxParallel) || maxParallel < 1) throw new Error("maxParallel must be a positive integer");
  const collaboration = {
    schemaVersion: 1, mode: selected, route, originalPrompt: intent.originalPrompt, objective: intent.objective,
    brief: { objective: intent.objective, constraints, ...(approval && { ...approval }) },
    requestedStrategy: { ...intent.requestedStrategy, maxParallel }, milestones,
    ...(comparisonProtocol && { comparisonProtocol }),
    roles: roles.map(({ brief, ...role }) => role), boostPairs, finalStepId,
  };
  const workMode = { boost: "investigate", swarm: "parallel", teamwork: "milestone" }[selected];
  return {
    state: selected === "teamwork" && !approval ? "needs_approval" : "ready", mode: selected, route,
    planningBrief: instructions, roleBriefs: roles, plan: { workMode, steps, requirements, collaboration },
    nextAction: { action: selected === "teamwork" && !approval ? "approve" : "bind_and_start" },
  };
}

export function expandDynamicCollaborationTrack(collaboration, track) {
  if (!collaboration) return { steps: [track], boostPair: null };
  const { boost, ...author } = track;
  const authorStepId = requireText(track.stepId, "track stepId");
  const authorBrief = requireText(track.brief ?? track.description, "track brief");
  author.brief = `Original user request:\n${collaboration.originalPrompt}\n\nAssignment:\n${authorBrief}\n\nApproved constraints:\n${collaboration.brief.constraints.join("\n")}`;
  if (collaboration.mode !== "boost" && collaboration.requestedStrategy?.boostScope !== "substantive_tracks" && boost == null) {
    return { steps: [author], boostPair: null };
  }
  const review = object(boost, "Boost reviewer binding");
  const reviewStepId = `boost-check:${authorStepId}`;
  const reviewerMemberId = requireText(review.reviewerMemberId, "boost.reviewerMemberId");
  if (reviewerMemberId === author.memberId) throw new Error("Boost challenger requires a different member from the author");
  return {
    steps: [author, {
      stepId: reviewStepId, memberId: reviewerMemberId, ...(review.reviewerTaskId && { taskId: review.reviewerTaskId }),
      kind: "challenge", dependsOn: [authorStepId], writeRoots: [],
      description: `Challenge and retest ${authorStepId}`, brief: boostReviewBrief(author.brief, authorStepId, author.writeRoots?.length ? "coding" : "investigation"),
    }],
    boostPair: { authorStepId, reviewStepId },
  };
}
