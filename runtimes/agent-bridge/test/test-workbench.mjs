import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { BridgeDatabase } from '../src/core/bridge-db.mjs';
import { McpStdioServer } from '../src/core/mcp-server.mjs';
import { ProjectReader, safePath, normalizeTask } from '../src/workbench/reader.mjs';
import { createWorkbench } from '../src/workbench/server.mjs';
import { DemoReader } from '../src/workbench/demo.mjs';
import { callBridgeTool } from '../src/workbench/mcp-client.mjs';

function workspace(t) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(),'workbench-test-'));
  t.after(() => fs.rmSync(project,{recursive:true,force:true}));
  return project;
}
function bridge(project,t) {
  const db = new BridgeDatabase(path.join(project,'.agent-bridge/bridge.sqlite'));
  t.after(() => db.db.close());
  return db;
}
function task(db,project,extra={}) {
  return db.createTask({fromAgent:'codex',assignedTo:'claude-code',title:'Synthetic task',prompt:'Do not call a provider',cwd:project,requiredModel:'synthetic-model',permissions:{readRoots:['.'],writeRoots:[]},metadata:{role:'reviewer',deliveryMode:'read_only'},...extra});
}
function fileState(project) {
  const out = {};
  // SQLite WAL readers update shared-memory coordination, not persistent records.
  const walk = dir => { for (const e of fs.readdirSync(dir,{withFileTypes:true})) { const f=path.join(dir,e.name); if(e.isDirectory()) walk(f); else if(e.isFile()&&!e.name.endsWith('-shm')) out[path.relative(project,f)]=fs.readFileSync(f); } };
  walk(project); return out;
}
function assertSameFiles(project,before) {
  const after=fileState(project);
  assert.deepEqual(Object.keys(after).sort(),Object.keys(before).sort());
  for(const name of Object.keys(before)) assert.ok(after[name].equals(before[name]),`Unexpected persistent file change: ${name}`);
}
async function request(app,route,{method='GET',body,headers={}}={}) {
  const response = await fetch(app.origin+route,{method,headers:{Authorization:`Bearer ${app.token}`,...(method==='POST'?{Origin:app.origin,'Content-Type':'application/json'}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,body:await response.json()};
}
async function appFor(t,options) { const app=await createWorkbench(options); t.after(()=>app.close()); return app; }

test('missing sources and all GET routes never initialize a project',async t=>{
  const project=workspace(t), app=await appFor(t,{project});
  const before=fileState(project);
  const result=await request(app,'/api/snapshot');
  assert.equal(result.status,200); assert.equal(result.body.sources.bridge.status,'missing');
  assert.equal(result.body.totals.tasks,null); assert.equal(result.body.control.paused,null);
  assert.equal((await request(app,'/api/tasks')).status,404);
  assert.equal((await request(app,'/api/capabilities')).status,200);
  assertSameFiles(project,before);
});

test('read-only lists retain unread messages, paginate without duplicates, and report corrupt sources',async t=>{
  const project=workspace(t), db=bridge(project,t), record=task(db,project);
  for(let i=0;i<5;i++) db.sendMessage({fromAgent:'codex',toAgent:'claude-code',taskId:record.id,content:`message ${i} <script>alert(1)</script>`});
  fs.mkdirSync(path.join(project,'.research-memory')); fs.writeFileSync(path.join(project,'.research-memory/memory.sqlite3'),'invalid sqlite');
  const before=fileState(project), reader=new ProjectReader(project);
  const first=reader.list('messages',new URLSearchParams({taskId:record.id,limit:'2'}));
  const second=reader.list('messages',new URLSearchParams({taskId:record.id,limit:'2',cursor:first.nextCursor}));
  assert.equal(first.hasMore,true); assert.equal(new Set([...first.items,...second.items].map(m=>m.id)).size,4);
  assert.throws(()=>reader.list('messages',new URLSearchParams({taskId:'other',cursor:first.nextCursor})),/Cursor/);
  assert.equal(reader.task(record.id).limits.messages,0);
  const source=reader.source(new URLSearchParams({kind:'message',id:first.items[0].id,offset:'2',limit:'10'}));
  assert.equal(source.text.length,10); assert.equal(source.hasMore,true);
  assert.ok(reader.list('messages').items.every(m=>m.status==='unread'&&m.readAt===null));
  assert.equal(reader.snapshot().sources.memory.status,'error');
  assertSameFiles(project,before);
});

test('memory is observed without check/invalidation; document scope rejects escape and symlinks',t=>{
  const project=workspace(t); fs.writeFileSync(path.join(project,'controls.md'),'changed source');
  fs.mkdirSync(path.join(project,'.research-memory'));
  const memory=new DatabaseSync(path.join(project,'.research-memory/memory.sqlite3'));
  memory.exec('CREATE TABLE config(key TEXT,value TEXT); CREATE TABLE records(id INTEGER PRIMARY KEY,kind TEXT,title TEXT,summary TEXT,source TEXT,scope TEXT,claim_status TEXT,body TEXT,state TEXT,updated_at TEXT); CREATE TABLE dependencies(record_id INTEGER,dependency_id INTEGER)');
  memory.prepare('INSERT INTO config VALUES(?,?)').run('version','1'); memory.prepare('INSERT INTO config VALUES(?,?)').run('project',project); memory.prepare('INSERT INTO config VALUES(?,?)').run('controls','["controls.md"]');
  memory.prepare('INSERT INTO records VALUES(1,?,?,?,?,?,?,?,?,?)').run('claim','Fictional claim','Bounded summary','controls.md','synthetic','conjecture','original source','current','2026-01-01'); memory.close();
  const before=fileState(project), reader=new ProjectReader(project);
  assert.equal(reader.list('evidence').items[0].claimStatus,'conjecture');
  assert.equal(reader.list('evidence').items[0].recordState,'current');
  assert.equal(reader.source(new URLSearchParams({kind:'memory',id:'1'})).text,'original source');
  assert.equal(reader.source(new URLSearchParams({kind:'document',id:'controls.md'})).text,'changed source');
  assertSameFiles(project,before);
  assert.throws(()=>safePath(project,'../outside'),/escapes/);
  fs.symlinkSync(os.tmpdir(),path.join(project,'outside'));
  assert.throws(()=>safePath(project,'outside/new-file'),/escapes/);
  assert.throws(()=>reader.source(new URLSearchParams({kind:'document',id:'.agent-bridge/bridge.sqlite'})),/not a declared/);
  fs.unlinkSync(path.join(project,'controls.md')); fs.symlinkSync(path.join(os.tmpdir(),'outside-text'),path.join(project,'controls.md'));
  assert.throws(()=>reader.source(new URLSearchParams({kind:'document',id:'controls.md'})),/symlink|escapes/i);
});

test('HTTP bearer, Host, Origin, JSON and allowlists are enforced',async t=>{
  const project=workspace(t),app=await appFor(t,{project});
  assert.equal((await request(app,'/api/snapshot',{headers:{Authorization:'Bearer wrong'}})).status,401);
  const hostileHostStatus=await new Promise((resolve,reject)=>{
    const outgoing=http.get(app.origin+'/api/snapshot',{headers:{Host:'attacker.example',Authorization:`Bearer ${app.token}`}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});
    outgoing.on('error',reject);
  });
  assert.equal(hostileHostStatus,403);
  assert.equal((await request(app,'/api/control',{method:'POST',body:{paused:true},headers:{Origin:'https://attacker.example'}})).status,403);
  assert.equal((await request(app,'/api/control',{method:'POST',body:{paused:true},headers:{'Content-Type':'text/plain'}})).status,415);
  assert.equal((await request(app,'/api/tasks',{method:'POST',body:{title:'x',prompt:'x',assignedTo:'codex',configOverrides:['x']}})).status,400);
  assert.equal((await request(app,'/api/tasks',{method:'POST',body:{title:'x',prompt:'x',assignedTo:'codex',writeRoots:['../x']}})).status,403);
  assert.equal((await request(app,'/api/control',{method:'POST',body:{paused:true,reason:'x'.repeat(140000)}})).status,413);
  const arbitrary=await fetch(app.origin+'/reader.mjs'); assert.equal(arbitrary.status,404);
  assert.equal(fs.existsSync(path.join(project,'.agent-bridge')),false);
});

test('creation reuses bridge preflight without dispatch; messages return actual receipt; dispatch is bounded and independent',async t=>{
  const project=workspace(t),calls=[];
  let unblock;
  const blocked=new Promise(resolve=>{unblock=resolve;});
  const app=await appFor(t,{project,toolClient:async options=>{
    calls.push(options);
    if(options.tool==='bridge_create_task'||options.tool==='bridge_send_message') return callBridgeTool(options);
    await blocked;
    return {ok:true,queuedInBridge:true,taskCompleted:false};
  }});
  const created=await request(app,'/api/tasks',{method:'POST',body:{title:'Synthetic <script>task</script>',prompt:'Do not call real providers',assignedTo:'claude-code',role:'reviewer'}});
  assert.equal(created.status,201); assert.equal(created.body.preflight.authorityGranted,false); assert.equal(calls.length,1);
  assert.deepEqual(created.body.task.readRoots,['.']); assert.deepEqual(created.body.task.writeRoots,[]);
  assert.equal((await request(app,`/api/tasks/${created.body.task.id}/dispatch`,{method:'POST',body:{}})).status,409);
  const modeled=await request(app,'/api/tasks',{method:'POST',body:{title:'Synthetic',prompt:'Fixture',assignedTo:'codex',requiredModel:'synthetic-model'}});
  const taskId=modeled.body.task.id;
  const sent=await request(app,'/api/messages',{method:'POST',body:{taskId,fromAgent:'codex',toAgent:'claude-code',content:'User initiated'}});
  assert.equal(sent.status,201); assert.equal(sent.body.receipt.messageId,sent.body.message.id); assert.equal(sent.body.message.status,'unread'); assert.equal(sent.body.message.origin,'workbench_user');
  const started=await request(app,`/api/tasks/${taskId}/dispatch`,{method:'POST',body:{effort:'low',timeoutSeconds:1}});
  assert.equal(started.status,202);
  assert.equal((await request(app,`/api/tasks/${taskId}/dispatch`,{method:'POST',body:{}})).status,409);
  await new Promise(resolve=>setImmediate(resolve));
  const dispatchCall=calls.find(c=>c.tool==='codex_exec');
  assert.equal(dispatchCall.args.completeTaskOnExit,false); assert.equal(dispatchCall.args.cwd,project); assert.equal(dispatchCall.args.model,'synthetic-model'); assert.equal(dispatchCall.args.configOverrides,undefined);
  assert.equal((await request(app,'/api/control',{method:'POST',body:{paused:true}})).status,200);
  unblock();
  await new Promise(resolve=>setImmediate(resolve));
  const ended=await request(app,`/api/operations/${started.body.id}`);
  assert.equal(ended.body.state,'succeeded'); assert.equal(ended.body.result.queuedInBridge,true);
});

test('pause persists across instances, preserves pending and routes, and lets admitted work finish',async t=>{
  const project=workspace(t),db=bridge(project,t),second=new BridgeDatabase(db.dbPath); t.after(()=>second.db.close());
  const record=task(db,project);
  db.configureWakeupRoute({taskId:record.id,toAgent:'codex',targetSessionId:'synthetic-session',driver:'manual',cwd:project});
  const before=db.getWakeupRoute(record.id);
  const admitted=db.admitExecution(); assert.equal(admitted.admitted,true);
  db.setControlState({paused:true,reason:'Synthetic pause'});
  assert.throws(()=>second.admitExecution(),e=>e.code==='BRIDGE_PAUSED');
  const msg=second.sendMessage({fromAgent:'claude-code',toAgent:'codex',taskId:record.id,content:'Keep pending'});
  assert.equal(msg.wakeup_status,'pending');
  assert.equal((await second.executeWakeupDelivery(record.id)).reason,'bridge_paused');
  assert.equal(second.getMessageById(msg.id).wakeup_status,'pending');
  db.updateTaskPhase({taskId:record.id,phase:'cli_turn_ended',result:'Admitted result survives pause'});
  assert.equal(db.getTaskById(record.id).result,'Admitted result survives pause');
  second.setControlState({paused:false});
  const after=second.getWakeupRoute(record.id);
  for(const key of ['enabled','driver','target_session_id']) assert.equal(after[key],before[key]);
  assert.equal(second.claimPendingWakeup(record.id).claimed,true);
});

test('provider execution entry guards include every execution tool and leave reads/writes available',async t=>{
  const project=workspace(t),db=bridge(project,t);
  const names=['codex_exec','codex_resume','codex_fork','codex_review','claude_exec','claude_resume','claude_review','antigravity_exec'];
  const server=new McpStdioServer({name:'synthetic'});
  server.executionAdmission={names:new Set(names),admit:()=>db.admitExecution()};
  let called=0;
  for(const name of [...names,'bridge_send_message']) server.registerTool({name,inputSchema:{}},()=>++called);
  db.setControlState({paused:true});
  for(const name of names) assert.throws(()=>server.tools.get(name).handler({}),e=>e.code==='BRIDGE_PAUSED');
  assert.equal(server.tools.get('bridge_send_message').handler({}),1);
  // Inspect actual provider registrations, without importing their executable top-level scripts.
  for(const [file,expected] of [['codex',names.slice(0,4)],['claude-code',names.slice(4,7)],['antigravity',names.slice(7)]]) {
    const source=fs.readFileSync(new URL(`../src/servers/${file}-mcp.mjs`,import.meta.url),'utf8');
    const guarded = JSON.parse(source.match(/names: new Set\((\[[^\]]+\])\)/)[1]);
    assert.deepEqual(guarded,expected);
    assert.match(source,/admit: \(\) => bridgeDb\.admitExecution\(\)/);
  }
  for (const [provider,tool] of [['codex','codex_exec'],['claude-code','claude_exec'],['antigravity','antigravity_exec']]) {
    await assert.rejects(callBridgeTool({project,dbPath:db.dbPath,provider,tool,args:{prompt:'Must never execute',model:'synthetic-model'}}),e=>e.code==='BRIDGE_PAUSED');
  }
  const record=task(db,project,{assignedTo:'antigravity'});
  db.configureWakeupRoute({taskId:record.id,toAgent:'antigravity',targetSessionId:'synthetic-session',driver:'manual',cwd:project});
  // Exercise the actual message-only MCP handler without widening the HTTP tool allowlist.
  const asked=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('../src/servers/antigravity-mcp.mjs',import.meta.url))],{
      cwd:project,env:{...process.env,AGENT_BRIDGE_DB:db.dbPath,MCP_CALLER_AGENT:'codex',MCP_ONE_SHOT_WORKER:'1'},stdio:['pipe','pipe','pipe'],
    });
    let done=false,buffer='';
    const timer=setTimeout(()=>finish(new Error('Paused ask MCP timeout')),10000);
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);child.kill();error?reject(error):resolve(value);};
    child.on('error',error=>finish(error));
    child.on('exit',code=>finish(new Error(`Paused ask MCP exited: ${code}`)));
    child.stdin.on('error',error=>finish(error));
    child.stderr.resume();
    child.stdout.on('data',chunk=>{
      buffer+=chunk;
      let end;
      while((end=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
        try{
          const response=JSON.parse(line);
          if(response.id!==2)continue;
          if(response.error||response.result.isError)return finish(new Error('Paused ask MCP returned an error'));
          finish(null,JSON.parse(response.result.content.find(c=>c.type==='text').text));
        }catch(error){finish(error);}
      }
    });
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'paused-ask-test',version:'1'}}})+'\n');
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'antigravity_ask',arguments:{question:'Keep this question while paused',taskId:record.id}}})+'\n');
  });
  assert.equal(asked.ok,true);
  assert.equal(db.getMessageById(asked.receipt.messageId).content,'Keep this question while paused');
  assert.equal(db.getMessageById(asked.receipt.messageId).wakeup_status,'pending');
  assert.equal((await db.executeWakeupDelivery(record.id)).reason,'bridge_paused');
  assert.equal(normalizeTask({id:'x',metadata_json:'{"modelSource":"caller_declared"}',permissions_json:'{}',actual_model:'declared'}).modelSource,null);
});


