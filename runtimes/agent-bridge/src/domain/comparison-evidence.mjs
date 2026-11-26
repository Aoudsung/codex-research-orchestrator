import { isDeepStrictEqual } from "node:util";

const purposes = new Set(["design", "measurement"]);
const statuses = new Set(["planned", "observed", "unmatched", "unmeasured"]);
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = value => typeof value === "string" && value.trim().length > 0;

function distinctStrings(value, field, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || !value.every(isText)) {
    throw new Error(`${field} must be an array of ${allowEmpty ? "" : "one or more "}nonempty strings`);
  }
  const values = value.map(item => item.trim());
  if (new Set(values).size !== values.length) throw new Error(`${field} must contain distinct values`);
  return values;
}

export function normalizeComparisonProtocol(value) {
  if (!isRecord(value) || !purposes.has(value.purpose) || !isRecord(value.dimensions)) {
    throw new Error("comparisonProtocol requires a design or measurement purpose and a dimensions object");
  }
  const dimensions = Object.fromEntries(Object.entries(value.dimensions).map(([name, values]) => {
    if (!isText(name) || name.trim() !== name) throw new Error("Each comparison dimension needs a valid name");
    return [name, distinctStrings(values, `Comparison dimension ${name}`)];
  }));
  const domains = Object.values(dimensions);
  if (!domains.length || !Number.isSafeInteger(domains.reduce((size, domain) => size * domain.length, 1))) {
    throw new Error("comparisonProtocol requires a finite nonempty comparison matrix");
  }
  const matchFields = distinctStrings(value.matchFields, "comparisonProtocol.matchFields");
  const openDimensions = distinctStrings(value.openDimensions ?? [], "comparisonProtocol.openDimensions", true);
  if (openDimensions.some(name => !Object.hasOwn(dimensions, name))) {
    throw new Error("Each open comparison dimension must name a listed dimension");
  }
  return { purpose: value.purpose, dimensions, matchFields, ...(openDimensions.length && { openDimensions }) };
}

function receiptRefs(value, allowed, field) {
  const refs = distinctStrings(value, field);
  if (refs.some(ref => !allowed.has(ref))) throw new Error(`${field} must cite references on the final step receipt`);
  return refs;
}

function matchValue(value) {
  return value !== null && (typeof value === "boolean" || Number.isFinite(value) || isText(value) ||
    (Array.isArray(value) && value.every(matchValue)) ||
    (isRecord(value) && Object.values(value).every(matchValue)));
}

function armRecord(value, allowed, field, observed) {
  if (!isRecord(value) || !isRecord(value.settings)) throw new Error(`${field} requires a settings object`);
  const evidenceRefs = receiptRefs(value.evidenceRefs, allowed, `${field}.evidenceRefs`);
  const hasResult = Object.hasOwn(value, "value") || Object.hasOwn(value, "resultRef") || Object.hasOwn(value, "metric");
  if (observed || hasResult) {
    const metric = value.metric;
    if (!Number.isFinite(value.value) || !isRecord(metric) || !isText(metric.name) || !isText(metric.unit) ||
        !["higher", "lower"].includes(metric.direction) || !isText(value.resultRef) ||
        !evidenceRefs.includes(value.resultRef)) {
      throw new Error(`${field} needs a finite value, metric {name, direction, unit}, and resultRef from its evidenceRefs`);
    }
  }
  return { ...value, evidenceRefs, hasResult };
}

