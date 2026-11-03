import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { acquireTodoOwner, createTodoStore, requestTodos, todoStorePath } from "../src-tauri/agent-host/todos.mjs"

const source = fileURLToPath(new URL("../src-tauri/agent-host/supervisor.mjs", import.meta.url))
const peer = `
import readline from 'node:readline';
import { createConnection } from 'node:net';
const write = frame => process.stdout.write(JSON.stringify(frame)+'\\n');
function todoRequest(id,method,params){return new Promise((resolve,reject)=>{const socket=createConnection(process.env.STILL_TODO_SOCKET);let buffer='';socket.once('connect',()=>socket.write(JSON.stringify({jsonrpc:'2.0',id,method,params:{token:process.env.STILL_TODO_TOKEN,...params}})+'\\n'));socket.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line)continue;const frame=JSON.parse(line);if(frame.id===id){socket.end();resolve(frame)}}});socket.once('error',reject);});}
const input = readline.createInterface({input:process.stdin});
input.on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')write({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentInfo:{name:'Fixture agent'}}});
  else if(m.method==='session/new')write({jsonrpc:'2.0',id:m.id,result:{sessionId:'server-session',configOptions:[{id:'model',name:'Model',type:'select',currentValue:'a',options:[{value:'a',name:'A'},{value:'b',name:'B'}]}],receivedMcpServers:m.params?.mcpServers||[],fixtureTodoRoute:{socket:process.env.STILL_TODO_SOCKET,token:process.env.STILL_TODO_TOKEN}}});
 else if(m.method==='session/set_config_option')write({jsonrpc:'2.0',id:m.id,result:{configOptions:[{id:'model',name:'Model',type:'select',currentValue:m.params.value,options:[{value:'a',name:'A'},{value:'b',name:'B'}]}]}});
 else if(m.method==='session/prompt'){
  write({jsonrpc:'2.0',method:'session/update',params:{sessionId:'server-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Started'}}}});
   if(m.params.prompt[0].text==='question')write({jsonrpc:'2.0',id:'question-1',method:'elicitation/create',params:{sessionId:'server-session',mode:'form',message:'Choose a branch',requestedSchema:{properties:{answer:{type:'string'}}}}});
   else if(m.params.prompt[0].text==='approval')write({jsonrpc:'2.0',id:'approval-1',method:'session/request_permission',params:{sessionId:'server-session',toolCall:{title:'Run checks'},options:[{optionId:'yes',name:'Allow once',kind:'allow_once'},{optionId:'no',name:'Reject',kind:'reject_once'}]}});
      else if(m.params.prompt[0].text.includes('tool-title'))void(async()=>{const changed=await todoRequest('title','_still/chat_title',{input:{title:'Improve Agents chat titles'}});write({jsonrpc:'2.0',id:m.id,result:{stopReason:changed.result.title==='Improve Agents chat titles'?'end_turn':'error'}})})();
      else if(m.params.prompt[0].text.includes('tool-todo'))void(async()=>{await todoRequest('ready','_still/todo_tool_ready',{});const list=await todoRequest('list','_still/todos',{input:{action:'list'},requestId:'agent:list:1'});const added=await todoRequest('add','_still/todos',{input:{action:'add',expectedRevision:list.result.todos.revision,title:'Model-authored task'},requestId:'agent:add:1'});const item=added.result.todos.items[0];const changed=await todoRequest('update','_still/todos',{input:{action:'update',expectedRevision:added.result.todos.revision,id:item.id,status:'completed'},requestId:'agent:update:1'});write({jsonrpc:'2.0',id:m.id,result:{stopReason:changed.result.todos.items[0].status==='completed'?'end_turn':'error'}})})();
     else setTimeout(()=>{write({jsonrpc:'2.0',method:'session/update',params:{sessionId:'server-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Finished while disconnected'}}}});write({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}})},120);
 } else if(!m.method&&['question-1','approval-1'].includes(m.id))write({jsonrpc:'2.0',method:'session/update',params:{sessionId:'server-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Answer received'}}}});
});
input.on('close',()=>process.exit(0));
`

// A Codex-shaped provider: it can report a structured plan and change settings,
// but it never acknowledges the Still Todo tool on its own.
const capabilityPeer = `
import readline from 'node:readline';
const write = frame => process.stdout.write(JSON.stringify(frame)+'\\n');
let model='a', session='cap-session';
const configs=()=>[{id:'model',name:'Model',type:'select',currentValue:model,options:[{value:'a',name:'A'},{value:'b',name:'B'}]}];
const input=readline.createInterface({input:process.stdin});
input.on('line',line=>{const m=JSON.parse(line);
 if(m.method==='initialize')write({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentInfo:{name:'Capability agent',version:'9.9.9'}}});
  else if(m.method==='session/new')write({jsonrpc:'2.0',id:m.id,result:{sessionId:session,configOptions:configs(),fixtureTodoRoute:{socket:process.env.STILL_TODO_SOCKET,token:process.env.STILL_TODO_TOKEN}}});
  else if(m.method==='session/load'){session=m.params?.sessionId||session;write({jsonrpc:'2.0',id:m.id,result:{sessionId:session,configOptions:configs()}});}
  else if(m.method==='session/set_config_option'){
    model=m.params.value;
    for(let count=0;count<2;count++)write({jsonrpc:'2.0',method:'session/update',params:{sessionId:session,update:{sessionUpdate:'config_option_update',configOptions:configs()}}});
    write({jsonrpc:'2.0',id:m.id,result:{configOptions:configs()}});
  }
  else if(m.method==='_still/session/revert'){session='forked-cap-session';write({jsonrpc:'2.0',id:m.id,result:{reverted:true,sessionId:session,configOptions:configs()}});}
 else if(m.method==='session/prompt'){
    if(m.params.prompt[0].text.includes('invalid-plan'))write({jsonrpc:'2.0',method:'session/update',params:{sessionId:session,update:{sessionUpdate:'plan',entries:[{content:'Not a valid status',status:'running'}]}}});
    else if(m.params.prompt[0].text.includes('plan'))write({jsonrpc:'2.0',method:'session/update',params:{sessionId:session,update:{sessionUpdate:'plan',entries:[{content:'Inspect the capability report',status:'pending'}]}}});
  write({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}});
 }
});
input.on('close',()=>process.exit(0));
`