test('demo actions stay in memory and never invoke providers or create a bridge',async t=>{
  const project=workspace(t), fixture=path.join(project,'fixture.json');
  fs.writeFileSync(fixture,JSON.stringify({project:{name:'Fictional',path:null,question:'Synthetic?',questionSource:'fixture',currentStatePreview:'Demo only'},tasks:[],messages:[],patches:[],validations:[],evidence:[],documents:[],routes:[]}));
  const before=fileState(project);
  const app=await appFor(t,{project,demo:true,fixture,toolClient:()=>{throw new Error('Demo must never call MCP');}});
  const created=await request(app,'/api/tasks',{method:'POST',body:{title:'Fictional task',prompt:'<img src=x onerror=alert(1)>',assignedTo:'codex',requiredModel:'fictional-model'}});
  assert.equal(created.status,201); assert.equal(created.body.simulated,true);
  const id=created.body.task.id;
  assert.equal((await request(app,'/api/control',{method:'POST',body:{paused:true}})).body.simulated,true);
  const sent=await request(app,'/api/messages',{method:'POST',body:{taskId:id,fromAgent:'codex',toAgent:'claude-code',content:'Held fictional message'}});
  assert.equal(sent.body.message.status,'unread'); assert.equal(sent.body.simulated,true);
  assert.equal((await request(app,`/api/tasks/${id}/dispatch`,{method:'POST',body:{}})).status,409);
  await request(app,'/api/control',{method:'POST',body:{paused:false}});
  const operation=await request(app,`/api/tasks/${id}/dispatch`,{method:'POST',body:{}});
  assert.equal(operation.status,202);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await request(app,`/api/operations/${operation.body.id}`)).body.result.simulated,true);
  assert.equal((await request(app,'/api/snapshot')).body.mode,'demo');
  assert.deepEqual(fileState(project),before);
});


