const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const paths = {
  overview:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="11" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="18" width="7" height="3" rx="1"/>',
  map:'<circle cx="12" cy="5" r="3"/><circle cx="5" cy="18" r="3"/><circle cx="19" cy="18" r="3"/><path d="m10.5 7.5-4 8m7-8 4 8M8 18h8"/>',
  tasks:'<rect x="5" y="4" width="16" height="17" rx="2"/><path d="M9 4V2m8 2V2M2 8h5m-5 5h5m-5 5h5m4-9h6m-6 5h6"/>',
  evidence:'<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 5 8-5m-8 5V21m-4-16 8 5"/>',
  activity:'<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  refresh:'<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-2L20 8M4 16l2.3 3A7 7 0 0 0 18 17"/>',
  pause:'<path d="M8 5v14M16 5v14"/>',
  play:'<path d="m8 4 12 8-12 8V4Z"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',
  arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>',
  document:'<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z"/><path d="M14 3v6h6M8 13h8m-8 4h6"/>',
  message:'<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5A8.5 8.5 0 0 1 10.5 3h2a8.5 8.5 0 0 1 8.5 8.5Z"/><path d="M7 10h10M7 14h7"/>',
  patch:'<path d="m8 5-6 7 6 7m8-14 6 7-6 7m-3-16-2 18"/>',
  validation:'<path d="m8 12 3 3 5-6"/><path d="M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6l-9-4Z"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  warning:'<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3v.1"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',
  list:'<path d="M8 6h13M8 12h13M8 18h13M3 6h.1M3 12h.1M3 18h.1"/>',
  board:'<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="10" rx="1"/><rect x="17" y="4" width="4" height="13" rx="1"/>',
  link:'<path d="m10 13 4-4m-6 7-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 12a4 4 0 0 0 6 0l5-5a4 4 0 0 0-6-6l-1 1"/>',
  folder:'<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  send:'<path d="m22 2-7 20-4-9-9-4L22 2Zm0 0L11 13"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.document}</svg>`;
const views = {
  overview:['Overview','The research, in motion.','Follow the question, the people, and the evidence they leave behind.'],
  map:['Collaboration map','A shared field of work.','Connections drawn from recorded exchanges. Select a participant to look closer.'],
  tasks:['Tasks','From question to contribution.','Inspect ownership, execution, and handoffs without losing the research context.'],
  evidence:['Evidence','What the research rests on.','Trace claims to their sources, scope, and recorded state.'],
  activity:['Activity','The conversation behind the work.','Messages, artifacts, and validation records in their recorded order.']
};
const state = {snapshot:null, capabilities:null, view:'overview', query:'', agent:'', phase:'', kind:'', recordState:'', taskLayout:'list', items:[], cursor:null, hasMore:false, loading:false, selection:null, detail:null, detailTab:'messages', listVersion:0, detailVersion:0, lastSuccess:null, source:null, sourceVersion:0, pollTimer:null};
const tokenKey = `research-workbench-token:${location.origin}${location.pathname}`;
let token = '';
try { token = sessionStorage.getItem(tokenKey) || ''; } catch { /* Storage can be disabled; the in-memory token still works. */ }
if (location.hash && !views[location.hash.slice(1)]) {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const received = fragment.get('token') || fragment.get('access_token') || (!location.hash.includes('=') ? location.hash.slice(1) : '');
  if (received) { token = received; try { sessionStorage.setItem(tokenKey, token); } catch {} }
  history.replaceState(null, '', location.pathname + location.search);
}
if (views[location.hash.slice(1)]) state.view = location.hash.slice(1);

async function api(path, options = {}) {
  const headers = {Accept:'application/json', Authorization:`Bearer ${token}`, ...options.headers};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try { response = await fetch(path, {...options, headers, ...(options.body !== undefined ? {body:JSON.stringify(options.body)} : {})}); }
  catch { const error = new Error('The local workbench cannot be reached. Check that its server is still running, then refresh.'); error.code = 'network'; throw error; }
  let data;
  try { data = await response.json(); } catch { throw new Error(`The server returned an unreadable response (${response.status}).`); }
  if (!response.ok) { const error = new Error(data.error?.message || `Request failed (${response.status}).`); error.status = response.status; error.code = data.error?.code; error.details = data.error?.details; throw error; }
  return data;
}
const endpoint = (path, params = {}) => { const search = new URLSearchParams(Object.entries(params).filter(([,value]) => value !== '' && value !== undefined && value !== null)); return path + (search.size ? '?' + search : ''); };
const count = value => value === null || value === undefined ? '—' : Number(value).toLocaleString();
const label = value => value ? String(value).replace(/[-_]/g,' ').replace(/^\w/,char=>char.toUpperCase()) : 'Unknown';
const absoluteDate = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('en', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',year:'numeric'}) : 'Time not recorded';
function relativeDate(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Not recorded';
  const difference = Date.now() - Date.parse(value);
  if (difference < -60000) return absoluteDate(value);
  const minutes = Math.max(0, Math.floor(difference / 60000));
  if (minutes < 1) return 'Just recorded';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return new Date(value).toLocaleDateString('en', {month:'short',day:'numeric'});
}
const time = value => `<time datetime="${esc(value || '')}" title="${esc(absoluteDate(value))}">${esc(relativeDate(value))}</time>`;
function tone(value) {
  if (/revision|failed|error|rejected|urgent/i.test(value || '')) return 'rose';
  if (/review|pending|held|paused|queued|blocked|requested|awaiting|high/i.test(value || '')) return 'amber';
  if (/active|running|progress|dispatch/i.test(value || '')) return 'blue';
  if (/complete|succeeded|ready|current|passed|supported/i.test(value || '')) return 'teal';
  return '';
}
const badge = (value, text = label(value)) => `<span class="badge ${tone(value)}">${esc(text)}</span>`;
const taskPhase = task => task.phaseLabel || label(task.phase || task.status);
const person = id => { const name = state.snapshot?.participants?.find(item => item.id === id)?.label || id; return ({codex:'Codex','claude-code':'Claude Code',antigravity:'Antigravity'})[name] || label(name); };
const personTone = id => id === 'claude-code' ? 'teal' : id === 'antigravity' ? 'rose' : '';
const initials = id => (person(id).split(/[\s-]+/).map(word=>word[0]).join('').slice(0,2) || '?').toUpperCase();
const avatar = (id, large = false) => `<span class="avatar ${personTone(id)} ${large ? 'large' : ''}" aria-hidden="true">${esc(initials(id))}</span>`;
const taskButton = (id, text, cls = 'text-button') => `<button class="${cls}" data-action="task" data-id="${esc(id)}">${esc(text)}</button>`;
const sourceButton = (kind, id, text = 'Read original', title = '', field = '') => `<button class="text-button" data-action="source" data-kind="${esc(kind)}" data-id="${esc(id)}" data-title="${esc(title)}" data-field="${esc(field)}">${esc(text)}</button>`;
function errorMarkup(error, retry = 'refresh') {
  const access = error.status === 401 || error.status === 403;
  return `<div class="empty-state error-state"><span class="empty-icon">${icon(access ? 'validation' : 'warning')}</span><h2>${access ? 'Access needs your attention' : 'Records could not be loaded'}</h2><p>${esc(error.message)}</p><button class="button quiet" data-action="${access ? 'access' : retry}">${access ? 'Update access token' : 'Try again'}</button></div>`;
}
function emptyMarkup(title, description, action, actionLabel, symbol = 'folder') {
  return `<div class="empty-state"><span class="empty-icon">${icon(symbol)}</span><h2>${esc(title)}</h2><p>${esc(description)}</p>${action ? `<button class="button quiet" data-action="${action}">${esc(actionLabel)}</button>` : ''}</div>`;
}
function notice(message, error = false) { $('#notice').hidden = !message; $('#notice').classList.toggle('error', error); $('#notice').innerHTML = message ? `<span>${esc(message)}</span><button class="text-button" data-action="refresh">Refresh</button>` : ''; }
let toastTimer;
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false; toastTimer = setTimeout(()=>$('#toast').hidden=true, 5500); }
function updateFreshness() {
  const element = $('#freshness');
  if (!state.lastSuccess) return;
  const stale = Date.now() - state.lastSuccess > 90000;
  element.classList.toggle('stale', stale);
  element.textContent = stale ? 'Records may be stale' : `Read ${relativeDate(new Date(state.lastSuccess).toISOString()).toLowerCase()}`;
  element.title = `Snapshot observed: ${absoluteDate(state.snapshot?.observedAt)}. Last successful read: ${absoluteDate(new Date(state.lastSuccess).toISOString())}.`;
}
function renderNavigation() {
  $('#navigation').innerHTML = Object.entries(views).map(([key,[title]])=>`<a href="#${key}" aria-label="${esc(title)}" title="${esc(title)}" class="nav-item ${state.view === key ? 'active' : ''}" ${state.view === key ? 'aria-current="page"' : ''}>${icon(key)}<span>${title}</span>${key === 'tasks' && state.snapshot ? `<span class="nav-count">${count(state.snapshot.totals?.tasks)}</span>` : ''}</a>`).join('');
  const [name,title,description] = views[state.view];
  $('#view-breadcrumb').textContent = name; $('#view-title').textContent = title; $('#view-description').textContent = description;
  $('#phase-filter').closest('label').hidden = !['overview','tasks'].includes(state.view);
  $('#agent-filter').closest('label').hidden = state.view === 'evidence';
  $('#search').placeholder = state.view === 'map' ? 'Find a participant or role' : state.view === 'activity' ? 'Search loaded activity' : 'Search tasks and evidence';
  $('#clear-filters').hidden = !(state.query || state.agent || state.phase || state.kind || state.recordState);
}
function renderProject() {
  const snapshot = state.snapshot;
  $('#project-name').textContent = snapshot.project?.name || 'Unnamed project';
  $('#project-path').textContent = snapshot.project?.path || 'Project path not recorded';
  document.title = `${snapshot.project?.name || 'Research'} · Workbench`;
  $('#demo-banner').hidden = snapshot.mode !== 'demo';
  $('#demo-banner').innerHTML = '<strong>Fictional demo</strong><span>Explore a synthetic research workspace. Actions stay in memory and never contact providers.</span>';
  const control = $('#control-button');
  control.disabled = !state.capabilities?.controlsAvailable;
  control.innerHTML = `${icon(snapshot.control?.paused ? 'play' : 'pause')}${snapshot.control?.paused === true ? 'Resume new work' : snapshot.control?.paused === false ? 'Pause new work' : 'Execution control'}`;
  control.title = state.capabilities?.controlsAvailable ? 'Manage bridge-wide execution admission' : 'Execution controls are unavailable for this workspace';
  const agentFilter = $('#agent-filter');
  agentFilter.innerHTML = '<option value="">All participants</option>' + (snapshot.participants || []).map(item=>`<option value="${esc(item.id)}">${esc(person(item.id))}</option>`).join(''); agentFilter.value = state.agent;
  const phases = [...new Map((snapshot.recentTasks || []).map(task=>[task.phase || task.status || 'unknown',taskPhase(task)])).entries()];
  if (state.phase && !phases.some(([value])=>value === state.phase)) phases.push([state.phase,label(state.phase)]);
  $('#phase-filter').innerHTML = '<option value="">All task phases</option>'+phases.map(([value,text])=>`<option value="${esc(value)}">${esc(text)}</option>`).join(''); $('#phase-filter').value = state.phase;
  renderNavigation(); updateFreshness();
}
async function refresh() {
  $('#refresh-button').disabled = true;
  try {
    const [snapshotResult, capabilityResult] = await Promise.allSettled([api('/api/snapshot'),api('/api/capabilities')]);
    if (snapshotResult.status === 'rejected') throw snapshotResult.reason;
    state.snapshot = snapshotResult.value; state.lastSuccess = Date.now();
    state.capabilities = capabilityResult.status === 'fulfilled' ? capabilityResult.value : null;
    renderProject(); notice(capabilityResult.status === 'rejected' ? `Records loaded. Execution capabilities could not be read: ${capabilityResult.reason.message}` : '');
    await loadView();
    if (state.selection?.type === 'task') await selectTask(state.selection.id, false);
    else if (state.selection?.type === 'participant') renderParticipantInspector(state.selection.id);
    else if (!state.selection) renderDefaultInspector();
  } catch (error) {
    if (state.snapshot) notice(`${error.message} Showing the last successful snapshot.`, true);
    else { $('#content').innerHTML = errorMarkup(error); renderDefaultInspector(); }
  } finally { $('#refresh-button').disabled = false; }
}
function taskMatches(task) {
  const query = state.query.toLowerCase();
  return (!query || [task.id,task.title,task.promptPreview,task.assignedTo,task.role].some(value=>String(value || '').toLowerCase().includes(query))) && (!state.agent || task.assignedTo === state.agent || task.fromAgent === state.agent) && (!state.phase || (task.phase || task.status || 'unknown') === state.phase);
}
function evidenceMatches(item) { const query = state.query.toLowerCase(); return !query || [item.title,item.summary,item.kind,item.source,item.scope].some(value=>String(value || '').toLowerCase().includes(query)); }
function filteredActivity(items) {
  return items.filter(item=>(!state.kind || item.kind === state.kind) && (!state.agent || item.actor === state.agent || item.recipient === state.agent) && (!state.query || [item.title,item.preview,item.actor,item.recipient,item.taskId].some(value=>String(value || '').toLowerCase().includes(state.query.toLowerCase()))));
}
async function loadView(append = false) {
  renderNavigation();
  if (!state.snapshot) return;
  const version = ++state.listVersion;
  if (['overview','map'].includes(state.view)) { state.items = []; renderView(); return; }
  state.loading = true;
  if (!append) $('#content').innerHTML = '<div class="initial-loading"><span class="loading-orbit"></span><p>Reading project records…</p></div>';
  else { const button = $('[data-action="load-more"]'); if (button) { button.disabled = true; button.textContent = 'Loading records…'; } }
  try {
    let url;
    const pagination = {cursor:append ? state.cursor : undefined,limit:30};
    if (state.view === 'tasks') url = endpoint('/api/tasks',{...pagination,query:state.query,agent:state.agent,phase:state.phase});
    if (state.view === 'evidence') url = endpoint('/api/evidence',{...pagination,query:state.query,kind:state.kind,state:state.recordState});
    if (state.view === 'activity') url = endpoint('/api/activity',{...pagination,kind:state.kind});
    const result = await api(url);
    if (version !== state.listVersion) return;
    state.items = append ? [...state.items,...result.items] : result.items;
    state.cursor = result.nextCursor; state.hasMore = result.hasMore;
    renderView();
  } catch (error) {
    if (version !== state.listVersion) return;
    if (append) { toast(error.message); const button = $('[data-action="load-more"]'); if (button) { button.disabled = false; button.textContent = 'Load more records'; } }
    else $('#content').innerHTML = errorMarkup(error,'reload-view');
  } finally { if (version === state.listVersion) state.loading = false; }
}
function renderView() {
  if (state.view === 'overview') renderOverview();
  if (state.view === 'map') renderMap();
  if (state.view === 'tasks') renderTasks();
  if (state.view === 'evidence') renderEvidence();
  if (state.view === 'activity') renderActivity();
}
function graph(large = false) {
  const snapshot = state.snapshot;
  const participants = (snapshot.participants || []).filter(item=>(!state.agent || item.id === state.agent) && (!state.query || [item.label,...(item.roles || [])].some(value=>String(value).toLowerCase().includes(state.query.toLowerCase()))));
  if (!participants.length && snapshot.sources?.bridge?.status !== 'ready') return emptyMarkup('Collaboration records unavailable', snapshot.sources?.bridge?.detail || 'Inspect the bridge source to understand why collaboration records cannot be read.', 'project', 'Inspect project sources', 'map');
  if (!participants.length) return emptyMarkup('No recorded connections yet','Connections appear when tasks and messages name their participants. Adjust the filters or create the first task.','clear','Clear filters','map');
  const width = 650, height = large ? 420 : 340;
  const nodes = participants.map((participant,index)=>{
    const angle = -Math.PI / 2 + index * (2 * Math.PI / participants.length);
    const radiusX = participants.length === 1 ? 0 : participants.length === 2 ? 155 : 200;
    const radiusY = participants.length < 3 ? 0 : participants.length === 3 ? (large ? 110 : 70) : (large ? 120 : 92);
    const centerY = participants.length === 3 ? height/2 + 20 : height/2 - 25;
    return {...participant,x:width/2 + Math.cos(angle + (participants.length === 2 ? Math.PI/2 : 0))*radiusX,y:centerY + Math.sin(angle + (participants.length === 2 ? Math.PI/2 : 0))*radiusY};
  });
  const nodeMap = new Map(nodes.map(node=>[node.id,node]));
  const edges = (snapshot.exchanges || []).filter(edge=>nodeMap.has(edge.from) && nodeMap.has(edge.to));
  const edgeMarkup = edges.map(edge=>{
    const from = nodeMap.get(edge.from), to = nodeMap.get(edge.to);
    const selected = state.selection?.type === 'participant' && [edge.from,edge.to].includes(state.selection.id);
    if (from.id === to.id) return `<g><path class="map-edge" d="M${from.x-25},${from.y-24} C${from.x-90},${from.y-115} ${from.x+90},${from.y-115} ${from.x+25},${from.y-24}"/><text class="edge-count" x="${from.x}" y="${from.y-91}" text-anchor="middle">${count(edge.count)}</text></g>`;
    const dx=to.x-from.x,dy=to.y-from.y,length=Math.hypot(dx,dy), ux=dx/length,uy=dy/length;
    const startX=from.x+ux*38,startY=from.y+uy*38,endX=to.x-ux*42,endY=to.y-uy*42;
    const curve = edges.some(other=>other.from===edge.to && other.to===edge.from) ? 18 : 0;
    const middleX=(startX+endX)/2-uy*curve,middleY=(startY+endY)/2+ux*curve;
    return `<g><title>${esc(person(edge.from))} to ${esc(person(edge.to))}: ${esc(count(edge.count))} recorded messages</title><path class="map-edge ${selected?'active':''}" d="M${startX},${startY} Q${middleX},${middleY} ${endX},${endY}" marker-end="url(#edge-arrow)"/><text class="edge-count" x="${middleX}" y="${middleY-7}" text-anchor="middle">${count(edge.count)}</text></g>`;
  }).join('');
  const nodeMarkup=nodes.map((node,index)=>`<g class="graph-node ${personTone(node.id)} ${state.selection?.type==='participant'&&state.selection.id===node.id?'selected':''}" role="button" tabindex="0" data-action="participant" data-id="${esc(node.id)}" aria-label="Inspect ${esc(node.label)}, ${esc(count(node.taskCount))} recorded tasks" transform="translate(${node.x},${node.y})"><circle class="node-halo" r="42"/><circle class="node-disc" r="32"/><text class="node-glyph" y="7">${esc(initials(node.id))}</text><text class="node-label" y="${nodes.length===3&&index===0?-89:61}">${esc(person(node.id))}</text><text class="node-role" y="${nodes.length===3&&index===0?-71:77}">${esc((node.roles || []).slice(0,2).map(label).join(' / ') || 'Role not recorded')}</text><text class="node-record" y="${nodes.length===3&&index===0?-55:92}">${count(node.taskCount)} tasks · ${count(node.activeTaskCount)} open tasks</text></g>`).join('');
  const compact = `<div class="compact-collaboration" aria-label="Recorded participants and directed messages">
    <div class="compact-participants">${participants.map(participant=>`<button class="compact-participant ${state.selection?.type==='participant'&&state.selection.id===participant.id?'selected':''}" data-action="participant" data-id="${esc(participant.id)}" aria-label="Inspect ${esc(person(participant.id))}">${avatar(participant.id,true)}<span class="compact-participant-copy"><strong>${esc(person(participant.id))}</strong><span>${esc((participant.roles||[]).map(label).join(' / ')||'Role not recorded')}</span><small>${count(participant.taskCount)} recorded tasks · ${count(participant.activeTaskCount)} open tasks</small></span>${icon('info')}</button>`).join('')}</div>
    <section class="compact-exchanges"><h3>Directed messages</h3>${edges.length?edges.map(edge=>`<div class="compact-exchange" aria-label="${esc(person(edge.from))} to ${esc(person(edge.to))}: ${esc(count(edge.count))} recorded messages"><button data-action="participant" data-id="${esc(edge.from)}" aria-label="Inspect sender ${esc(person(edge.from))}">${esc(person(edge.from))}</button><span class="compact-direction">${icon('arrow')}</span><button data-action="participant" data-id="${esc(edge.to)}" aria-label="Inspect recipient ${esc(person(edge.to))}">${esc(person(edge.to))}</button><span class="compact-exchange-count"><strong>${count(edge.count)}</strong><small>${edge.count===1?'message':'messages'}</small></span></div>`).join(''):'<p class="hint">No recorded messages between the selected participants.</p>'}</section>
  </div>`;
  return `<div class="desktop-collaboration"><svg class="collaboration-graph ${large?'large':''}" viewBox="0 0 ${width} ${height}" role="group" aria-label="Recorded collaboration graph"><defs><marker id="edge-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="m0 1 8 4-8 4" fill="none" stroke="#8099bd" stroke-width="1.5"/></marker></defs>${edgeMarkup}${nodeMarkup}</svg></div>${compact}`;
}
function mapPanel(large = false) {
  const exchanges = state.snapshot.exchanges || [];
  const exchangeCount = state.snapshot.sources?.bridge?.status === 'ready' ? exchanges.reduce((sum,item)=>sum+(item.count || 0),0) : null;
  return `<section class="map-panel"><div class="map-header"><div><h2>Collaboration field</h2><p>Who is working together, and where the conversation flows.</p></div><div class="map-key"><span><i></i> Recorded message</span><span><i class="dot"></i> Participant</span></div></div>${graph(large)}<div class="map-footer"><span>${icon('info')} Arrows show direction; labels count recorded messages.</span><button class="text-button inspector-default-trigger" data-action="project">Project context</button><span>${count(exchangeCount)} recorded exchanges</span></div></section>`;
}
function miniTask(task) {
  return `<button class="task-mini" data-action="task" data-id="${esc(task.id)}"><span class="task-state-icon ${tone(task.phase||task.status)}">${icon(task.status==='completed'?'check':'tasks')}</span><div class="task-mini-content"><h3>${esc(task.title || 'Untitled task')}</h3><div class="mini-meta">${avatar(task.assignedTo)}<span>${esc(person(task.assignedTo))}</span>${badge(task.phase || task.status,taskPhase(task))}</div></div></button>`;
}
function miniEvidence(item) {
  return `<button class="evidence-mini" data-action="evidence" data-id="${esc(item.id)}"><span class="evidence-symbol">${icon('evidence')}</span><div class="evidence-mini-content"><h3>${esc(item.title)}</h3><p>${esc(label(item.kind))} · ${esc(label(item.claimStatus || item.recordState))}</p></div></button>`;
}
function renderOverview() {
  const snapshot=state.snapshot, totals=snapshot.totals || {};
  const tasks=(snapshot.recentTasks || []).filter(taskMatches).slice(0,4), evidence=(snapshot.recentEvidence || []).filter(evidenceMatches).slice(0,4), events=filteredActivity(snapshot.recentActivity || []).slice(0,3);
  $('#content').innerHTML = `<section class="summary-strip" aria-label="Workspace record totals">${[['tasks','tasks','Tasks','Recorded assignments'],['message','messages','Messages','Recorded exchanges'],['patch','patches','Artifacts','Submitted patches'],['evidence','memoryRecords','Evidence','Memory records']].map(([symbol,key,title,subtitle])=>`<div class="summary-item"><span class="metric-label">${icon(symbol)}${title}</span><div class="metric-detail"><strong title="${totals[key]==null?'Source unavailable':`${totals[key]} records`}">${count(totals[key])}</strong></div><small>${subtitle}</small></div>`).join('')}</section>${mapPanel()}<div class="overview-columns"><section><div class="section-heading"><div><h2>Work in focus <span class="section-number">${tasks.length}</span></h2><p>Recent task records${snapshot.truncated?.tasks?' · snapshot is bounded':''}</p></div><a class="text-button" href="#tasks">All tasks</a></div>${tasks.length?tasks.map(miniTask).join(''):'<p class="hint">No matching recent tasks. Open all tasks to search the full record.</p>'}</section><section><div class="section-heading"><div><h2>Research evidence</h2><p>Claims with context, not automatic acceptance</p></div><a class="text-button" href="#evidence">All evidence</a></div>${evidence.length?evidence.map(miniEvidence).join(''):'<p class="hint">No matching recent memory records. Inspect source availability in project context.</p>'}</section></div><section class="activity-preview"><div class="section-heading"><h2>Latest exchanges</h2><a class="text-button" href="#activity">Full activity</a></div>${events.length?events.map(event=>`<button class="activity-line" data-action="event" data-id="${esc(event.id)}" data-kind="${esc(event.kind)}" data-task="${esc(event.taskId)}"><span class="activity-icon">${icon(event.kind)}</span><div class="activity-copy"><h3>${esc(event.title || label(event.kind))}</h3><p>${esc(person(event.actor))}${event.recipient?` to ${esc(person(event.recipient))}`:''} · ${esc(event.taskId || 'Unlinked record')}</p></div>${time(event.createdAt)}</button>`).join(''):'<p class="hint">No matching activity in the latest snapshot.</p>'}</section>`;
}
function renderMap() {
  const participants=state.snapshot.participants || [];
  $('#content').innerHTML = `${mapPanel(true)}<div class="participant-grid">${participants.filter(item=>(!state.agent||item.id===state.agent)&&(!state.query||[item.label,...(item.roles||[])].some(value=>String(value).toLowerCase().includes(state.query.toLowerCase())))).map(item=>`<button class="participant-card" data-action="participant" data-id="${esc(item.id)}">${avatar(item.id,true)}<h3>${esc(person(item.id))}</h3><p>${esc((item.roles||[]).map(label).join(', ') || 'Role not recorded')}</p><p>Last recorded ${esc(relativeDate(item.lastRecordedAt).toLowerCase())}</p><div class="participant-stats"><span>${count(item.taskCount)} tasks</span><span>${count(item.activeTaskCount)} open tasks</span></div></button>`).join('')}</div><div class="model-note">Participant identity comes from project records. Requested and reported models are shown separately in task details. A recent timestamp does not establish that a session is online.</div><section class="connection-list"><div class="section-heading"><h2>Recorded routes of conversation</h2></div>${(state.snapshot.exchanges || []).filter(edge=>!state.agent||edge.from===state.agent||edge.to===state.agent).map(edge=>`<div class="connection-row">${avatar(edge.from)}<span>${esc(person(edge.from))}</span>${icon('arrow')}${avatar(edge.to)}<span>${esc(person(edge.to))}</span><span class="connection-count">${count(edge.count)} messages</span></div>`).join('') || '<p class="hint">No recorded exchanges for this selection.</p>'}</section>`;
}
function pagination() { return state.hasMore ? '<div class="pagination"><button class="button quiet" data-action="load-more">Load more records</button><p class="hint">Additional records are fetched from the selected project.</p></div>' : ''; }
function renderTasks() {
  const tasks=state.items;
  let body;
  if (!tasks.length) body=emptyMarkup('A question starts the work',state.query||state.agent||state.phase?'No tasks match these filters. Clear the filters to see the workspace.':'Create a task with a clear question, an owner, and an explicit scope. Dispatch is a separate action.',state.query||state.agent||state.phase?'clear':'create',state.query||state.agent||state.phase?'Clear filters':'Create task','tasks');
  else if (state.taskLayout==='list') body=`<div class="task-table"><table><thead><tr><th scope="col">Task</th><th scope="col">Owner</th><th scope="col">Phase</th><th scope="col">Updated</th></tr></thead><tbody>${tasks.map(task=>`<tr class="${state.selection?.id===task.id?'selected':''}" data-task-row="${esc(task.id)}"><td><button class="task-title-button" data-action="task" data-id="${esc(task.id)}">${esc(task.title || 'Untitled task')}</button><div class="task-id">${esc(task.id)}${task.role?` / ${esc(label(task.role))}`:''}</div></td><td><div class="participant-cell">${avatar(task.assignedTo)}<span>${esc(person(task.assignedTo))}</span></div></td><td>${badge(task.phase||task.status,taskPhase(task))}</td><td class="task-date">${time(task.updatedAt)}</td></tr>`).join('')}</tbody></table></div>`;
  else {
    const phases=[...new Set(tasks.map(task=>task.phase || task.status || 'unknown'))];
    body=`<div class="kanban" aria-label="Task board, grouped by recorded phase">${phases.map(phase=>`<section class="kanban-column"><h3>${esc(tasks.find(task=>(task.phase||task.status||'unknown')===phase)?.phaseLabel||label(phase))}<span>${tasks.filter(task=>(task.phase||task.status||'unknown')===phase).length}</span></h3>${tasks.filter(task=>(task.phase||task.status||'unknown')===phase).map(task=>`<button class="kanban-card ${state.selection?.id===task.id?'selected':''}" data-action="task" data-id="${esc(task.id)}">${badge(task.priority,label(task.priority)+' priority')}<h4>${esc(task.title)}</h4><div class="card-bottom">${avatar(task.assignedTo)}<span>${esc(task.id)}</span></div></button>`).join('')}</section>`).join('')}</div>`;
  }
  $('#content').innerHTML=`<div class="toolbar"><p>${count(tasks.length)} loaded task records${state.hasMore?' · more available':''}</p><div class="segmented" role="group" aria-label="Task layout"><button data-action="layout" data-layout="list" class="${state.taskLayout==='list'?'active':''}" aria-pressed="${state.taskLayout==='list'}">${icon('list')}List</button><button data-action="layout" data-layout="board" class="${state.taskLayout==='board'?'active':''}" aria-pressed="${state.taskLayout==='board'}">${icon('board')}Board</button></div></div>${body}${pagination()}<p class="hint">Task completion records execution state. Scientific acceptance requires the corresponding evidence and review.</p>`;
}
function renderEvidence() {
  const kinds=[...new Set(state.items.map(item=>item.kind).filter(Boolean))];
  const items=state.items;
  $('#content').innerHTML=`<div class="toolbar"><p>${count(items.length)} loaded memory records</p><label class="select-field"><span class="sr-only">Filter by evidence record state</span><select id="evidence-state"><option value="">All record states</option>${[...new Set(['current','needs_review','withdrawn','superseded',...items.map(item=>item.recordState).filter(Boolean),state.recordState].filter(Boolean))].map(value=>`<option value="${esc(value)}" ${state.recordState===value?'selected':''}>${esc(label(value))}</option>`).join('')}</select></label></div><div class="view-filters" role="group" aria-label="Evidence kind"><button class="filter-chip ${!state.kind?'active':''}" data-action="kind" data-kind="" aria-pressed="${!state.kind}">All kinds</button>${[...new Set([...kinds,state.kind].filter(Boolean))].map(kind=>`<button class="filter-chip ${state.kind===kind?'active':''}" data-action="kind" data-kind="${esc(kind)}" aria-pressed="${state.kind===kind}">${esc(label(kind))}</button>`).join('')}</div>${items.length?`<div class="evidence-grid">${items.map(item=>`<button class="evidence-card ${String(state.selection?.id)===String(item.id)?'selected':''}" data-action="evidence" data-id="${esc(item.id)}"><div class="evidence-card-top"><span class="evidence-kind">${icon('evidence')}${esc(label(item.kind))}</span>${badge(item.claimStatus || item.recordState)}</div><h3>${esc(item.title)}</h3><p>${esc(item.summary || 'No summary recorded.')}</p><footer><span>${esc(label(item.recordState))} record</span>${time(item.updatedAt)}</footer></button>`).join('')}</div>`:emptyMarkup('No evidence records here',state.query||state.kind||state.recordState?'No memory records match these filters.':'Initialize research memory using the project’s memory workflow, then refresh. Check project sources for missing or unreadable records.',state.query||state.kind||state.recordState?'clear':'project',state.query||state.kind||state.recordState?'Clear filters':'Inspect project sources','evidence')}${pagination()}<p class="hint">A current record describes its place in memory. It does not, by itself, verify the claim.</p>`;
}
function renderActivity() {
  const events=filteredActivity(state.items);
  $('#content').innerHTML=`<div class="toolbar"><p>${count(events.length)} matching / ${count(state.items.length)} loaded observations</p></div><div class="view-filters" role="group" aria-label="Activity kind">${[['','All activity'],['message','Messages'],['patch','Artifacts'],['validation','Validations']].map(([kind,title])=>`<button class="filter-chip ${state.kind===kind?'active':''}" data-action="kind" data-kind="${kind}" aria-pressed="${state.kind===kind}">${title}</button>`).join('')}</div>${events.length?`<div class="activity-feed">${events.map(event=>`<article class="feed-event"><span class="activity-icon">${icon(event.kind)}</span><div><div class="feed-top"><span>${esc(person(event.actor))}${event.recipient?` to ${esc(person(event.recipient))}`:''} · ${esc(label(event.kind))}</span>${time(event.createdAt)}</div><h3>${esc(event.title || label(event.kind))}</h3><p>${esc(event.preview || 'No preview recorded.')}</p><div class="record-actions">${event.taskId?taskButton(event.taskId,'Inspect task'):''}${event.kind==='message'||event.kind==='patch'?sourceButton(event.kind,event.id,'Read original',event.title):''}</div></div></article>`).join('')}</div>`:emptyMarkup('No matching observations',state.items.length?'Search applies to loaded activity. Load more records or clear the filters.':'Recorded messages, artifacts, and validations will appear here.','clear','Clear filters','activity')}${pagination()}`;
}
const inspectorHeader = title => `<div class="inspector-top"><span class="small-label">${icon('info')}${esc(title)}</span><button class="icon-button inspector-mobile-close" data-action="close-inspector" aria-label="Close inspector">${icon('close')}</button>${state.selection?'<button class="text-button" data-action="project">Project</button>':''}</div>`;
function renderDefaultInspector() {
  const snapshot=state.snapshot;
  $('#inspector').innerHTML=inspectorHeader('Project context')+(snapshot?`<div class="question-block"><span class="small-label">The question</span><h2>${esc(snapshot.project?.question || 'A research question has not been recorded.')}</h2><p class="question-source">${esc(snapshot.project?.questionSource || 'Question source not recorded')}</p></div>${snapshot.project?.currentStatePreview?`<p class="description">${esc(snapshot.project.currentStatePreview)}</p>`:''}<section class="inspector-section"><h3>Record sources</h3>${Object.entries(snapshot.sources || {}).map(([name,source])=>`<div class="source-row"><span class="source-icon">${icon(name==='memory'?'evidence':name==='bridge'?'map':'folder')}</span><div class="source-name">${esc(label(name))}<small title="${esc(source.path||source.detail||'')}">${esc(source.detail || source.path || 'Path not recorded')}</small></div><span class="source-status ${esc(source.status)}">${esc(label(source.status))}</span></div>`).join('')}<p class="hint">Unavailable sources are shown as unknown counts, never as zero records.</p></section><section class="inspector-section"><h3>Project documents</h3>${(snapshot.documents||[]).map(doc=>`<button class="document-link" data-action="source" data-kind="document" data-id="${esc(doc.id)}" data-title="${esc(doc.title)}" ${doc.exists===false?'disabled':''}>${icon('document')}<span>${esc(doc.title)}<small class="block-small">${esc(doc.path||'')}</small></span><small>${doc.exists===false?'Missing':doc.exists===null?'Unknown':'View'}</small></button>`).join('') || '<p class="empty-inline">No declared documents are available.</p>'}</section><section class="inspector-section"><h3>Execution admission</h3>${badge(snapshot.control?.paused===true?'paused':snapshot.control?.paused===false?'ready':'unknown',snapshot.control?.paused===true?'Paused':snapshot.control?.paused===false?'Accepting new execution':'Control state unknown')}<p class="hint">${snapshot.control?.paused?'New execution and automatic continuation are held. Already admitted calls may finish.':'Dispatch remains an explicit action. Reads and task creation do not start a provider.'}</p>${snapshot.control?.reason?`<p class="hint">Reason: ${esc(snapshot.control.reason)}</p>`:''}<p class="hint">${count(snapshot.control?.activeOperations)} operations tracked by this workbench server. Other clients may have active calls.</p></section>`:'<p class="description">The selected project’s question and source availability will appear here once access is established.</p>');
}
function showInspector() { $('#inspector').classList.add('is-open'); $('#inspector').focus({preventScroll:true}); }
function projectInspector() { state.selection=null; state.detail=null; ++state.detailVersion; clearTimeout(state.pollTimer); renderDefaultInspector(); showInspector(); if(state.snapshot)renderView(); }
function renderParticipantInspector(id) {
  const participant=state.snapshot.participants.find(item=>item.id===id);
  if (!participant) return;
  const tasks=(state.snapshot.recentTasks||[]).filter(task=>task.assignedTo===id||task.fromAgent===id);
  $('#inspector').innerHTML=inspectorHeader('Participant record')+`${avatar(id,true)}<h2>${esc(person(id))}</h2><p class="description">${esc((participant.roles||[]).map(label).join(', ')||'No explicit role recorded.')}</p><dl class="detail-meta"><dt>Recorded tasks</dt><dd>${count(participant.taskCount)}</dd><dt>Open tasks</dt><dd>${count(participant.activeTaskCount)}</dd><dt>Last recorded</dt><dd>${esc(absoluteDate(participant.lastRecordedAt))}</dd></dl><div class="model-pair"><div><span>Requested models</span><strong>${esc((participant.requiredModels||[]).join(', ')||'Not recorded')}</strong></div><div><span>Reported models</span><strong>${esc((participant.reportedModels||[]).join(', ')||'Not recorded')}</strong></div><p class="hint">These are recorded identities, not a live model or authentication check.</p></div><div class="inspector-actions"><button class="button quiet small" data-action="participant-tasks" data-id="${esc(id)}">View participant tasks</button></div><section class="inspector-section"><h3>Recent associated work</h3>${tasks.slice(0,5).map(miniTask).join('')||'<p class="empty-inline">No associated tasks in the bounded snapshot.</p>'}</section><p class="hint">Last recorded activity is not an online heartbeat.</p>`;
}
async function selectTask(id, open = true) {
  const version=++state.detailVersion; clearTimeout(state.pollTimer);
  const same=state.selection?.type==='task'&&state.selection.id===id;
  state.selection={type:'task',id}; if(!same)state.detailTab='messages';
  if(open)showInspector();
  $('#inspector').innerHTML=inspectorHeader('Task record')+'<div class="loading-inline">Reading task, messages, and artifacts…</div>';
  try { const detail=await api('/api/tasks/'+encodeURIComponent(id)); if(version!==state.detailVersion)return; state.detail=detail; renderTaskInspector(); if(detail.operation&&['pending','running'].includes(detail.operation.state))pollOperation(detail.operation.id,id); }
  catch(error){if(version===state.detailVersion)$('#inspector').innerHTML=inspectorHeader('Task record')+`<div class="inline-error">${esc(error.message)}</div><button class="text-button" data-action="task" data-id="${esc(id)}">Try again</button>`;}
  if(state.snapshot)renderView();
}
function renderTaskInspector() {
  const detail=state.detail, task=detail.task;
  const dispatchDisabled=state.snapshot?.control?.paused===true||!state.capabilities?.dispatchAvailable||!task.requiredModel||['running','pending'].includes(detail.operation?.state);
  const groups={messages:detail.messages||[],patches:detail.patches||[],validations:detail.validations||[]};
  $('#inspector').innerHTML=inspectorHeader('Task record')+`<span class="small-label">${esc(task.id)}</span><h2>${esc(task.title||'Untitled task')}</h2><div class="space-top-12">${badge(task.phase||task.status,taskPhase(task))}</div><p class="description">${esc(task.promptPreview || 'No prompt preview recorded.')}</p><div class="record-actions">${sourceButton('task',task.id,'Read full task brief',task.title,'prompt')}</div><div class="inspector-actions"><button class="button primary small" data-action="compose-message" data-id="${esc(task.id)}">${icon('message')}Send message</button><button class="button quiet small" data-action="dispatch" data-id="${esc(task.id)}" ${dispatchDisabled?'disabled':''} title="${state.snapshot?.control?.paused?'Resume new work before dispatching':!task.requiredModel?'An explicit requested model is required':!state.capabilities?.dispatchAvailable?'Dispatch is unavailable':'Review explicit dispatch settings'}">${icon('play')}Dispatch</button></div><dl class="detail-meta"><dt>Owner</dt><dd>${esc(person(task.assignedTo))}</dd><dt>From</dt><dd>${esc(person(task.fromAgent))}</dd><dt>Role</dt><dd>${esc(label(task.role))}</dd><dt>Task status</dt><dd>${esc(label(task.status))}</dd><dt>Updated</dt><dd>${esc(absoluteDate(task.updatedAt))}</dd><dt>Delivery version</dt><dd>${esc(task.deliveryVersion??'Not recorded')}</dd></dl><div class="model-pair"><div><span>Requested model</span><strong>${esc(task.requiredModel || 'Not recorded')}</strong></div><div><span>Reported model</span><strong>${esc(task.actualModel || 'Not recorded')}</strong></div><div><span>Model source</span><strong>${esc(label(task.modelSource))}</strong></div><p class="hint">${task.modelSource==='simulated'?'Synthetic demo identity. No model was executed.':'Reported identity is a record, not independent verification.'}</p></div>${!task.requiredModel?'<div class="scope-note space-top-16"><p>This record has no model binding. Create a separate bound task to dispatch this work.</p><button class="text-button" data-action="bind-followup">Create task with a model</button></div>':''}${detail.operation?operationMarkup(detail.operation):''}${task.errorPreview?`<div class="inline-error space-top-16">${esc(task.errorPreview)}<div>${sourceButton('task',task.id,'Read full error',task.title,'error')}</div></div>`:''}<div class="inspector-tabs" role="tablist" aria-label="Task record sections">${[['messages','Messages'],['patches','Artifacts'],['validations','Checks'],['scope','Scope']].map(([key,title])=>`<button role="tab" id="tab-${key}" aria-controls="task-detail-panel" aria-selected="${state.detailTab===key}" tabindex="${state.detailTab===key?'0':'-1'}" class="${state.detailTab===key?'active':''}" data-action="detail-tab" data-tab="${key}">${title}${groups[key]?` ${groups[key].length}`:''}</button>`).join('')}</div><div id="task-detail-panel" role="tabpanel" aria-labelledby="tab-${state.detailTab}">${taskDetailContent()}</div><p class="hint">A completed task and a passing validation are recorded outcomes. Neither implies scientific acceptance.</p>`;
}
function operationMarkup(operation) { return `<div class="operation"><strong>${esc(label(operation.type))}</strong> ${badge(operation.state)}<p>${esc(operation.summary || operation.error?.message || (typeof operation.error==='string'?operation.error:'') || 'Workbench operation recorded.')}</p>${operation.result?`<p>${esc(typeof operation.result==='string'?operation.result:JSON.stringify(operation.result))}</p>`:''}<p>Operation ${esc(operation.id)}. This state describes the request.</p></div>`; }
function taskDetailContent() {
  const detail=state.detail, task=detail.task, tab=state.detailTab;
  if(tab==='scope')return `<h3 class="scope-heading">Read scope</h3><div class="scope-paths">${(task.readRoots||[]).map(path=>`<code>${esc(path)}</code>`).join('')||'<span class="hint">No read roots recorded.</span>'}</div><h3 class="scope-heading space-top-16">Write scope</h3><div class="scope-paths">${(task.writeRoots||[]).map(path=>`<code>${esc(path)}</code>`).join('')||'<span class="hint">No write roots recorded.</span>'}</div><section class="inspector-section"><h3>Session binding & wakeup route</h3>${detail.route?`<div class="route-panel"><strong>${esc(label(detail.route.driver))}</strong> · ${detail.route.enabled===true?'Route enabled':detail.route.enabled===false?'Route disabled':'Route state unknown'}<p>Recipient: ${esc(person(detail.route.toAgent))}<br>Target session: ${esc(detail.route.targetSessionId||'Not bound')}<br>Last dispatch: ${esc(absoluteDate(detail.route.lastDispatchAt))}<br>Last delivery: ${esc(absoluteDate(detail.route.lastDeliveryAt))}</p>${detail.route.receipt?`<p>Receipt: ${esc(typeof detail.route.receipt==='string'?detail.route.receipt:JSON.stringify(detail.route.receipt))}</p>`:''}${detail.route.lastError?`<p>Last error: ${esc(typeof detail.route.lastError==='string'?detail.route.lastError:JSON.stringify(detail.route.lastError))}</p>`:''}</div>`:'<p class="empty-inline">No automatic wakeup route recorded.</p>'}<dl class="detail-meta"><dt>Required session</dt><dd>${esc(task.requiredConversationId||'Not specified')}</dd><dt>Bound session</dt><dd>${esc(task.boundConversationId||'Not recorded')}</dd></dl></section>${task.resultPreview?`<section class="inspector-section"><h3>Result preview</h3><p class="description">${esc(task.resultPreview)}</p>${sourceButton('task',task.id,'Read full result',task.title,'result')}</section>`:''}`;
  const records=detail[tab]||[];
  const omitted=detail.limits?.[tab];
  const loadMore=detail._hasMore?.[tab]??(typeof omitted==='number'?omitted>0:!!omitted?.hasMore||!!omitted?.omitted);
  return (records.length?records.map(record=>{
    if(tab==='messages')return `<article class="detail-record"><div class="record-head"><span>${esc(person(record.fromAgent))}${record.toAgent?` → ${esc(person(record.toAgent))}`:''}</span>${time(record.createdAt)}</div><h4>${esc(record.subject||'Message')}</h4><p>${esc(record.preview||'No preview recorded.')}</p><div class="receipt-line">${esc(label(record.status))} · wakeup ${esc(label(record.wakeupStatus).toLowerCase())}${record.replyTo?` · reply to ${esc(record.replyTo)}`:''}</div><div class="record-actions">${sourceButton('message',record.id,'Read original',record.subject)}<button class="text-button" data-action="reply" data-id="${esc(record.id)}">Reply</button></div></article>`;
    if(tab==='patches')return `<article class="detail-record"><div class="record-head"><span>${esc(person(record.fromAgent))}</span>${time(record.createdAt)}</div><h4>${esc(record.summary||'Submitted artifact')}</h4><p>${esc((record.targetFiles||[]).join(', ')||'No target files declared.')}</p><div class="receipt-line">${esc(label(record.kind))} · ${esc(label(record.status))}${record.supersedes?` · supersedes ${esc(record.supersedes)}`:''}${record.supersededBy?` · superseded by ${esc(record.supersededBy)}`:''}</div>${record.dependsOn?.length?`<p>Depends on: ${esc(record.dependsOn.join(', '))}</p>`:''}<div class="record-actions">${sourceButton('patch',record.id,'Read artifact',record.summary)}</div></article>`;
    return `<article class="detail-record"><div class="record-head"><span>${esc(person(record.actor))}</span>${time(record.createdAt)}</div><h4>${record.passed===true?'Passing check declared':record.passed===false?'Failing check declared':'Check result unknown'}</h4><p>${esc(record.summary||'No validation summary recorded.')}</p><div class="receipt-line">Applied: ${record.applied===true?'yes':record.applied===false?'no':'unknown'} · ${esc(record.id)}</div></article>`;
  }).join(''):`<p class="empty-inline">No ${tab==='patches'?'artifacts':tab==='validations'?'validation records':'messages'} recorded for this task.</p>`)+(loadMore?`<button class="text-button" data-action="detail-more" data-tab="${tab}">Load more ${tab==='patches'?'artifacts':tab==='validations'?'checks':'messages'}</button>`:'');
}
async function loadDetailMore(tab) {
  const detail=state.detail, id=detail.task.id;
  const button=$('[data-action="detail-more"]'); if(button){button.disabled=true;button.textContent='Loading records…';}
  try {
    // The first list request establishes a server cursor; detail children are a separate bounded window.
    const result=await api(endpoint('/api/'+tab,{taskId:id,cursor:detail._cursors?.[tab],limit:100}));
    if(state.selection?.type!=='task'||state.selection.id!==id)return;
    const known=new Set(detail[tab].map(item=>item.id));
    detail[tab].push(...result.items.filter(item=>!known.has(item.id))); detail._cursors={...detail._cursors,[tab]:result.nextCursor}; detail._hasMore={...detail._hasMore,[tab]:result.hasMore}; renderTaskInspector();
  } catch(error){toast(error.message);if(button){button.disabled=false;button.textContent='Try loading more';}}
}
function selectEvidence(id) {
  const item=[...state.items,...(state.snapshot.recentEvidence||[])].find(record=>String(record.id)===String(id));
  if(!item)return;
  ++state.detailVersion;clearTimeout(state.pollTimer);state.selection={type:'evidence',id};state.detail=null;
  $('#inspector').innerHTML=inspectorHeader('Evidence record')+`<span class="small-label">${esc(label(item.kind))}</span><h2>${esc(item.title)}</h2><div class="space-top-12">${badge(item.claimStatus || item.recordState)}</div><p class="description">${esc(item.summary||'No summary recorded.')}</p><div class="inspector-actions">${sourceButton('memory',item.id,'Read original record',item.title)}</div><dl class="detail-meta"><dt>Record ID</dt><dd>${esc(item.id)}</dd><dt>Record state</dt><dd>${esc(label(item.recordState))}</dd><dt>Claim status</dt><dd>${esc(item.kind==='claim'?label(item.claimStatus):'Not applicable')}</dd><dt>Scope</dt><dd>${esc(item.scope||'Not recorded')}</dd><dt>Source</dt><dd>${esc(item.source||'Not recorded')}</dd><dt>Updated</dt><dd>${esc(absoluteDate(item.updatedAt))}</dd></dl><section class="inspector-section"><h3>Recorded dependencies</h3>${item.dependsOn?.length?item.dependsOn.map(dependency=>`<div class="dependency-source">${sourceButton('memory',dependency,'Read '+dependency,'Memory dependency: '+dependency)}</div>`).join(''):'<p class="empty-inline">No dependencies recorded.</p>'}</section><div class="model-note">Read the original wording before relying on a claim. Record state and claim status are declarations from research memory.</div>`;
  showInspector();renderView();
}
async function pollOperation(id, taskId) {
  clearTimeout(state.pollTimer);
  state.pollTimer=setTimeout(async()=>{
    if(state.selection?.type!=='task'||state.selection.id!==taskId)return;
    try {
      const operation=await api('/api/operations/'+encodeURIComponent(id));
      if(state.selection?.id!==taskId)return;
      state.detail.operation=operation;renderTaskInspector();
      if(['pending','running'].includes(operation.state))pollOperation(id,taskId);
      else {toast(`Dispatch operation ${label(operation.state).toLowerCase()}.`);await refresh();}
    } catch(error){toast(`Operation status could not be refreshed: ${error.message}`);}
  },2000);
}
async function openSource(kind,id,title,field='') {
  const version=++state.sourceVersion;
  state.source={kind,id,title,field,offset:0,totalLength:null,hasMore:false};
  $('#source-title').textContent=title||'Original source';$('#source-text').textContent='';$('#source-meta').textContent='Fetching a bounded section of the original record.';$('#source-status').textContent='Loading source…';$('#source-more').hidden=true;$('#source-copy').disabled=true;$('#source-download').disabled=true;
  if(!$('#source-dialog').open)$('#source-dialog').showModal();
  await loadSource(version);
}
async function loadSource(version=state.sourceVersion) {
  const source=state.source;if(!source)return;
  $('#source-more').disabled=true;$('#source-status').textContent='Loading source…';
  try {
    const result=await api(endpoint('/api/source',{kind:source.kind,id:source.id,field:source.field,offset:source.offset,limit:16000}));
    if(version!==state.sourceVersion)return;
    $('#source-text').textContent+=result.text;
    source.offset=result.offset+Array.from(result.text).length;source.totalLength=result.totalLength;source.hasMore=result.hasMore;
    $('#source-meta').textContent=`${result.sourceLabel||source.id} · ${source.offset.toLocaleString()} of ${count(result.totalLength)} characters loaded`;
    $('#source-status').textContent=result.hasMore?'More of this source is available.':'End of original source.';$('#source-more').hidden=!result.hasMore;$('#source-more').textContent='Load next section';$('#source-copy').disabled=source.offset===0;$('#source-download').disabled=source.offset===0;
  } catch(error){if(version===state.sourceVersion){$('#source-status').textContent=error.message;$('#source-more').hidden=false;$('#source-more').textContent='Retry section';}}
  finally{if(version===state.sourceVersion)$('#source-more').disabled=false;}
}
async function copyLoadedSource() {
  if (!state.source || !state.source.offset) return;
  const version = state.sourceVersion;
  const text = $('#source-text').textContent;
  const button = $('#source-copy');
  button.disabled = true;
  try {
    await navigator.clipboard.writeText(text);
    if (version === state.sourceVersion) $('#source-status').textContent = 'Copied the currently loaded text. Unloaded sections are not included.';
  } catch {
    if (version === state.sourceVersion) $('#source-status').textContent = 'The browser blocked clipboard access. Download the loaded text to save a local copy.';
  } finally {
    if (version === state.sourceVersion) button.disabled = false;
  }
}
function downloadLoadedSource() {
  const source = state.source;
  if (!source || !source.offset) return;
  const blob = new Blob([$('#source-text').textContent], {type:'text/plain;charset=utf-8'});
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const safeId = String(source.id).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0,80) || 'source';
  link.href = objectUrl;
  link.download = `${source.kind}-${safeId}-loaded-0-${source.offset}.txt`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(()=>URL.revokeObjectURL(objectUrl),1000);
  $('#source-status').textContent = 'Prepared a local text download of the currently loaded range. Unloaded sections are not included.';
}
const dialogHeader=(eyebrow,title,description='')=>`<header class="dialog-heading"><div><span class="small-label">${esc(eyebrow)}</span><h2 id="dialog-title">${esc(title)}</h2>${description?`<p>${esc(description)}</p>`:''}</div><button class="icon-button" type="button" data-close="action-dialog" aria-label="Close dialog">${icon('close')}</button></header>`;
function openDialog(markup) { $('#dialog-content').innerHTML=markup; const dialog=$('#action-dialog'); if(!dialog.open)dialog.showModal(); const focusTarget=$('form input:not([type="hidden"]), form textarea, form select',dialog)||$('.dialog-footer button',dialog)||$('button',dialog); focusTarget?.focus(); }
function showAccess() {
  openDialog(`${dialogHeader('Local access','Connect to this workspace','Use the access token from the local server URL. It is kept only in this browser tab’s session.')}<form id="access-form"><div class="dialog-body"><div class="form-field"><label for="access-token">Access token</label><input type="password" id="access-token" name="token" autocomplete="off" required placeholder="Paste the token printed by the server"><small>The token is sent only to this workbench’s same-origin API.</small></div><div class="dialog-message" role="status"></div></div><footer class="dialog-footer"><button type="button" class="button quiet" data-close="action-dialog">Cancel</button><button class="button primary" type="submit">Connect workspace</button></footer></form>`);
}
function showCreate() {
  openDialog(`${dialogHeader('New task','Give the work a clear shape.','Create a scoped assignment. Creating a task runs preflight; it does not dispatch a provider.')}<form id="create-form"><div class="dialog-body"><div class="form-field"><label for="task-title">Task title</label><input id="task-title" name="title" required maxlength="200" placeholder="What should this contribution resolve?"></div><div class="form-field"><label for="task-prompt">Instructions and completion conditions</label><textarea id="task-prompt" name="prompt" required rows="5" placeholder="Describe the question, relevant context, and what a useful result includes."></textarea></div><div class="form-grid"><div class="form-field"><label for="task-owner">Assign to</label><select id="task-owner" name="assignedTo"><option value="codex">Codex</option><option value="claude-code">Claude Code</option><option value="antigravity">Antigravity</option></select></div><div class="form-field"><label for="task-role">Role <span class="optional">optional</span></label><input id="task-role" name="role" placeholder="e.g. implementation"></div><div class="form-field"><label for="task-model">Requested model <span class="optional">optional for creation</span></label><input id="task-model" name="requiredModel" placeholder="Explicit model identity"><small>Required before dispatch. An available CLI does not verify model access.</small></div><div class="form-field"><label for="task-priority">Priority</label><select id="task-priority" name="priority"><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option><option value="low">Low</option></select></div></div><hr class="form-divider"><div class="form-grid"><div class="form-field"><label for="task-read">Read roots</label><textarea id="task-read" name="readRoots" rows="2" class="short-textarea">.</textarea><small>One project-relative path per line.</small></div><div class="form-field"><label for="task-write">Write roots</label><textarea id="task-write" name="writeRoots" rows="2" class="short-textarea" placeholder="No write roots by default"></textarea><small>Paths must remain inside the project.</small></div></div><div class="form-field space-top-16 no-bottom"><label for="task-session">Required conversation ID <span class="optional">optional</span></label><input id="task-session" name="requiredConversationId" placeholder="Leave empty for a new binding"></div><div class="scope-note"><strong>Action scope</strong><p>The assignment is saved to the selected project. Review its preflight result before choosing the separate Dispatch action.</p></div><div class="dialog-message" role="status"></div></div><footer class="dialog-footer"><button type="button" class="button quiet" data-close="action-dialog">Cancel</button><button type="submit" class="button primary">${icon('plus')}Create task</button></footer></form>`);
}
async function createBoundFollowup() {
  const task=state.detail?.task;if(!task)return;
  try {
    const original=await api(endpoint('/api/source',{kind:'task',id:task.id,field:'prompt',limit:64000}));
    if(original.hasMore){toast('This brief exceeds the task form limit. Read the full source and create a scoped follow-up.');return;}
    showCreate();const form=$('#create-form');
    const values={title:task.title,prompt:original.text,assignedTo:task.assignedTo,role:task.role||'',priority:task.priority||'normal',readRoots:(task.readRoots||['.']).join('\n'),writeRoots:(task.writeRoots||[]).join('\n')};
    for(const [name,value] of Object.entries(values))if(form.elements.namedItem(name))form.elements.namedItem(name).value=value;
    form.elements.namedItem('requiredModel')?.focus();
  } catch(error){toast(error.message);}
}
function showMessage(replyId) {
  const task=state.detail?.task;if(!task)return;
  const reply=replyId?(state.detail.messages||[]).find(message=>message.id===replyId):null;
  const recipient=reply?.fromAgent||task.assignedTo;
  openDialog(`${dialogHeader(reply?'Reply to message':'Task message',reply?'Continue the conversation.':'Add context to the work.',`Task: ${task.title}`)}<form id="message-form" data-task="${esc(task.id)}" data-reply="${esc(reply?.id||'')}"><div class="dialog-body">${reply?`<div class="scope-note"><strong>Replying to ${esc(person(reply.fromAgent))}</strong><p>${esc(reply.preview||reply.subject||'Message '+reply.id)}</p></div>`:''}<div class="form-grid"><div class="form-field"><label for="message-from">Send on behalf of</label><select id="message-from" name="fromAgent">${['codex','claude-code','antigravity'].map(id=>`<option value="${id}" ${id===(reply?.toAgent||task.fromAgent||'codex')?'selected':''}>${esc(person(id))}</option>`).join('')}</select></div><div class="form-field"><label for="message-to">To</label><select id="message-to" name="toAgent">${['codex','claude-code','antigravity'].map(id=>`<option value="${id}" ${id===recipient?'selected':''}>${esc(person(id))}</option>`).join('')}</select></div></div><div class="form-field space-top-16"><label for="message-subject">Subject <span class="optional">optional</span></label><input id="message-subject" name="subject" value="${esc(reply?.subject?`Re: ${reply.subject.replace(/^Re:\s*/i,'')}`:'')}" maxlength="500"></div><div class="form-field"><label for="message-content">Message</label><textarea id="message-content" name="content" rows="6" required placeholder="Share a finding, ask a question, or clarify the scope."></textarea></div><div class="scope-note">This records your user-initiated workbench message on behalf of the selected participant. It is not autonomous model output. A saved receipt does not establish delivery or processing.${state.snapshot.control?.paused?' Execution is paused; automatic follow-up remains held.':''}</div><div class="dialog-message" role="status"></div></div><footer class="dialog-footer"><button type="button" class="button quiet" data-close="action-dialog">Cancel</button><button type="submit" class="button primary">${icon('send')}${reply?'Send reply':'Send message'}</button></footer></form>`);
}
function showDispatch() {
  const task=state.detail?.task;if(!task)return;
  const provider=state.capabilities?.providers?.find(item=>item.id===task.assignedTo);
  openDialog(`${dialogHeader('Explicit dispatch','Start this assignment?','This admits one provider operation with the recorded task, model, scope, and session bindings.')}<form id="dispatch-form" data-task="${esc(task.id)}"><div class="dialog-body"><div class="confirmation-summary"><h3>${esc(task.title)}</h3><dl class="detail-meta"><dt>Provider</dt><dd>${esc(person(task.assignedTo))}</dd><dt>Requested model</dt><dd>${esc(task.requiredModel||'Not recorded')}</dd><dt>Session</dt><dd>${esc(task.boundConversationId||task.requiredConversationId||'New binding')}</dd><dt>Read roots</dt><dd>${esc((task.readRoots||[]).join(', ')||'None recorded')}</dd><dt>Write roots</dt><dd>${esc((task.writeRoots||[]).join(', ')||'None recorded')}</dd></dl></div><p class="capability">${icon('info')} CLI ${provider?.executableAvailable===true?'found':provider?.executableAvailable===false?'unavailable':'availability unknown'}; authentication ${esc(provider?.authentication||'not verified')}.</p><div class="form-grid space-top-20"><div class="form-field"><label for="dispatch-effort">Effort</label><select id="dispatch-effort" name="effort"><option value="low">Low (default)</option><option value="medium">Medium</option><option value="high">High</option></select></div><div class="form-field"><label for="dispatch-timeout">Timeout (seconds)</label><input id="dispatch-timeout" name="timeoutSeconds" type="number" min="1" max="600" step="1" value="120" required></div></div><div class="scope-note">${state.snapshot.mode==='demo'?'<strong>Simulated demo operation</strong><p>No provider will be contacted.</p>':'<strong>This can start a real provider call.</strong><p>Provider permissions and model access must be available. A successful operation does not mark the task complete or accept its scientific result.</p>'}</div><div class="dialog-message" role="status"></div></div><footer class="dialog-footer"><button class="button quiet" type="button" data-close="action-dialog">Cancel</button><button class="button primary" type="submit">${icon('play')}${state.snapshot.mode==='demo'?'Simulate dispatch':'Dispatch task'}</button></footer></form>`);
}
function showControl() {
  if(!state.snapshot)return;
  const paused=state.snapshot.control?.paused;
  openDialog(`${dialogHeader('Execution control',paused?'Resume new work?':'Pause new work?',paused?'Pending work can continue under its existing routes and bindings.':'Hold new provider execution and automatic continuation across the bridge.')}<form id="control-form" data-paused="${!paused}"><div class="dialog-body"><div class="scope-note">${paused?'<p>Resume allows pending work to continue. It preserves each route’s enabled or disabled setting and its session binding.</p>':'<p>Already admitted operations may finish. Pause does not kill processes or change task completion states.</p>'}<p>Reads, task creation, messages, results, and validation remain available.</p>${state.snapshot.mode==='demo'?'<p><strong>Demo:</strong> this changes only this server’s fictional in-memory state.</p>':''}</div><div class="form-field"><label for="control-reason">Reason <span class="optional">optional</span></label><textarea name="reason" id="control-reason" rows="3" class="medium-textarea" placeholder="Leave context for the next person."></textarea></div><div class="dialog-message" role="status"></div></div><footer class="dialog-footer"><button class="button quiet" type="button" data-close="action-dialog">Cancel</button><button class="button ${paused?'primary':'danger'}" type="submit">${icon(paused?'play':'pause')}${paused?'Resume new work':'Pause new work'}</button></footer></form>`);
}
async function submitForm(form) {
  const data=Object.fromEntries(new FormData(form));const message=$('.dialog-message',form);const submit=$('[type="submit"]',form);const original=submit.innerHTML;
  message.innerHTML='';submit.disabled=true;submit.textContent='Saving…';
  try {
    if(form.id==='access-form') {token=data.token.trim();try{sessionStorage.setItem(tokenKey,token);}catch{}await api('/api/snapshot');$('#action-dialog').close();await refresh();return;}
    if(form.id==='create-form') {
      const body={title:data.title.trim(),prompt:data.prompt.trim(),assignedTo:data.assignedTo,priority:data.priority,readRoots:data.readRoots.split('\n').map(value=>value.trim()).filter(Boolean),writeRoots:data.writeRoots.split('\n').map(value=>value.trim()).filter(Boolean)};
      for(const key of ['role','requiredModel','requiredConversationId'])if(data[key].trim())body[key]=data[key].trim();
      const result=await api('/api/tasks',{method:'POST',body});
      openDialog(`${dialogHeader('Task created','The assignment is recorded.','Review preflight before starting execution.')}<div class="dialog-body"><div class="confirmation-summary"><h3>${esc(result.task.title)}</h3><p class="hint">${esc(result.task.id)} · ${esc(person(result.task.assignedTo))}</p></div><div class="${result.preflight?.ok?'inline-success':'scope-note'} space-top-20">${result.preflight?.ok?'Preflight checks passed for the recorded scope.':'Preflight does not report ready. Inspect its findings before dispatch.'}</div><details class="record-disclosure"><summary>View preflight record</summary><pre class="preflight-list record-json">${esc(JSON.stringify(result.preflight,null,2))}</pre></details><p class="hint">Task creation has not started a provider.</p></div><footer class="dialog-footer"><button class="button quiet" data-close="action-dialog">Close</button><button class="button primary" data-action="inspect-created" data-id="${esc(result.task.id)}">Inspect task</button></footer>`);
      await refresh();await selectTask(result.task.id,false);return;
    }
    if(form.id==='message-form') {
      const body={taskId:form.dataset.task,fromAgent:data.fromAgent,toAgent:data.toAgent,content:data.content.trim()};if(data.subject.trim())body.subject=data.subject.trim();if(form.dataset.reply)body.replyTo=form.dataset.reply;
      const receipt=await api('/api/messages',{method:'POST',body});
      openDialog(`${dialogHeader('Message recorded','Your context is saved.','Delivery and processing depend on the recorded receipt and route.')}<div class="dialog-body"><div class="inline-success">${form.dataset.reply?'Reply':'Message'} saved to ${esc(form.dataset.task)}.</div><p class="hint">${esc(person(body.fromAgent))} → ${esc(person(body.toAgent))}</p><details class="record-disclosure"><summary>View message receipt</summary><pre class="preflight-list record-json">${esc(JSON.stringify(receipt,null,2))}</pre></details></div><footer class="dialog-footer"><button class="button primary" data-close="action-dialog">Done</button></footer>`);
      await refresh();return;
    }
    if(form.id==='dispatch-form') {
      const operation=await api('/api/tasks/'+encodeURIComponent(form.dataset.task)+'/dispatch',{method:'POST',body:{effort:data.effort,timeoutSeconds:Number(data.timeoutSeconds)}});
      $('#action-dialog').close();if(state.detail?.task.id===form.dataset.task){state.detail.operation=operation;renderTaskInspector();}else await selectTask(form.dataset.task);toast('Dispatch operation accepted. Follow its recorded status in the inspector.');pollOperation(operation.id,form.dataset.task);await refresh();return;
    }
    if(form.id==='control-form') {const control=await api('/api/control',{method:'POST',body:{paused:form.dataset.paused==='true',...(data.reason.trim()?{reason:data.reason.trim()}:{})}});$('#action-dialog').close();toast(control.paused?'New execution is paused. Already admitted operations may finish.':'Execution resumed with existing route settings.');await refresh();}
  } catch(error){message.innerHTML=`<div class="inline-error">${esc(error.message)}${error.status===403?' Check the token, local origin, and project permissions.':''}${error.details?`<br>${esc(typeof error.details==='string'?error.details:JSON.stringify(error.details))}`:''}</div>`;}
  finally{if(submit.isConnected){submit.disabled=false;submit.innerHTML=original;}}
}
function clearFilters() {state.query='';state.agent='';state.phase='';state.kind='';state.recordState='';$('#search').value='';$('#agent-filter').value='';$('#phase-filter').value='';loadView();}
document.addEventListener('click',async event=>{
  const close=event.target.closest('[data-close]');if(close){$('#'+close.dataset.close).close();return;}
  const target=event.target.closest('[data-action]');if(!target){const row=event.target.closest('[data-task-row]');if(row)selectTask(row.dataset.taskRow);return;}
  const action=target.dataset.action,id=target.dataset.id;
  if(action==='refresh')refresh();if(action==='reload-view')loadView();if(action==='access')showAccess();if(action==='create')showCreate();if(action==='clear')clearFilters();if(action==='project')projectInspector();if(action==='task')selectTask(id);if(action==='evidence')selectEvidence(id);
  if(action==='participant'){++state.detailVersion;clearTimeout(state.pollTimer);state.selection={type:'participant',id};state.detail=null;renderParticipantInspector(id);showInspector();renderView();}
  if(action==='participant-tasks'){state.agent=id;$('#agent-filter').value=id;location.hash='tasks';if(state.view==='tasks')loadView();}
  if(action==='source')openSource(target.dataset.kind,id,target.dataset.title,target.dataset.field);
  if(action==='event'){if(target.dataset.kind==='validation'&&target.dataset.task){await selectTask(target.dataset.task);state.detailTab='validations';if(state.detail)renderTaskInspector();}else openSource(target.dataset.kind,id,'Original '+target.dataset.kind);}
  if(action==='layout'){state.taskLayout=target.dataset.layout;renderTasks();}
  if(action==='kind'){state.kind=target.dataset.kind;loadView();}
  if(action==='load-more')loadView(true);
  if(action==='detail-tab'){state.detailTab=target.dataset.tab;renderTaskInspector();$('#tab-'+state.detailTab).focus();}
  if(action==='detail-more')loadDetailMore(target.dataset.tab);
  if(action==='bind-followup')createBoundFollowup();if(action==='compose-message')showMessage();if(action==='reply')showMessage(id);if(action==='dispatch')showDispatch();
  if(action==='inspect-created'){$('#action-dialog').close();selectTask(id);}
  if(action==='close-inspector'){$('#inspector').classList.remove('is-open');}
});
document.addEventListener('submit',event=>{if(event.target.id==='filter-form'){event.preventDefault();loadView();}else if(['access-form','create-form','message-form','dispatch-form','control-form'].includes(event.target.id)){event.preventDefault();submitForm(event.target);}});
let searchTimer;
$('#search').addEventListener('input',event=>{state.query=event.target.value;clearTimeout(searchTimer);searchTimer=setTimeout(()=>loadView(),220);});
$('#agent-filter').addEventListener('change',event=>{state.agent=event.target.value;loadView();});
$('#phase-filter').addEventListener('change',event=>{state.phase=event.target.value;loadView();});
document.addEventListener('change',event=>{if(event.target.id==='evidence-state'){state.recordState=event.target.value;loadView();}});
$('#clear-filters').addEventListener('click',clearFilters);$('#refresh-button').addEventListener('click',refresh);$('#create-button').addEventListener('click',showCreate);$('#control-button').addEventListener('click',showControl);$('#access-button').addEventListener('click',showAccess);$('#source-more').addEventListener('click',()=>loadSource());$('#source-copy').addEventListener('click',copyLoadedSource);$('#source-download').addEventListener('click',downloadLoadedSource);
document.addEventListener('keydown',event=>{
  if(event.key==='/'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)&&!$('dialog[open]')){event.preventDefault();$('#search').focus();}
  if(event.key==='Escape'&&!$('dialog[open]'))$('#inspector').classList.remove('is-open');
  const node=event.target.closest('.graph-node');if(node&&(event.key==='Enter'||event.key===' ')){event.preventDefault();node.dispatchEvent(new MouseEvent('click',{bubbles:true}));}
  if(event.target.getAttribute('role')==='tab'&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const tabs=[...document.querySelectorAll('[role="tab"]')];let index=tabs.indexOf(event.target);index=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabs[index].click();}
});
window.addEventListener('hashchange',()=>{const view=location.hash.slice(1);if(views[view]&&view!==state.view){state.view=view;state.kind='';state.recordState='';loadView();}});
$('#source-dialog').addEventListener('close',()=>{++state.sourceVersion;state.source=null;$('#source-text').textContent='';});
$('#refresh-button').innerHTML=icon('refresh');$('#search-icon').innerHTML=icon('search');$('[data-close="source-dialog"]').innerHTML=icon('close');$('#create-button').innerHTML=icon('plus')+'New task';
renderNavigation();renderDefaultInspector();refresh();
setInterval(updateFreshness,30000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)updateFreshness();});