function attach(config, mode = "attach") {
  const process = spawn(globalThis.process.execPath, [source,mode,Buffer.from(JSON.stringify(config)).toString("base64")], { stdio:["pipe","pipe","pipe"], env:{...globalThis.process.env,...(config.todoHome?{HOME:config.todoHome}:{})} })
  const frames = [], waiters = []
  let buffer = "", stderr = ""
  process.stderr.on("data",chunk=>{ stderr += chunk })
  process.stdout.on("data",chunk=>{
    buffer += chunk
    let end
    while((end=buffer.indexOf("\n"))>=0){ const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line)continue;const value=JSON.parse(line);frames.push(value);for(const waiter of [...waiters])if(waiter.test(value)){waiters.splice(waiters.indexOf(waiter),1);clearTimeout(waiter.timer);waiter.resolve(value)} }
  })
  const wait = predicate => {
    const found=frames.find(predicate);if(found)return Promise.resolve(found)
    return new Promise((resolve,reject)=>{const waiter={test:predicate,resolve,timer:setTimeout(()=>reject(new Error(`Timed out waiting for worker frame: ${stderr}`)),5000)};waiters.push(waiter)})
  }
  const send = value => process.stdin.write(JSON.stringify(value)+"\n")
  const close = () => new Promise(resolve => { if(process.exitCode!==null||process.signalCode!==null)return resolve();process.once("exit",resolve);process.kill("SIGTERM") })
  return { process,frames,wait,send,close,get stderr(){return stderr} }
}
async function initialize(client, resumeSessionId) {
  client.send({jsonrpc:"2.0",id:1,method:"initialize",params:{}})
  await client.wait(frame=>frame.id===1)
  client.send({jsonrpc:"2.0",id:3,method:resumeSessionId?"session/load":"session/new",params:{cwd:"/tmp",...(resumeSessionId?{sessionId:resumeSessionId}:{})}})
  return client.wait(frame=>frame.id===3)
}
async function fixture(fn) {
  const directory=await mkdtemp("/tmp/opencode/still-worker-")
  const todoHome=directory+"/home";await mkdir(todoHome,{recursive:true})
  const config={directory,executionId:"agent-fixture",cwd:directory,command:[process.execPath,"--input-type=module","-e",peer],create:true,todoHome}
  const clients=[]
  const make=(extra={})=>{const client=attach({...config,...extra});clients.push(client);return client}
  try{await fn({config,make,directory})}
  finally{
    for(const client of clients)await client.close()
    try{
      const shutdown=attach({...config,create:false},"stop")
      await shutdown.wait(frame=>frame.id==="close")
      await shutdown.close()
    }catch{
      try{const state=JSON.parse(await readFile(directory+"/state.json","utf8"));if(state.pid)process.kill(-state.pid,"SIGTERM")}catch{}
    }
    await rm(directory,{recursive:true,force:true})
  }
}
async function waitForRemoved(path) {
  for (let attempt=0; attempt<200; attempt++) {
    try { await stat(path) } catch (error) { if (error.code === "ENOENT") return; throw error }
    await new Promise(resolve=>setTimeout(resolve,25))
  }
  throw new Error(`Timed out waiting for owned lock removal: ${path}`)
}

test("remote worker survives transport death and replays offline output without resubmitting",{timeout:15000},()=>fixture(async({make,directory})=>{
  const first=make();const session=await initialize(first)
  assert.equal(session.result._meta.persistent,true)
  first.send({jsonrpc:"2.0",id:101,method:"session/prompt",params:{sessionId:"server-session",prompt:[{type:"text",text:"build"}],_meta:{messageId:"message-1"}}})
  const started=await first.wait(frame=>frame.params?.update?.content?.text==="Started")
  first.send({jsonrpc:"2.0",id:102,method:"_still/status",params:{}})
  const active=await first.wait(frame=>frame.id===102)
  assert.deepEqual(active.result,{busy:true,activePrompt:101})
  const original=JSON.parse(await readFile(directory+"/state.json","utf8"))
  await first.close()
  // No client exists while the provider finishes: equivalent to the local app
  // being gone, rather than a second client already listening to live output.
  await new Promise(resolve=>setTimeout(resolve,180))
  const second=make({create:false,after:started._still.index})
  const restored=await initialize(second)
  assert.equal(restored.result._meta.busy,false)
  assert.equal(restored.result._meta.maxRequestId,102)
  const finished=await second.wait(frame=>frame.params?.update?.content?.text==="Finished while disconnected")
  assert.ok(finished._still.index>started._still.index)
  await second.wait(frame=>frame.id===101&&frame.result?.stopReason==="end_turn")
  second.send({jsonrpc:"2.0",id:103,method:"_still/status",params:{}})
  assert.deepEqual((await second.wait(frame=>frame.id===103)).result,{busy:false,activePrompt:null})
  const current=JSON.parse(await readFile(directory+"/state.json","utf8"))
  assert.equal(current.pid,original.pid);assert.equal(current.childPid,original.childPid)
  second.send({jsonrpc:"2.0",id:102,method:"session/prompt",params:{sessionId:"server-session",prompt:[{type:"text",text:"build"}],_meta:{messageId:"message-1"}}})
  assert.match((await second.wait(frame=>frame.id===102)).error.message,/already submitted/)
}))

