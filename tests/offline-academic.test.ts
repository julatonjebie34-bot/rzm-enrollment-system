import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// In-memory storage adapter exercises the real queue code, without browser workers.
function harness(){
 const stores=Object.fromEntries(['records','queue','meta','logs','drafts'].map(s=>[s,new Map<string,any>()]));
 let online=false;let sessionOwner='teacher-a';let cloudVersion=0;let failOnce=false;let quota=false;const calls:any[]=[];
 const clone=(v:any)=>v===undefined?undefined:structuredClone(v);
 const local={uuid:()=>crypto.randomUUID(),all:async(s:string)=>[...stores[s].values()].map(clone),get:async(s:string,k:string)=>clone(stores[s].get(k)),put:async(s:string,v:any)=>{stores[s].set(v.key,clone(v))},request:async(v:any)=>v,
 transaction:async(names:string[],_mode:string,fn:any)=>{if(quota)throw Error('Storage quota exceeded');const temp=Object.fromEntries(names.map(n=>[n,new Map([...stores[n]].map(([k,v])=>[k,clone(v)]))]));const out=await fn({objectStore:(n:string)=>({get:(k:string)=>clone(temp[n].get(k)),getAll:()=>[...temp[n].values()].map(clone),put:(v:any)=>temp[n].set(v.key,clone(v)),delete:(k:string)=>temp[n].delete(k)})});for(const n of names)stores[n]=temp[n];return out;}};
 const db={auth:{getSession:async()=>({data:{session:{user:{id:sessionOwner}}}})},from:()=>({select:()=>({eq:()=>({single:async()=>({data:{id:sessionOwner,role:'teacher',active:false,must_change_password:false}})})})}),rpc:async(name:string,args:any)=>{calls.push({name,args});if(failOnce){failOnce=false;return {error:{message:'Temporary network failure'}}}if(args.expected_version!==(cloudVersion||null))return {data:{status:'conflict',record:{id:'cloud',sync_version:cloudVersion,status:'Submitted',entries:{student:90}}}};cloudVersion++;return {data:{status:'synced',record:{...args,id:'cloud',sync_version:cloudVersion,status:'Draft',entries:args.entries}}}}};
 const exports:any={};const context=vm.createContext({exports,require:(id:string)=>id==='./local-db'?local:{db,tables:['grade_submissions','profiles'],finalGrade:()=>null},EventTarget,Event,Date,Error,Set,Map,console,structuredClone,localStorage:{getItem:()=>null},navigator:{get onLine(){return online}},setInterval,clearInterval});
 const source=ts.transpileModule(readFileSync('src/offline.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;vm.runInContext(source,context);
 return {api:exports,stores,calls,setOnline:(v:boolean)=>online=v,setVersion:(v:number)=>cloudVersion=v,setOwner:(v:string)=>sessionOwner=v,failNext:()=>failOnce=true,setQuota:(v:boolean)=>quota=v};
}
const assignment={id:'assignment',section_id:'section',subject_id:'subject',teacher_id:'teacher-a'},period={id:'period'};
test('offline drafts retain order, retry safely and cannot approve offline',async()=>{
 const h=harness();await h.api.activate('teacher-a');
 await assert.rejects(()=>h.api.command('approve',{application:'application'}),/online server/);
 await h.api.saveGradeDraft(assignment,period,{student:80});let snapshot=await h.api.snapshot();let first=snapshot.grade_submissions[0];assert.equal(first.sync_version,1);
 await h.api.saveGradeDraft(assignment,period,{student:81},first);assert.equal(h.api.status.pending,2);
 h.setOnline(true);h.failNext();await h.api.sync(true);assert.equal(h.api.status.pending,2);const operation=h.calls[0].args.operation;
 await h.api.sync(true);assert.equal(h.api.status.pending,0);assert.equal(h.calls[1].args.operation,operation,'retry reuses idempotency UUID');assert.equal(h.calls.at(-1).args.expected_version,1);
 assert.equal(h.calls.every(c=>c.name==='grade_workflow'&&c.args.action==='save'),true);
});
test('stale drafts become conflicts; account switch does not send another account’s queue',async()=>{
 const h=harness();await h.api.activate('teacher-a');await h.api.saveGradeDraft(assignment,period,{student:80});h.setVersion(4);h.setOnline(true);await h.api.sync(true);
 assert.equal(h.api.status.conflicts.length,1);await assert.rejects(()=>h.api.resolveConflict(h.api.status.conflicts[0],true),/cannot overwrite/);
 const calls=h.calls.length;await h.api.activate('teacher-b');h.setOwner('teacher-b');await h.api.sync(true);assert.equal(h.calls.length,calls);assert.equal((await h.api.snapshot()).grade_submissions.length,0);
});
test('quota errors leave no partial queued grade and submitted grades cannot be edited',async()=>{
 const h=harness();await h.api.activate('teacher-a');h.setQuota(true);await assert.rejects(()=>h.api.saveGradeDraft(assignment,period,{student:80}),/quota/);assert.equal(h.stores.queue.size,0);assert.equal(h.stores.records.size,0);
 await assert.rejects(()=>h.api.saveGradeDraft(assignment,period,{student:80},{id:'submitted',status:'Submitted'}),/locked/);
 await assert.rejects(()=>h.api.save('grades',{id:'official',q1:99}),/Grade Encoding/);
});

test('autosave rejects stale local versions and duplicate new drafts without queuing changes',async()=>{
 const h=harness();await h.api.activate('teacher-a');
 const first=await h.api.saveGradeDraft(assignment,period,{student:80});
 const next=await h.api.saveGradeDraft(assignment,period,{student:81},first);
 assert.equal(next.sync_version,2);assert.equal(h.stores.queue.size,2);
 await assert.rejects(()=>h.api.saveGradeDraft(assignment,period,{student:99},first),/changed while/);
 await assert.rejects(()=>h.api.saveGradeDraft(assignment,period,{student:98}),/already exists/);
 assert.equal(h.stores.queue.size,2);assert.equal((await h.api.snapshot()).grade_submissions[0].entries.student,81);
});
