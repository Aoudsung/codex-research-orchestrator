import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeComparisonProtocol, validateComparisonEvidence } from '../src/domain/comparison-evidence.mjs';

const protocol = normalizeComparisonProtocol({
  purpose: 'measurement',
  dimensions: { tier: ['small', 'large'], site: ['indoor'] },
  matchFields: ['split', 'budget'],
  openDimensions: ['tier'],
});

function observation(tier, baseline, candidate) {
  const arm = (name, value) => ({
    settings: { split: 'held-out', budget: 50 },
    evidenceRefs: [`results/${tier}/${name}`], resultRef: `results/${tier}/${name}`, value,
    metric: { name: 'latency', direction: 'lower', unit: 'ms' },
  });
  const controls = arm('baseline', baseline);
  const treatment = arm('candidate', candidate);
  return {
    at: { site: 'indoor', tier }, status: 'observed', baseline: controls, candidate: treatment,
    comparison: { outcome: candidate < baseline ? 'candidate_better' : 'baseline_better',
      evidenceRefs: [controls.resultRef, treatment.resultRef] },
  };
}

function audit(cells, changes = {}, disposition = 'complete', refs) {
  const evidenceRefs = refs ?? cells.flatMap(cell => cell.comparison?.evidenceRefs ?? []);
  return validateComparisonEvidence(protocol, { scope: 'listed', cells, ...changes }, { disposition, evidenceRefs });
}

test('measurement accepts both directions of a fair result and binds each reported outcome to the two measured arms', () => {
  const cells = [observation('small', 12, 8), observation('large', 4, 8)];
  assert.equal(audit(cells).counts.observed, 2);
  const second = cells[1];
  second.comparison.outcome = 'candidate_better';
  assert.throws(() => audit(cells), /outcome|values|direction|comparison/i);
  second.comparison.outcome = 'baseline_better';
  second.candidate.resultRef = second.baseline.resultRef;
  assert.throws(() => audit(cells), /result|evidence|separate/i);
});

test('a mismatched budget, missing result or unmeasured tier cannot support full empirical acceptance', () => {
  const cells = [observation('small', 12, 8), observation('large', 4, 8)];
  const mismatch = structuredClone(cells);
  mismatch[1].baseline.settings.budget = 75;
  assert.throws(() => audit(mismatch), /match|budget/i);
  assert.throws(() => audit(cells, { scope: 'universal' }), /finite|scope/i);
  assert.throws(() => audit(cells, {}, 'complete', cells[0].comparison.evidenceRefs), /reference|receipt|evidence/i);
  assert.throws(() => audit([cells[0]]), /complete|listed/i);
  const partial = audit([cells[0]], { reason: 'The large-tier measurement is still pending.' }, 'partial');
  assert.deepEqual([partial.counts.observed, partial.counts.missing], [1, 1]);
});
