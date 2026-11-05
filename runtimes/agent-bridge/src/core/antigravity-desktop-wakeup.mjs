import {resolveBinary,runCommand} from './process-runner.mjs';

export async function deliverViaAntigravityDesktop({targetSessionId, prompt, notificationId = null, model = null, effort = null}) {
  if (!process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || !process.env.ANTIGRAVITY_AGENTAPI_EXE) throw Error('Antigravity desktop delivery must run inside its app-managed sidecar.');
  if (targetSessionId !== process.env.BRIDGE_DESKTOP_SESSION_ID) throw Error('This Antigravity conversation is not authorized for the sidecar.');
  if (model || effort) throw Error('agentapi uses the existing desktop model. Set the model in the target window; this driver cannot override it.');
  if (!prompt?.trim()) throw Error('A non-empty desktop message is required.');
  const command = resolveBinary('agentapi');
  if (!command) throw Error('The app-managed agentapi command is missing from PATH.');
  try {
    const run = await runCommand({command,args:['send-message',targetSessionId,prompt],timeoutMs:20000});
    if (!run.ok) throw Error((run.error || run.stderr || 'agentapi failed to confirm message acceptance.').slice(0,1500));
    const result = JSON.parse(run.stdout)?.response?.sendMessage;
    if (result?.recipientId !== targetSessionId || result.content !== prompt) throw Error('agentapi receipt does not match the target conversation and message.');
    // agentapi does not expose an idempotency parameter; the driver persists an
    // unconfirmed send before calling it, and never automatically repeats it.
    return {ok:true,delivered:true,driver:'antigravity_desktop',receipt:{accepted:true,targetSessionId,notificationId,evidence:{provider:'antigravity',transport:'agentapi',status:'accepted',sessionId:result.recipientId}}};
  } catch (error) { error.deliveryAttempted = true; throw error; }
}