test("a pending question returns after reattach even when its original cursor was saved",{timeout:15000},()=>fixture(async({make})=>{
  const first=make();await initialize(first)
  first.send({jsonrpc:"2.0",id:101,method:"session/prompt",params:{prompt:[{type:"text",text:"question"}],_meta:{messageId:"question-prompt"}}})
  const question=await first.wait(frame=>frame.method==="elicitation/create")
  await first.close()
  const second=make({create:false,after:question._still.index});await initialize(second)
  const restored=await second.wait(frame=>frame.method==="elicitation/create")
  assert.equal(restored._still.pending,true)
  second.send({jsonrpc:"2.0",id:"question-1",result:{action:"accept",content:{answer:"main"}}})
  const ack=await second.wait(frame=>frame.method==="_still/request_outcome")
  assert.equal(ack.params.outcome,"answered")
  assert.equal(JSON.stringify(ack).includes('"main"'),false)
}))

test("permission is never auto-approved while detached and its response is acknowledged once",{timeout:15000},()=>fixture(async({make})=>{
  const first=make();await initialize(first)
  first.send({jsonrpc:"2.0",id:102,method:"session/prompt",params:{prompt:[{type:"text",text:"approval"}],_meta:{messageId:"approval-prompt"}}})
  const approval=await first.wait(frame=>frame.method==="session/request_permission")
  await first.close()
  const second=make({create:false,after:approval._still.index});await initialize(second)
  await second.wait(frame=>frame.method==="session/request_permission")
  assert.equal(second.frames.some(frame=>frame.method==="_still/request_outcome"),false)
  second.send({jsonrpc:"2.0",id:"approval-1",result:{outcome:{outcome:"selected",optionId:"no"}}})
  const outcome=await second.wait(frame=>frame.method==="_still/request_outcome")
  assert.equal(outcome.params.outcome,"rejected")
  second.send({jsonrpc:"2.0",id:"approval-1",result:{outcome:{outcome:"selected",optionId:"yes"}}})
  assert.match((await second.wait(frame=>frame.id==="approval-1"&&frame.error)).error.message,/already been answered/)
  assert.equal(second.frames.filter(frame=>frame.method==="_still/request_outcome").length,1)
}))

test("conversation todos use revision checks, stable IDs, and recover from durable worker storage", async()=>{
  const directory=await mkdtemp("/tmp/opencode/still-todo-store-")
  try {
    const file=directory+"/todos.json", store=createTodoStore(file)
    const first=store.apply({action:"list"},"agent")
    assert.deepEqual(first,{revision:0,items:[]})
    const added=store.apply({action:"add",expectedRevision:0,title:"Inspect the reconnect path"},"agent","agent:1")
    assert.equal(added.revision,1)
    const item=added.items[0]
    assert.match(item.id,/^[0-9a-f-]{36}$/)
    assert.equal(item.createdBy,"agent")
    assert.deepEqual(store.apply({action:"add",expectedRevision:0,title:"Inspect the reconnect path"},"agent","agent:1"),added)
    assert.throws(()=>store.apply({action:"update",expectedRevision:0,id:item.id,status:"completed"},"agent","agent:3"),/changed/)
    assert.throws(()=>store.apply({action:"add",expectedRevision:1,title:"different"},"agent","agent:1"),/already used/)
    const moved=store.apply({action:"add",expectedRevision:1,title:"Run checks"},"agent","agent:4")
    const updated=store.apply({action:"update",expectedRevision:2,id:item.id,status:"completed"},"agent","agent:5")
    assert.equal(updated.items[0].updatedBy,"agent")
    assert.equal(updated.activeId,moved.items[1].id)
    assert.ok(updated.items[0].durationMs>=0)
    const focused=store.apply({action:"focus",expectedRevision:3,id:moved.items[1].id,detail:"Running the focused checks"},"agent","agent:focus")
    assert.equal(focused.activeId,moved.items[1].id)
    assert.equal(focused.items[1].detail,"Running the focused checks")
    const reordered=store.apply({action:"move",expectedRevision:4,id:item.id,beforeId:null},"agent","agent:6")
    assert.deepEqual(reordered.items.map(({title})=>title),["Run checks","Inspect the reconnect path"])
    const removed=store.apply({action:"remove",expectedRevision:5,id:moved.items[1].id},"agent","agent:7")
    assert.deepEqual(createTodoStore(file).snapshot(),removed)
  } finally { await rm(directory,{recursive:true,force:true}) }
})

test("replacement executions resolve one bounded private todo store per conversation",()=>{
  const first=todoStorePath("/home/fixture","conversation-1")
  assert.equal(todoStorePath("/home/fixture","conversation-1"),first)
  assert.notEqual(todoStorePath("/home/fixture","conversation-2"),first)
  assert.ok(first.startsWith("/home/fixture/.local/state/still/agent-todos/"))
  assert.throws(()=>todoStorePath("/home/fixture","../another-conversation".repeat(30)),/Invalid todo storage identity/)
})

test("conversation Todo owner locks are exclusive, inspectable, and only remove their own inode",async()=>{
  const directory=await mkdtemp("/tmp/opencode/still-todo-owner-")
  const lockPath=join(directory,"owner.lock")
  try {
    const first=acquireTodoOwner(directory,"execution-one",101)
    assert.deepEqual(JSON.parse(await readFile(lockPath,"utf8")),{executionId:"execution-one",pid:101})
    assert.equal((await stat(lockPath)).mode&0o777,0o600)
    assert.throws(()=>acquireTodoOwner(directory,"execution-two",202),/execution-one.*PID 101/)
    await rename(lockPath,join(directory,"old-owner.lock"))
    await writeFile(lockPath,JSON.stringify({executionId:"foreign-owner",pid:303}),{mode:0o600,flag:"wx"})
    first.release()
    assert.equal(JSON.parse(await readFile(lockPath,"utf8")).executionId,"foreign-owner","cleanup must not unlink a replaced owner's lock")

    await unlink(lockPath)
    const second=acquireTodoOwner(directory,"execution-two",202)
    second.release()
    await assert.rejects(stat(lockPath),{code:"ENOENT"})
    await writeFile(lockPath,JSON.stringify({executionId:"stale-owner",pid:2_000_000_000}),{mode:0o600,flag:"wx"})
    assert.throws(()=>acquireTodoOwner(directory,"execution-three",303),/stale-owner/)
    assert.equal(JSON.parse(await readFile(lockPath,"utf8")).executionId,"stale-owner","stale locks require explicit recovery, not PID-based reaping")
  } finally { await rm(directory,{recursive:true,force:true}) }
})