function validateCell(cell, protocol, allowed, label) {
  const observed = cell.status === "observed";
  const comparable = observed || cell.status === "planned";
  if ((!comparable || (protocol.purpose === "measurement" && !observed)) && !isText(cell.reason)) {
    throw new Error(`${label} needs a reason for its ${cell.status} status`);
  }
  if (cell.comparison !== undefined && !observed) throw new Error(`${label} can compare results only when observed`);
  const candidate = cell.candidate !== undefined || comparable
    ? armRecord(cell.candidate, allowed, `${label}.candidate`, observed) : null;
  const baseline = cell.baseline !== undefined || comparable
    ? armRecord(cell.baseline, allowed, `${label}.baseline`, observed) : null;
  if (comparable) {
    for (const field of protocol.matchFields) {
      if (!Object.hasOwn(candidate.settings, field) || !Object.hasOwn(baseline.settings, field) ||
          !matchValue(candidate.settings[field]) || !matchValue(baseline.settings[field]) ||
          !isDeepStrictEqual(candidate.settings[field], baseline.settings[field])) {
        throw new Error(`${label} requires matched candidate and baseline settings for ${field}`);
      }
    }
  }
  if (cell.status === "planned" && (candidate.hasResult || baseline.hasResult)) {
    throw new Error(`${label} records results on a planned cell. Use observed or unmatched status for measurements`);
  }
  if (!observed) return;
  if (baseline.evidenceRefs.includes(candidate.resultRef) || candidate.evidenceRefs.includes(baseline.resultRef)) {
    throw new Error(`${label} needs separate candidate and baseline result references`);
  }
  const { name, unit, direction } = candidate.metric;
  if (baseline.metric.name !== name || baseline.metric.unit !== unit || baseline.metric.direction !== direction) {
    throw new Error(`${label} needs the same candidate and baseline metric, unit, and direction`);
  }
  if (cell.comparison === undefined) return;
  if (!isRecord(cell.comparison)) throw new Error(`${label}.comparison must be an object`);
  const comparisonRefs = receiptRefs(cell.comparison.evidenceRefs, allowed, `${label}.comparison.evidenceRefs`);
  const outcome = candidate.value === baseline.value ? "tie"
    : ((candidate.value > baseline.value) === (direction === "higher") ? "candidate_better" : "baseline_better");
  if (!comparisonRefs.includes(candidate.resultRef) || !comparisonRefs.includes(baseline.resultRef) ||
      ![outcome, "inconclusive"].includes(cell.comparison.outcome)) {
    throw new Error(`${label}.comparison must cite both results and agree with the observed values and metric direction`);
  }
}

export function validateComparisonEvidence(protocol, evidence, { disposition = "complete", evidenceRefs = [] } = {}) {
  if (!["complete", "partial"].includes(disposition)) throw new Error("Unknown comparison disposition");
  const dimensions = Object.entries(protocol.dimensions);
  const expectedCells = dimensions.reduce((size, [, domain]) => size * domain.length, 1);
  const partial = disposition === "partial";
  const counts = { planned: 0, observed: 0, unmatched: 0, unmeasured: 0, missing: expectedCells };
  if (evidence === undefined && partial) {
    return { purpose: protocol.purpose, scope: "listed", expectedCells, counts, reason: "No comparison evidence was delivered." };
  }
  if (!isRecord(evidence) || !Array.isArray(evidence.cells)) {
    throw new Error("Comparison acceptance requires comparisonEvidence with a scope and cells");
  }
  if (evidence.scope !== "listed") {
    throw new Error("Comparison evidence can cover only listed cells. A finite matrix does not establish universal scope");
  }
  const allowed = new Set(distinctStrings(evidenceRefs, "Final step evidenceRefs", true));
  const seen = new Set();
  const issues = [];
  for (const [index, cell] of evidence.cells.entries()) {
    if (!isRecord(cell) || !isRecord(cell.at) || !statuses.has(cell.status) ||
        Object.keys(cell.at).length !== dimensions.length ||
        !dimensions.every(([name, domain]) => Object.hasOwn(cell.at, name) && domain.includes(cell.at[name]))) {
      throw new Error(`Comparison cell ${index + 1} requires a listed value for each declared dimension and a valid status`);
    }
    const coordinates = dimensions.map(([name]) => cell.at[name]);
    const key = JSON.stringify(coordinates);
    if (seen.has(key)) throw new Error(`Duplicate comparison cell ${key}`);
    seen.add(key);
    validateCell(cell, protocol, allowed, `Comparison cell ${key}`);
    counts[cell.status] += 1;
    if (isText(cell.reason)) issues.push({ at: cell.at, status: cell.status, reason: cell.reason.trim() });
  }
  counts.missing -= seen.size;
  const comparable = counts.observed + (protocol.purpose === "design" ? counts.planned : 0);
  if (!partial && comparable !== expectedCells) {
    throw new Error(`Complete ${protocol.purpose} requires matched evidence for every listed comparison cell (${comparable}/${expectedCells})`);
  }
  if (partial && counts.missing && !isText(evidence.reason)) throw new Error("Partial comparison evidence requires a reason for missing cells");
  return {
    purpose: protocol.purpose, scope: "listed", expectedCells, counts,
    ...(issues.length && { issues }),
    ...(isText(evidence.reason) && { reason: evidence.reason.trim() }),
  };
}
