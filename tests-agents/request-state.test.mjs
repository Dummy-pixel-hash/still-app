import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import ts from "typescript"

async function load(path) {
  const source=await readFile(new URL(path,import.meta.url),"utf8")
  const { outputText }=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2021}})
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`)
}
const { validateAnswers,questionFields,requestKey }=await load("../src/agents/requests.ts")
const { conversation }=await load("../src/agents/transcript.ts")

test("question validation keeps false and zero and omits empty optional values",()=>{
  const input={requestId:"q",title:"Question",schema:{properties:{number:{type:"integer",minimum:0},flag:{type:"boolean"},optional:{type:"string"}},required:["number","flag"]}}
  assert.deepEqual(validateAnswers(input,{number:0,flag:false,optional:""}),{value:{number:0,flag:false},errors:{},unsupported:false})
  assert.deepEqual(Object.keys(validateAnswers(input,{number:-1,flag:false}).errors),["number"])
})
test("arrays validate offered choices and selection limits",()=>{
  const input={requestId:"q",title:"Question",schema:{properties:{choices:{type:"array",items:{enum:["a","b","c"]},maxItems:2}},required:["choices"]}}
  assert.ok(validateAnswers(input,{choices:[]}).errors.choices)
  assert.ok(validateAnswers(input,{choices:["unoffered"]}).errors.choices)
  assert.ok(validateAnswers(input,{choices:["a","b","c"]}).errors.choices)
  assert.deepEqual(validateAnswers(input,{choices:["a","c"]}).value,{choices:["a","c"]})
})
test("unsupported or malformed schemas cannot submit guessed values",()=>{
  for(const schema of [null,{properties:{nested:{type:"object"}}},{properties:{when:{type:"string",format:"date"}}},{properties:{value:{type:"string"}},required:["missing"]}]){
    const input={requestId:"q",title:"Question",schema}
    assert.ok(questionFields(input).unsupported.length)
    assert.equal(validateAnswers(input,{}).unsupported,true)
  }
})
test("request keys separate provider execution and numeric/string ids",()=>{
  assert.notEqual(requestKey("one","question",1),requestKey("two","question",1))
  assert.notEqual(requestKey("one","question",1),requestKey("one","question","1"))
})
test("restored pending forms update their historical summary rather than duplicating it",()=>{
  const items=conversation([
    {sequence:1,attemptId:"one",type:"agentRequest",request:{requestId:"q",kind:"question",title:"Question"}},
    {sequence:2,attemptId:"one",type:"input",input:{requestId:"q",title:"Question",schema:{properties:{answer:{type:"string"}}}}},
    {sequence:3,attemptId:"one",type:"requestOutcome",requestOutcome:{requestId:"q",kind:"question",title:"Question",outcome:"answered"}},
  ])
  assert.equal(items.length,1)
  assert.ok(items[0].agentInput)
  assert.equal(items[0].requestOutcome.outcome,"answered")
})
test("a repeated id in another execution never resolves the older request",()=>{
  const items=conversation([
    {sequence:1,attemptId:"one",type:"agentRequest",request:{requestId:"q",kind:"question",title:"Old question"}},
    {sequence:1,attemptId:"two",type:"input",input:{requestId:"q",title:"New question",schema:{properties:{answer:{type:"string"}}}}},
    {sequence:2,attemptId:"two",type:"requestOutcome",requestOutcome:{requestId:"q",kind:"question",title:"New question",outcome:"answered"}},
  ])
  assert.equal(items.length,2)
  assert.equal(items[0].requestOutcome,undefined)
  assert.equal(items[1].requestOutcome.outcome,"answered")
})