test("a validated Todo seed initializes only a missing store and never overwrites conflicts",async()=>{
  const directory=await mkdtemp("/tmp/opencode/still-todo-seed-store-")
  const file=join(directory,"todos.json"), corrupt=join(directory,"corrupt.json")
  const seed={revision:2,activeId:"seed-task",items:[{id:"seed-task",title:"Restore the shared list",status:"pending",createdBy:"agent",updatedBy:"agent",createdAt:1,startedAt:2}]}
  try {
    const created=createTodoStore(file,seed)
    assert.deepEqual(created.snapshot(),seed)
    created.apply({action:"add",expectedRevision:2,title:"Continue the existing work"},"agent","agent:continue")
    const before=await readFile(file,"utf8")
    assert.equal(createTodoStore(file,seed).snapshot().revision,3,"a newer valid remote store wins over an older seed")
    for (const conflicting of [
      {...seed,revision:4},
      {...seed,revision:3,items:[{...seed.items[0],title:"Different content at the same revision"}]},
    ]) {
      assert.throws(()=>createTodoStore(file,conflicting),/Saved and remote Todo lists conflict/)
      assert.equal(await readFile(file,"utf8"),before,"conflict detection must not overwrite remote evidence")
    }
    await writeFile(corrupt,"not-json",{flag:"wx",mode:0o600})
    assert.throws(()=>createTodoStore(corrupt,seed))
    assert.equal(await readFile(corrupt,"utf8"),"not-json","corrupt originals are retained")
  } finally { await rm(directory,{recursive:true,force:true}) }
})

test("supervisor consumes the private seed for a missing conversation store",{timeout:15000},()=>fixture(async({make,config,directory})=>{
  const conversationId="conversation-with-seed"
  const seedPath=join(directory,"todo-seed.json")
  const seed={revision:7,activeId:"restored-task-0",items:Array.from({length:100},(_,index)=>({id:`restored-task-${index}`,title:"😀".repeat(500),detail:"🧭".repeat(500),status:"pending",createdBy:"agent",updatedBy:"agent",createdAt:10,startedAt:20}))}
  assert.ok(Buffer.byteLength(JSON.stringify(seed))>128*1024)
  await writeFile(seedPath,JSON.stringify(seed),{flag:"wx",mode:0o600})
  const client=make({conversationId,hasTodoSeed:true})
  const session=await initialize(client)
  assert.equal(session.result._meta.todos.revision,7)
  assert.equal(session.result._meta.todos.items.length,100)
  assert.equal(session.result._meta.todos.items[0].title,seed.items[0].title)
  assert.equal(session.result._meta.todos.items[0].detail,seed.items[0].detail)
  assert.equal(session.result._meta.todos.activeId,"restored-task-0")
  assert.equal(session.result._meta.todos.toolAvailable,false,"seed readiness is recomputed for the new execution")
  const list=await requestTodos(session.result.fixtureTodoRoute,{action:"list"},"large-seed:list")
  assert.equal(list.items.length,100,"the authenticated tool can read the recovered maximal list without a frame overflow")
  await assert.rejects(stat(seedPath),{code:"ENOENT"},"successful recovery removes the seed copy")
  const ownerPath=join(dirname(todoStorePath(config.todoHome,conversationId)),"owner.lock")
  assert.equal(JSON.parse(await readFile(ownerPath,"utf8")).executionId,config.executionId)
}))

test("a failed seed reconciliation releases only its owner lock and preserves both lists",{timeout:15000},async()=>{
  const root=await mkdtemp("/tmp/opencode/still-seed-conflict-")
  const home=join(root,"home"),directory=join(root,"execution")
  await mkdir(home,{recursive:true});await mkdir(directory,{recursive:true})
  const conversationId="seed-conflict-conversation",todoFile=todoStorePath(home,conversationId),todoDirectory=dirname(todoFile)
  await mkdir(todoDirectory,{recursive:true})
  const remote={revision:5,items:[{id:"remote-task",title:"Keep the remote history",status:"pending",createdBy:"agent",updatedBy:"agent",createdAt:1,startedAt:2}]}
  createTodoStore(todoFile,remote)
  const seed={revision:6,items:[{id:"seed-task",title:"Different native history",status:"pending",createdBy:"agent",updatedBy:"agent",createdAt:3,startedAt:4}]}
  const seedPath=join(directory,"todo-seed.json")
  await writeFile(seedPath,JSON.stringify(seed),{mode:0o600,flag:"wx"})
  const config={directory,executionId:"agent-seed-conflict",conversationId,agentId:"pi",cwd:root,command:[process.execPath,"--input-type=module","-e",peer],create:true,hasTodoSeed:true}
  const child=spawn(process.execPath,[source,"worker",Buffer.from(JSON.stringify(config)).toString("base64")],{env:{...process.env,HOME:home},stdio:["ignore","ignore","pipe"]})
  let stderr="";child.stderr.setEncoding("utf8").on("data",chunk=>{stderr+=chunk})
  try {
    const [code]=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill("SIGTERM");reject(new Error("Conflicting Todo seed did not fail promptly"))},5000);child.once("error",reject);child.once("close",(status)=>{clearTimeout(timer);resolve([status])})})
    assert.notEqual(code,0)
    assert.match(stderr,/Saved and remote Todo lists conflict/)
    const ownerPath=join(todoDirectory,"owner.lock")
    await assert.rejects(stat(ownerPath),{code:"ENOENT"},"early worker failure releases the lock it acquired")
    const preserved=JSON.parse(await readFile(todoFile,"utf8"))
    assert.equal(preserved.revision,5)
    assert.equal(preserved.items[0].title,"Keep the remote history")
    assert.deepEqual(JSON.parse(await readFile(seedPath,"utf8")),seed,"failed seed evidence remains for explicit inspection")
  } finally { await rm(root,{recursive:true,force:true}) }
})

