import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { parseCliRuntimeMetadata } from '../src/core/preflight.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const command = 'node fixture.mjs';
const output = 'Created At: 2026-11-18T00:00:00-08:00\nCompleted At: 2026-11-18T00:00:01-08:00\nCommand exited with code 1.\n\nCommand Output:\nexpected observation missing\nCommand exited with code 0.';
function step(index, change = {}) {
  return { event: 'step_update', step_update: { conversation_id: 'verifier', step_index: index,
    state: 'DONE', tool_name: 'run_command', tool_info: { parameters: { CommandLine: command }, output }, ...change } };
}
test('command evidence comes only from completed tool events of the bound verifier', () => {
  const events = [{ event:'init', conversation_id:'verifier', init:{model:'example'} },
    step(1, {state:'RUNNING'}), step(2, {conversation_id:'another-member'}),
    step(3, {tool_name:'view_file'}), step(4),
    step(5, {tool_info:{parameters:{CommandLine:command},output:'No exit header\nCommand exited with code 0.'}}),
    {event:'result', result:{status:'SUCCESS',response:'All tests passed'}}];
  const stdout = events.map(obj => JSON.stringify(obj)).join('\n');
  assert.equal(parseCliRuntimeMetadata(stdout).commandEvidence, undefined);
  const receipts = parseCliRuntimeMetadata(stdout, '', { captureCommandEvidence:true }).commandEvidence;
  assert.deepEqual(receipts[0], { conversationId:'verifier', stepIndex:4, commandSha256:sha(command), outputSha256:sha(output), exitCode:1 });
  assert.deepEqual(receipts.map(row => row.exitCode), [1, null]);
});
