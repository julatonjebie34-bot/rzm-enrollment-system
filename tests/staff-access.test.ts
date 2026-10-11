import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function setup(profile:any){
 const audit:any[]=[],saved:any[]=[],authCalls:any[]=[];let handler:any;
 const client:any={auth:{getUser:async(token:string)=>({data:{user:token==='valid'?{id:'current'}:null}}),admin:{updateUserById:async(id:string,value:any)=>{authCalls.push({id,value});return {}},createUser:async(value:any)=>{authCalls.push({create:true,value});return {data:{user:{id:'new-teacher'}}}},deleteUser:async()=>({})}},from:(table:string)=>({select:()=>({eq:()=>({single:async()=>({data:profile})})}),update:(value:any)=>({eq:()=>{saved.push(value);Object.assign(profile,value);return {select:()=>({single:async()=>({data:{id:'current'}})}),then:(resolve:any)=>resolve({})}}}),insert:async(value:any)=>{(table==='audit_logs'?audit:saved).push(value);return {}}})};
 const context=vm.createContext({exports:{},require:()=>({createClient:()=>client}),Deno:{env:{get:(key:string)=>key==='ALLOWED_ORIGINS'?' https://rzm-enrollment-system.vercel.app ':''},serve:(fn:any)=>handler=fn},Response,Request,Error,JSON});
 vm.runInContext(ts.transpileModule(readFileSync('supabase/functions/manage-users/index.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
 const call=async(body:any,origin='https://rzm-enrollment-system.vercel.app',token='valid')=>{const response=await handler(new Request('http://fixture.test/functions/v1/manage-users',{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)}));return {status:response.status,body:await response.json(),origin:response.headers.get('Access-Control-Allow-Origin')}};
 return {call,audit,saved,authCalls};
}
test('staff endpoint validates token, exact origin, active account and administrator role',async()=>{
 const teacher={id:'current',role:'teacher',active:true,must_change_password:false};const h=setup(teacher);
 assert.equal((await h.call({},undefined,'invalid')).status,401);
 assert.equal((await h.call({},'https://untrusted-preview.vercel.app')).status,403);
 assert.equal((await h.call({action:'save',role:'admin',full_name:'Attempt'})).status,403);
 teacher.active=false;assert.equal((await h.call({action:'profile',phone:'123'})).status,403);assert.equal(h.saved.length,0);
});
test('temporary password gate only clears through the authenticated password operation',async()=>{
 const profile={id:'current',role:'teacher',active:true,must_change_password:true};const h=setup(profile);
 assert.equal((await h.call({action:'profile',phone:'123'})).status,403);
 assert.equal((await h.call({action:'change-password',password:'short'})).status,400);
 const password='Synthetic-password-123';assert.equal((await h.call({action:'change-password',password})).status,200);
 assert.equal(profile.must_change_password,false);assert.equal(profile.role,'teacher');assert.equal(h.authCalls[0].id,'current');
 assert.ok(!JSON.stringify(h.saved).includes(password));assert.ok(!JSON.stringify(h.audit).includes(password));
});
test('new staff accounts use Supabase Auth and force password change without storing passwords',async()=>{
 const h=setup({id:'current',role:'admin',active:true,must_change_password:false});const password='Synthetic-password-456';
 const result=await h.call({action:'save',email:'teacher@fixture.test',password,role:'teacher',can_grade:true,full_name:'Synthetic Teacher'});
 assert.equal(result.status,200);assert.equal(result.origin,'https://rzm-enrollment-system.vercel.app');
 assert.equal(h.saved[0].must_change_password,true);assert.equal(h.saved[0].active,true);assert.equal(h.saved[0].role,'teacher');
 assert.ok(!JSON.stringify(h.saved).includes(password));assert.ok(!JSON.stringify(h.audit).includes(password));
});