test("upgraded workers cannot write one conversation store concurrently, then recover after provider exit",{timeout:30000},()=>fixture(async({make,config,directory})=>{
  const conversationId="shared-owner-conversation"
  const first=make({conversationId})
  const originalSession=await initialize(first)
  first.send({jsonrpc:"2.0",id:801,method:"session/prompt",params:{sessionId:"server-session",prompt:[{type:"text",text:"tool-todo"}],_meta:{messageId:"owner-seed-todo"}}})
  await first.wait(frame=>frame.id===801)
  const todoFile=todoStorePath(config.todoHome,conversationId)
  const ownerPath=join(dirname(todoFile),"owner.lock")
  const before=await readFile(todoFile,"utf8")
  assert.equal(JSON.parse(await readFile(ownerPath,"utf8")).executionId,config.executionId)

  const conflictConfig={...config,directory:join(directory,"conflicting-execution"),executionId:"agent-conflicting",conversationId}
  const conflict=spawn(process.execPath,[source,"worker",Buffer.from(JSON.stringify(conflictConfig)).toString("base64")],{env:{...process.env,HOME:config.todoHome},stdio:["ignore","ignore","pipe"]})
  let stderr="";conflict.stderr.setEncoding("utf8").on("data",chunk=>{stderr+=chunk})
  const [conflictCode]=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{conflict.kill("SIGTERM");reject(new Error("Conflicting worker did not fail promptly"))},5000);conflict.once("error",reject);conflict.once("exit",code=>{clearTimeout(timeout);resolve([code])})})
  assert.notEqual(conflictCode,0)
  assert.match(stderr,/Conversation Todos are owned by execution agent-fixture/)
  assert.equal(await readFile(todoFile,"utf8"),before,"the rejected worker must not touch the shared store")

  const workerState=JSON.parse(await readFile(join(config.directory,"state.json"),"utf8"))
  assert.ok(workerState.childPid)
  process.kill(workerState.childPid,"SIGTERM")
  await waitForRemoved(ownerPath)

  const recoveredConfig={...config,directory:join(directory,"recovered-execution"),executionId:"agent-recovered",conversationId}
  const recovered=attach(recoveredConfig)
  try {
    const session=await initialize(recovered)
    assert.equal(session.result._meta.todos.revision,2)
    assert.equal(session.result._meta.todos.items[0].title,"Model-authored task")
    assert.equal(JSON.parse(await readFile(ownerPath,"utf8")).executionId,"agent-recovered")
    const committed=await readFile(todoFile,"utf8")
    await assert.rejects(requestTodos(originalSession.result.fixtureTodoRoute,{action:"add",expectedRevision:2,title:"Must not reach the new owner"},"retired:request"),/no longer owns/)
    assert.equal(await readFile(todoFile,"utf8"),committed,"even an authenticated leftover tool cannot mutate after its execution retires")
  } finally {
    const stop=attach(recoveredConfig,"stop")
    try { await stop.wait(frame=>frame.id==="close") } finally { await stop.close(); await recovered.close() }
  }
}))

test("a clean shutdown releases Todo ownership before a provider has ever been started",{timeout:15000},()=>fixture(async({make,config})=>{
  const first=make()
  const ownerPath=join(dirname(todoStorePath(config.todoHome,config.executionId)),"owner.lock")
  for(let retry=0;retry<100;retry++){
    try{await stat(ownerPath);break}catch(error){if(error.code!=="ENOENT")throw error}
    await new Promise(resolve=>setTimeout(resolve,25))
  }
  assert.equal(JSON.parse(await readFile(ownerPath,"utf8")).executionId,config.executionId)
  const stop=attach({...config,create:false},"stop")
  try {await stop.wait(frame=>frame.id==="close");await waitForRemoved(ownerPath)}
  finally {await stop.close();await first.close()}
}))

test("only the authenticated agent tool can change the revisioned conversation todo list",{timeout:15000},()=>fixture(async({make})=>{
  const client=make();await initialize(client)
  client.send({jsonrpc:"2.0",id:301,method:"_still/todos",params:{requestId:"forged-ui:301",input:{action:"list"}}})
  assert.match((await client.wait(frame=>frame.id===301&&frame.error)).error.message,/Only the registered agent todo tool/)
  client.send({jsonrpc:"2.0",id:303,method:"session/prompt",params:{sessionId:"server-session",prompt:[{type:"text",text:"tool-todo"}],_meta:{messageId:"tool-todo-prompt"}}})
  const changed=await client.wait(frame=>frame.method==="_still/todos_changed"&&frame.params.todos.revision===2)
  assert.equal(changed.params.todos.items[0].title,"Model-authored task")
  assert.equal(changed.params.todos.items[0].status,"completed")
  assert.equal(changed.params.todos.items[0].updatedBy,"agent")
  assert.equal(changed.params.todos.items[0].createdBy,"agent")
  const updated=await client.wait(frame=>frame.id===303&&frame.result?.stopReason==="end_turn")
  assert.equal(updated.result.stopReason,"end_turn")
}))

