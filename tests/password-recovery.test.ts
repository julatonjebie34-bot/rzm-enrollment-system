import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function setup(options:{invalidCode?:boolean;sendError?:boolean;changeError?:boolean;signInError?:boolean}={}){
 const calls:any[]=[],stored=new Map<string,string>();
 let currentUrl=new URL('https://rzm-enrollment-system.vercel.app/');
 const location={get href(){return currentUrl.href},get pathname(){return currentUrl.pathname},get search(){return currentUrl.search},get hash(){return currentUrl.hash}};
 const client={auth:{
  resetPasswordForEmail:async(email:string,settings:any)=>{calls.push(['send',email,settings]);return {error:options.sendError?Error('network'):null}},
  verifyOtp:async(args:any)=>{calls.push(['verify',args,currentUrl.search]);return {error:options.invalidCode?Error('expired'):null,data:{session:options.invalidCode?null:{user:{id:'teacher'}}}}},
  getSession:async()=>({data:{session:{user:{email:'teacher@fixture.test'}}},error:null}),
  signInWithPassword:async(args:any)=>{calls.push(['signIn',args]);return {error:options.signInError?Error('network'):null,data:{session:options.signInError?null:{user:{id:'teacher'}}}}}
 }};
 const context=vm.createContext({exports:{},require:(name:string)=>name==='./lib'?{db:client}:{requireOnline:()=>{},staffAction:async(body:any,refresh:boolean)=>{calls.push(['change',body,refresh]);if(options.changeError)throw Error('Server rejected password');},refreshAcademic:async()=>{calls.push(['refresh']);}},URL,location,history:{replaceState:(_:any,__:any,url:string)=>{currentUrl=new URL(url,currentUrl)}},localStorage:{setItem:(k:string,v:string)=>stored.set(k,v)},Error});
 vm.runInContext(ts.transpileModule(readFileSync('src/password-recovery.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
 return {api:context.exports as any,calls,stored,url:()=>currentUrl};
}
test('email recovery uses Supabase recovery tokens and gates the portal before session creation',async()=>{
 const h=setup();await h.api.sendRecoveryCode(' teacher@fixture.test ');
 assert.equal(h.calls[0][1],'teacher@fixture.test');
 await h.api.verifyRecoveryCode(' teacher@fixture.test ','123 456');
 const verify=h.calls.find(c=>c[0]==='verify');assert.equal(verify[1].type,'recovery');assert.equal(verify[1].token,'123456');assert.equal(verify[2],'?reset-password=1');
 assert.equal(h.stored.get('rzm-offline-until'),'0');assert.ok(!JSON.stringify([...h.stored]).includes('123456'));
});
test('invalid, expired or undelivered recovery codes cannot advance the flow',async()=>{
 const invalid=setup({invalidCode:true});await assert.rejects(()=>invalid.api.verifyRecoveryCode('teacher@fixture.test','123456'),/invalid or expired/);assert.equal(invalid.url().search,'');
 const malformed=setup();await assert.rejects(()=>malformed.api.verifyRecoveryCode('teacher@fixture.test','wrong'),/numeric code/);assert.equal(malformed.calls.length,0);
 const failed=setup({sendError:true});await assert.rejects(()=>failed.api.sendRecoveryCode('teacher@fixture.test'),/Unable to send/);
});
test('password completion establishes a fresh authenticated session before refreshing staff permissions',async()=>{
 const h=setup();await h.api.changeStaffPassword('Synthetic-password-123');assert.equal(h.calls.map(c=>c[0]).join(','),'change,signIn,refresh');assert.equal(h.calls[0][2],false);assert.equal(h.calls[1][1].email,'teacher@fixture.test');assert.equal(h.stored.size,0);
 const rejected=setup({changeError:true});await assert.rejects(()=>rejected.api.changeStaffPassword('Synthetic-password-123'),/Server rejected/);assert.equal(rejected.calls.length,1);
 const disconnected=setup({signInError:true});await assert.rejects(()=>disconnected.api.changeStaffPassword('Synthetic-password-123'),/password was changed/);assert.equal(disconnected.calls.length,2);
 const weak=setup();await assert.rejects(()=>weak.api.changeStaffPassword('short'),/12–128/);assert.equal(weak.calls.length,0);
});