test('source ranges use Unicode code points across SQLite, documents, and demo',t=>{
  const project=workspace(t),db=bridge(project,t);
  const longPrompt='😀ab'.repeat(401);
  const record=task(db,project,{prompt:longPrompt});
  db.db.prepare('UPDATE tasks SET result=? WHERE id=?').run('😀result',record.id);
  const text='😀ab';
  const message=db.sendMessage({fromAgent:'codex',toAgent:'claude-code',taskId:record.id,content:text});
  db.db.prepare('INSERT INTO patches(patch_id,task_id,from_agent,to_agent,raw_content,sha256,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('unicode-patch',record.id,'codex','claude-code',text,'synthetic','2026-01-01','2026-01-01');
  fs.writeFileSync(path.join(project,'controls.md'),text);
  fs.mkdirSync(path.join(project,'.research-memory'));
  const memory=new DatabaseSync(path.join(project,'.research-memory/memory.sqlite3'));
  memory.exec('CREATE TABLE config(key TEXT,value TEXT); CREATE TABLE records(id INTEGER PRIMARY KEY,body TEXT)');
  memory.prepare('INSERT INTO config VALUES(?,?)').run('version','1');
  memory.prepare('INSERT INTO config VALUES(?,?)').run('project',project);
  memory.prepare('INSERT INTO records VALUES(?,?)').run(1,text);
  memory.close();
  const fixture=path.join(project,'unicode-demo.json');
  fs.writeFileSync(fixture,JSON.stringify({project:{},tasks:[{id:record.id,prompt:longPrompt,result:'😀result'}],messages:[{id:message.id,content:text}],patches:[{id:'unicode-patch',content:text}],validations:[],evidence:[{id:1,body:text}],documents:[{id:'controls.md',text}],routes:[]}));
  const readers=[new ProjectReader(project),new DemoReader(fixture)];
  for(const reader of readers){
    const taskPages=[0,601,1202].map(offset=>reader.source(new URLSearchParams({kind:'task',id:record.id,offset:String(offset),limit:'601'})));
    assert.deepEqual(taskPages.map(page=>[page.offset,page.totalLength,page.hasMore]),[[0,1203,true],[601,1203,true],[1202,1203,false]]);
    assert.equal(taskPages.map(page=>page.text).join(''),longPrompt);
    assert.equal(Array.from(taskPages[0].text).length,601);
    assert.equal(reader.source(new URLSearchParams({kind:'task',id:record.id,field:'result',offset:'1'})).text,'result');
    const empty=reader.source(new URLSearchParams({kind:'task',id:record.id,field:'error'}));
    assert.equal(empty.text,''); assert.equal(empty.totalLength,0); assert.equal(empty.hasMore,false);
    for(const field of ['','cwd',"prompt) FROM tasks --"]){
      assert.throws(()=>reader.source(new URLSearchParams({kind:'task',id:record.id,field})),error=>error.code==='INVALID_FIELD');
    }
    for(const [kind,id] of [['message',message.id],['patch','unicode-patch'],['memory','1'],['document','controls.md']]){
      const pages=[0,1,2,3].map(offset=>reader.source(new URLSearchParams({kind,id,offset:String(offset),limit:'1'})));
      assert.deepEqual(pages.map(({text,offset,totalLength,hasMore})=>({text,offset,totalLength,hasMore})),[
        {text:'😀',offset:0,totalLength:3,hasMore:true},
        {text:'a',offset:1,totalLength:3,hasMore:true},
        {text:'b',offset:2,totalLength:3,hasMore:false},
        {text:'',offset:3,totalLength:3,hasMore:false},
      ],`${reader.constructor.name} ${kind}`);
      assert.equal(pages.map(page=>page.text).join(''),text);
    }
  }
});