test("first prompt receives one title instruction and the authenticated title tool publishes the title",{timeout:15000},()=>fixture(async({make,directory})=>{
  const client=make({agentId:"pi"})
  await initialize(client)
  client.send({jsonrpc:"2.0",id:601,method:"session/prompt",params:{prompt:[{type:"text",text:"tool-title"}],_meta:{messageId:"title-first"}}})
  const changed=await client.wait(frame=>frame.method==="_still/chat_title_changed")
  assert.equal(changed.params.title,"Improve Agents chat titles")
  assert.ok(await readFile(join(directory,"chat-title-prompted")))
  await client.wait(frame=>frame.id===601)
  client.send({jsonrpc:"2.0",id:602,method:"session/prompt",params:{prompt:[{type:"text",text:"second ordinary prompt"}],_meta:{messageId:"title-second"}}})
  await client.wait(frame=>frame.id===602)
  assert.equal(client.frames.filter(frame=>frame.method==="_still/chat_title_changed").length,1)
}))

test("Gemini ACP session setup receives Still's private stdio todo server",{timeout:15000},()=>fixture(async({make,config})=>{
  config.agentId="gemini"
  const client=make(),session=await initialize(client)
  const server=session.result.receivedMcpServers.find(value=>value.name==="still-todos")
  assert.equal(server.command,process.execPath)
  assert.equal(server.args.at(-1),"mcp")
  assert.deepEqual(server.env.map(({name})=>name),["STILL_TODO_SOCKET","STILL_TODO_TOKEN"])
}))

test("capabilities publish at session setup, after a real Todo call, and replay on reattach",{timeout:15000},()=>fixture(async({make})=>{
  const first=make({agentId:"pi",providerRuntime:{transport:"pi-rpc",executable:"/usr/bin/pi",version:"0.9.1",versionSource:"executable",versionObservedAt:1234}})
  const session=await initialize(first),initial=session.result._meta.capabilities
  assert.equal(initial.schemaVersion,1)
  assert.equal(initial.executionId,"agent-fixture")
  assert.equal(initial.agentSessionId,"server-session")
  assert.equal(initial.configGeneration,0)
  assert.equal(initial.providerRuntime.transport,"pi-rpc")
  assert.equal(initial.providerRuntime.version,"0.9.1")
  assert.deepEqual(initial.features.sharedTodos.status,"unverified", "a configured tool is not a connected one")
  assert.equal(initial.features.sharedTodos.evidence,undefined)
  assert.equal(initial.features.providerPlans.status,"unsupported")
  assert.equal(initial.features.providerPlans.evidence,"adapter")
  assert.equal(initial.features.providerTaskProjection.status,"unsupported")
  assert.equal(initial.features.providerTaskProjection.evidence,"adapter")
  assert.equal(initial.features.clientTodoWrite.status,"unsupported")
  assert.equal(initial.features.clientTodoWrite.evidence,"adapter")
  assert.equal(session.result._meta.todos.toolAvailable,false)

  first.send({jsonrpc:"2.0",id:401,method:"session/prompt",params:{sessionId:"server-session",prompt:[{type:"text",text:"tool-todo"}],_meta:{messageId:"capability-todo"}}})
  const advertised=await first.wait(frame=>frame.method==="_still/capabilities_changed"&&frame.params.capabilities.features.sharedTodos.evidence==="advertised")
  assert.equal(advertised.params.capabilities.features.sharedTodos.status,"supported")
  const observed=await first.wait(frame=>frame.method==="_still/capabilities_changed"&&frame.params.capabilities.features.sharedTodos.evidence==="observed")
  assert.equal(observed.params.capabilities.features.sharedTodos.status,"supported")
  assert.equal(observed.params.capabilities.configGeneration,0)
  assert.ok(observed._still.index>advertised._still.index)
  assert.equal(first.frames.filter(frame=>frame.method==="_still/capabilities_changed").length,2,"registration and the accepted call are distinct evidence")

  // A lost reply still replays the report with the rest of the journal.
  await first.close()
  const second=make({create:false,after:0})
  const restored=await initialize(second)
  assert.equal(restored.result._meta.capabilities.features.sharedTodos.evidence,"observed")
  const replayed=await second.wait(frame=>frame.method==="_still/capabilities_changed")
  assert.equal(replayed.params.capabilities.configGeneration,0)
  const caught=await second.wait(frame=>frame.method==="_still/caught_up")
  assert.equal(caught.params.capabilities.features.sharedTodos.evidence,"observed")
}))

