import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const source = fileURLToPath(new URL("../src-tauri/agent-host/supervisor.mjs", import.meta.url))
const peer = `
import readline from 'node:readline';
const write = frame => process.stdout.write(JSON.stringify(frame)+'\\n');
const input = readline.createInterface({input:process.stdin});
input.on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')write({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentInfo:{name:'Fixture agent'}}});
 else if(m.method==='session/new')write({jsonrpc:'2.0',id:m.id,result:{sessionId:'server-session',configOptions:[]}});
 else if(m.method==='session/prompt'){
  write({jsonrpc:'2.0',method:'session/update',params:{sessionId:'server-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Started'}}}});
  if(m.params.prompt[0].text==='question')write({jsonrpc:'2.0',id:'question-1',method:'elicitation/create',params:{sessionId:'server-session',mode:'form',message:'Choose a branch',requestedSchema:{properties:{answer:{type:'string'}}}}});
  else if(m.params.prompt[0].text==='approval')write({jsonrpc:'2.0',id:'approval-1',method:'session/request_permission',params:{sessionId:'server-session',toolCall:{title:'Run checks'},options:[{optionId:'yes',name:'Allow once',kind:'allow_once'},{optionId:'no',name:'Reject',kind:'reject_once'}]}});
  else setTimeout(()=>{write({jsonrpc:'2.0',method:'session/update',params:{sessionId:'server-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Finished while disconnected'}}}});write({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}})},120);
 } else if(!m.method&&['question-1','approval-1'].includes(m.id))write({jsonrpc:'2.0',method:'session/update',params:{sessionId:'server-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Answer received'}}}});
});
input.on('close',()=>process.exit(0));
`

function attach(config, mode = "attach") {
  const process = spawn(globalThis.process.execPath, [source,mode,Buffer.from(JSON.stringify(config)).toString("base64")], { stdio:["pipe","pipe","pipe"] })
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
async function initialize(client) {
  client.send({jsonrpc:"2.0",id:1,method:"initialize",params:{}})
  await client.wait(frame=>frame.id===1)
  client.send({jsonrpc:"2.0",id:3,method:"session/new",params:{cwd:"/tmp"}})
  return client.wait(frame=>frame.id===3)
}
async function fixture(fn) {
  const directory=await mkdtemp("/tmp/opencode/still-worker-")
  const config={directory,executionId:"agent-fixture",cwd:directory,command:[process.execPath,"--input-type=module","-e",peer],create:true}
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

test("remote worker survives transport death and replays offline output without resubmitting",{timeout:15000},()=>fixture(async({make,directory})=>{
  const first=make();const session=await initialize(first)
  assert.equal(session.result._meta.persistent,true)
  first.send({jsonrpc:"2.0",id:101,method:"session/prompt",params:{sessionId:"server-session",prompt:[{type:"text",text:"build"}],_meta:{messageId:"message-1"}}})
  const started=await first.wait(frame=>frame.params?.update?.content?.text==="Started")
  const original=JSON.parse(await readFile(directory+"/state.json","utf8"))
  await first.close()
  // No client exists while the provider finishes: equivalent to the local app
  // being gone, rather than a second client already listening to live output.
  await new Promise(resolve=>setTimeout(resolve,180))
  const second=make({create:false,after:started._still.index})
  const restored=await initialize(second)
  assert.equal(restored.result._meta.busy,false)
  assert.equal(restored.result._meta.maxRequestId,101)
  const finished=await second.wait(frame=>frame.params?.update?.content?.text==="Finished while disconnected")
  assert.ok(finished._still.index>started._still.index)
  await second.wait(frame=>frame.id===101&&frame.result?.stopReason==="end_turn")
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