test("a config generation clears observed evidence once and keeps execution-scoped registration",{timeout:15000},()=>fixture(async({make})=>{
  const client=make({agentId:"codex",command:[process.execPath,"--input-type=module","-e",capabilityPeer],providerRuntime:{transport:"codex-app-server",executable:"/usr/bin/codex"}})
  const first=await initialize(client)
  assert.equal(first.result._meta.capabilities.features.providerPlans.status,"unverified")
  assert.equal(first.result._meta.capabilities.providerRuntime.version,undefined,"an unreported version stays absent")

  client.send({jsonrpc:"2.0",id:500,method:"session/prompt",params:{prompt:[{type:"text",text:"invalid-plan"}],_meta:{messageId:"invalid-plan"}}})
  await client.wait(frame=>frame.id===500)
  assert.equal(client.frames.filter(frame=>frame.method==="_still/capabilities_changed").length,0,"malformed plans are not evidence")
  await requestTodos(first.result.fixtureTodoRoute,{action:"list"},"config-evidence:list")
  const called=await client.wait(frame=>frame.method==="_still/capabilities_changed"&&frame.params.capabilities.features.sharedTodos.evidence==="observed")
  assert.equal(called.params.capabilities.configGeneration,0)

  client.send({jsonrpc:"2.0",id:501,method:"session/prompt",params:{prompt:[{type:"text",text:"plan"}],_meta:{messageId:"capability-plan"}}})
  const planned=await client.wait(frame=>frame.method==="_still/capabilities_changed"&&frame.params.capabilities.features.providerPlans.evidence==="observed")
  assert.equal(planned.params.capabilities.features.providerPlans.status,"supported")
  assert.equal(planned.params.capabilities.configGeneration,0)
  await client.wait(frame=>frame.id===501)

  client.send({jsonrpc:"2.0",id:502,method:"session/set_config_option",params:{sessionId:"cap-session",configId:"model",value:"b"}})
  const changed=await client.wait(frame=>frame.method==="_still/capabilities_changed"&&frame.params.capabilities.configGeneration===1)
  assert.equal(changed.params.capabilities.features.providerPlans.status,"unverified","a plan from the previous generation cannot vouch for this one")
  assert.equal(changed.params.capabilities.features.sharedTodos.status,"supported")
  assert.equal(changed.params.capabilities.features.sharedTodos.evidence,"advertised","execution-scoped registration survives, but the previous model's call does not")
  const before=client.frames.filter(frame=>frame.method==="_still/capabilities_changed").length

  // The provider notification and the response acknowledgement describe one change.
  client.send({jsonrpc:"2.0",id:503,method:"session/set_config_option",params:{sessionId:"cap-session",configId:"model",value:"b"}})
  await client.wait(frame=>frame.id===503)
  assert.equal(client.frames.filter(frame=>frame.method==="_still/capabilities_changed").length,before,"unchanged settings do not start a generation")
  const latest=client.frames.filter(frame=>frame.method==="_still/capabilities_changed").at(-1).params.capabilities
  assert.equal(latest.configGeneration,1)

  client.send({jsonrpc:"2.0",id:504,method:"session/set_config_option",params:{sessionId:"cap-session",configId:"model",value:"a"}})
  const again=await client.wait(frame=>frame.method==="_still/capabilities_changed"&&frame.params.capabilities.configGeneration===2)
  assert.equal(again.params.capabilities.features.providerPlans.status,"unverified")
}))

test("failed authenticated Todo requests do not establish observed evidence",{timeout:15000},()=>fixture(async({make})=>{
  const client=make({agentId:"pi"}),session=await initialize(client)
  await assert.rejects(requestTodos(session.result.fixtureTodoRoute,{action:"update",expectedRevision:0,id:"missing",status:"completed"},"failed-evidence:update"),/no longer exists/)
  assert.equal(client.frames.filter(frame=>frame.method==="_still/capabilities_changed").length,0)
  const list=await requestTodos(session.result.fixtureTodoRoute,{action:"list"},"successful-evidence:list")
  assert.equal(list.toolAvailable,true,"a successful invocation itself confirms the registered route")
  const observed=await client.wait(frame=>frame.method==="_still/capabilities_changed"&&frame.params.capabilities.features.sharedTodos.evidence==="observed")
  assert.equal(observed.params.capabilities.features.sharedTodos.status,"supported")
}))

test("provider-session changes rescope capabilities without inheriting old call evidence or rewinding Todos",{timeout:15000},()=>fixture(async({make})=>{
  const client=make({agentId:"pi",command:[process.execPath,"--input-type=module","-e",capabilityPeer]}),session=await initialize(client)
  const list=await requestTodos(session.result.fixtureTodoRoute,{action:"add",expectedRevision:0,title:"Keep current shared tasks"},"fork-evidence:add")
  await client.wait(frame=>frame.method==="_still/capabilities_changed"&&frame.params.capabilities.features.sharedTodos.evidence==="observed")
  client.send({jsonrpc:"2.0",id:701,method:"_still/session/revert",params:{sessionId:"cap-session",checkpoint:{}},_meta:{messageId:"history-boundary"}})
  const fork=await client.wait(frame=>frame.method==="_still/capabilities_changed"&&frame.params.capabilities.agentSessionId==="forked-cap-session")
  assert.equal(fork.params.capabilities.features.sharedTodos.evidence,"advertised")
  assert.equal(fork.params.capabilities.configGeneration,0)
  const kept=await requestTodos(session.result.fixtureTodoRoute,{action:"list"},"fork-evidence:reread")
  assert.equal(kept.revision,list.revision)
  assert.deepEqual(kept.items,list.items)
  const newCall=await client.wait(frame=>frame.method==="_still/capabilities_changed"&&frame.params.capabilities.agentSessionId==="forked-cap-session"&&frame.params.capabilities.features.sharedTodos.evidence==="observed")
  assert.ok(newCall._still.index>fork._still.index)
}))

test("an adapter outside the plan integration cannot promote providerPlans",{timeout:15000},()=>fixture(async({make})=>{
  const client=make({agentId:"pi",command:[process.execPath,"--input-type=module","-e",capabilityPeer],providerRuntime:{transport:"pi-rpc"}})
  const session=await initialize(client)
  assert.equal(session.result._meta.capabilities.features.providerPlans.status,"unsupported")
  client.send({jsonrpc:"2.0",id:601,method:"session/prompt",params:{prompt:[{type:"text",text:"plan"}],_meta:{messageId:"pi-plan"}}})
  await client.wait(frame=>frame.id===601)
  assert.equal(client.frames.filter(frame=>frame.method==="_still/capabilities_changed").length,0)
}))

for (const resumed of [false,true]) test(`the real Codex wrapper ${resumed?"keeps resumed registration unverified":"advertises a newly accepted dynamic tool"}`,{timeout:15000},()=>fixture(async({make,directory})=>{
  const executable=join(directory,"codex-fixture")
  const providerPeer=fileURLToPath(new URL("./protocol-peer.mjs",import.meta.url))
  await writeFile(executable,`#!/bin/sh\nexec env -u STILL_AGENT_DRIVER -u STILL_AGENT_EXECUTABLE -u STILL_AGENT_CATALOG STILL_TEST_PEER=codex ${JSON.stringify(process.execPath)} ${JSON.stringify(providerPeer)} "$@"\n`,{mode:0o700})
  await writeFile(join(directory,"todos.mjs"),await readFile(new URL("../src-tauri/agent-host/todos.mjs",import.meta.url),"utf8"),{mode:0o600})
  const bridge=await readFile(new URL("../src-tauri/agent-host/bridge.mjs",import.meta.url),"utf8")
  const client=make({agentId:"codex",command:[process.execPath,"--input-type=module","-e",bridge],env:{STILL_AGENT_DRIVER:"codex",STILL_AGENT_EXECUTABLE:executable}})
  const session=await initialize(client,resumed?"thread-fixture":undefined)
  assert.equal(session.error,undefined)
  assert.equal(session.result._meta.todos.toolAvailable,!resumed)
  assert.equal(session.result._meta.capabilities.features.sharedTodos.status,resumed?"unverified":"supported")
  assert.equal(session.result._meta.capabilities.features.sharedTodos.evidence,resumed?undefined:"advertised")
}))

test("OpenCode accepting MCP configuration does not certify a connected tool",{timeout:15000},()=>fixture(async({make,directory})=>{
  const executable=join(directory,"opencode-fixture")
  const providerPeer=fileURLToPath(new URL("./protocol-peer.mjs",import.meta.url))
  await writeFile(executable,`#!/bin/sh\nexec env -u STILL_AGENT_DRIVER -u STILL_AGENT_EXECUTABLE -u STILL_AGENT_CATALOG STILL_TEST_PEER=opencode STILL_TEST_ACCEPT_MCP=1 ${JSON.stringify(process.execPath)} ${JSON.stringify(providerPeer)} "$@"\n`,{mode:0o700})
  await writeFile(join(directory,"todos.mjs"),await readFile(new URL("../src-tauri/agent-host/todos.mjs",import.meta.url),"utf8"),{mode:0o600})
  const bridge=await readFile(new URL("../src-tauri/agent-host/bridge.mjs",import.meta.url),"utf8")
  const client=make({agentId:"opencode",command:[process.execPath,"--input-type=module","-e",bridge],env:{STILL_AGENT_DRIVER:"opencode",STILL_AGENT_EXECUTABLE:executable}})
  const session=await initialize(client)
  assert.equal(session.error,undefined)
  const caught=await client.wait(frame=>frame.method==="_still/caught_up")
  assert.equal(caught.params.todos.toolAvailable,false)
  assert.equal(caught.params.capabilities.features.sharedTodos.status,"unverified")
  assert.equal(caught.params.capabilities.providerRuntime.version,"2.0.0")
  assert.equal(client.frames.some(frame=>frame.params?.update?.message?.includes("did not accept the tool configuration")),false,"the fixture accepted config but never connected the MCP server")
}))

test("legacy direct ACP model/mode settings advance evidence generation only after acknowledgement",{timeout:15000},()=>fixture(async({make})=>{
  const legacyPeer=`import readline from 'node:readline';
  let mode='ask',model='a';
  const write=frame=>process.stdout.write(JSON.stringify(frame)+'\\n');
  const input=readline.createInterface({input:process.stdin});
  input.on('line',line=>{const m=JSON.parse(line);
    if(m.method==='initialize')write({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentInfo:{name:'Gemini fixture',version:'fixture-version'}}});
    else if(m.method==='session/new')write({jsonrpc:'2.0',id:m.id,result:{sessionId:'legacy-session',modes:{currentModeId:mode,availableModes:[{id:'ask',name:'Ask'},{id:'code',name:'Code'}]},models:{currentModelId:model,availableModels:[{modelId:'a',name:'A'},{modelId:'b',name:'B'}]},fixtureTodoRoute:{socket:process.env.STILL_TODO_SOCKET,token:process.env.STILL_TODO_TOKEN}}});
    else if(m.method==='session/set_mode'){mode=m.params.modeId;write({jsonrpc:'2.0',method:'session/update',params:{sessionId:'legacy-session',update:{sessionUpdate:'current_mode_update',currentModeId:mode}}});write({jsonrpc:'2.0',id:m.id,result:{}})}
    else if(m.method==='session/set_model'){model=m.params.modelId;write({jsonrpc:'2.0',id:m.id,result:{}})}
  });input.on('close',()=>process.exit(0));`
  const client=make({agentId:"gemini",command:[process.execPath,"--input-type=module","-e",legacyPeer]})
  const session=await initialize(client)
  await requestTodos(session.result.fixtureTodoRoute,{action:"list"},"legacy-evidence:list")
  await client.wait(frame=>frame.method==="_still/capabilities_changed"&&frame.params.capabilities.features.sharedTodos.evidence==="observed")
  client.send({jsonrpc:"2.0",id:901,method:"session/set_mode",params:{sessionId:"legacy-session",modeId:"code"}})
  const mode=await client.wait(frame=>frame.method==="_still/capabilities_changed"&&frame.params.capabilities.configGeneration===1)
  assert.equal(mode.params.capabilities.features.sharedTodos.evidence,"advertised")
  await client.wait(frame=>frame.id===901)
  client.send({jsonrpc:"2.0",id:902,method:"session/set_model",params:{sessionId:"legacy-session",modelId:"b"}})
  await client.wait(frame=>frame.method==="_still/capabilities_changed"&&frame.params.capabilities.configGeneration===2)
  client.send({jsonrpc:"2.0",id:903,method:"session/set_model",params:{sessionId:"legacy-session",modelId:"b"}})
  await client.wait(frame=>frame.id===903)
  assert.equal(client.frames.filter(frame=>frame.method==="_still/capabilities_changed"&&frame.params.capabilities.configGeneration===2).length,1)
}))
