import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import vm from 'node:vm';
import ts from 'typescript';

test('School year deletion: authorization, linked records, stale versions, rollback and preserved setup',async()=>{
 const db=new PGlite(),admin=crypto.randomUUID(),teacher=crypto.randomUUID();
 const one=async(sql:string,args:any[]=[])=>((await db.query(sql,args)).rows[0] as any);
 const as=async(id:string)=>db.exec(`reset role;select set_config('request.jwt.claim.sub','${id}',false);set role authenticated;`);
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
   create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
   create table storage.objects(id uuid,bucket_id text);alter table storage.objects enable row level security;`);
  for(const f of ['001_school.sql','002_offline_sync.sql','003_enrollment_guide_lrn.sql','004_enrollment_details.sql','005_academic_portals.sql','006_section_assignment.sql','007_smart_advisers.sql','008_application_learner_identifier.sql'])await db.exec(readFileSync('supabase/migrations/'+f,'utf8'));
  // Match normal existing access before migration revokes direct year DELETE.
  await db.exec(`grant usage on schema public,auth to authenticated,anon;grant select on all tables in schema public to authenticated;
   grant insert,update,delete on school_years,sections,enrollment_links,subjects to authenticated;
   insert into auth.users values('${admin}'),('${teacher}');insert into profiles(id,full_name,role) values('${admin}','Admin','admin'),('${teacher}','Teacher','teacher');`);
  await db.exec(readFileSync('supabase/migrations/009_delete_unused_school_year.sql','utf8'));
  await as(admin);
  const year=async(name:string,active=false)=>one('insert into school_years(name,active) values($1,$2) returning *',[name,active]);
  const remove=async(y:any,version:any=y.sync_version)=>one('select delete_unused_school_year($1,$2) result',[y.id,version]);
  const active=await year('Active',true),empty=await year('Unused'),archived=await year('Archived');
  await db.query('update school_years set archived=true where id=$1',[archived.id]);
  await assert.rejects(()=>remove(active),/Deactivate/);
  await assert.rejects(()=>remove({...archived,sync_version:2}),/Archived/);
  await assert.rejects(()=>remove(empty,null),/changed/);
  await db.query("update school_years set name='Unused revised' where id=$1",[empty.id]);
  await assert.rejects(()=>remove(empty),/changed/);empty.sync_version=2;
  await as(teacher);await assert.rejects(()=>remove(empty),/Administrator/);
  await db.exec('reset role;set role anon');await assert.rejects(()=>remove(empty),/permission denied/);
  await db.exec('reset role');await db.query('update profiles set active=false where id=$1',[admin]);
  await as(admin);await assert.rejects(()=>remove(empty),/Administrator/);
  await db.exec('reset role');await db.query('update profiles set active=true,must_change_password=true where id=$1',[admin]);
  await as(admin);await assert.rejects(()=>remove(empty),/Administrator/);
  await db.exec('reset role');await db.query('update profiles set must_change_password=false where id=$1',[admin]);await as(admin);
  await assert.rejects(()=>db.query('delete from school_years where id=$1',[empty.id]),/permission denied/);
  await db.exec('reset role');await assert.rejects(()=>db.query('delete from grading_periods where school_year_id=$1',[empty.id]),/deletion action/);await as(admin);
  const grade=await one('select id from grade_levels order by rank limit 1');
  const linked=await year('Has link');
  await db.query("insert into enrollment_links(title,school_year_id,allowed_grade_ids,opens_at,closes_at) values('Keep link',$1,$2,now(),now()+interval '1 day')",[linked.id,[grade.id]]);
  await assert.rejects(()=>remove(linked),/enrollment links/);
  const sectionYear=await year('Has section');
  await db.query("insert into sections(name,school_year_id,grade_level_id) values('Keep section',$1,$2)",[sectionYear.id,grade.id]);
  await assert.rejects(()=>remove(sectionYear),/sections/);
  const subject=await one("insert into subjects(name,grade_level_id) values('Keep subject',$1) returning id",[grade.id]);
  await db.exec('reset role');
  await db.query('insert into subject_offerings(school_year_id,subject_id) values($1,$2)',[empty.id,subject.id]);
  // Unexpected references must atomically restore already removed child settings.
  await db.exec('create table test_year_reference(year_id uuid references school_years)');
  await db.query('insert into test_year_reference values($1)',[empty.id]);await as(admin);
  await assert.rejects(()=>remove(empty),/foreign key/);
  assert.equal((await one('select count(*)::int n from grading_periods where school_year_id=$1',[empty.id])).n,4);
  assert.equal((await one('select count(*)::int n from subject_offerings where school_year_id=$1',[empty.id])).n,1);
  await db.exec('reset role;drop table test_year_reference');await as(admin);
  assert.equal((await remove(empty)).result.id,empty.id);
  assert.equal((await one('select count(*)::int n from school_years where id=$1',[empty.id])).n,0);
  assert.equal((await one('select count(*)::int n from grading_periods where school_year_id=$1',[empty.id])).n,0);
  assert.equal((await one('select count(*)::int n from subject_offerings where school_year_id=$1',[empty.id])).n,0);
  assert.equal((await one('select count(*)::int n from subjects where id=$1',[subject.id])).n,1);
  assert.equal((await one('select count(*)::int n from grading_periods where school_year_id=$1',[active.id])).n,4);
  assert.equal((await one("select count(*)::int n from audit_logs where action='DELETE_UNUSED_SCHOOL_YEAR' and actor=$1 and record_id=$2",[admin,empty.id])).n,1);
  await assert.rejects(()=>remove(empty),/no longer exists/);
  await assert.rejects(()=>db.query("update school_years set name='Wrong' where id=$1",[archived.id]),/Archived/);
  await assert.rejects(()=>db.exec('delete from sections'),/Deactivate or archive/);
 }finally{await db.close();}
});

test('Deletion client requires online access, blocks pending sync, uses version and refreshes after success',async()=>{
 const output=ts.transpileModule(readFileSync('src/academic-api.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
 const calls:any[]=[];let pulls=0,error:any=null,refreshFails=false;
 const exports:any={};const offline={status:{pending:0},pull:async()=>{pulls++;if(refreshFails)throw Error('Offline');}};
 const navigator={onLine:true};
 vm.runInNewContext(output,{exports,navigator,Error,require:(name:string)=>name==='./lib'?{db:{rpc:async(name:string,args:any)=>{calls.push({name,args});return {error};}}}:name==='./offline'?offline:{uuid:()=>''}});
 navigator.onLine=false;await assert.rejects(()=>exports.deleteSchoolYear({id:'x',sync_version:3}),/Reconnect/);assert.equal(calls.length,0);
 navigator.onLine=true;offline.status.pending=1;await assert.rejects(()=>exports.deleteSchoolYear({id:'x',sync_version:3}),/pending changes/);assert.equal(calls.length,0);
 offline.status.pending=0;error={message:'Linked records'};await assert.rejects(()=>exports.deleteSchoolYear({id:'x',sync_version:3}),/Linked records/);assert.equal(pulls,0);
 error=null;await exports.deleteSchoolYear({id:'x',sync_version:3});assert.equal(calls.at(-1).name,'delete_unused_school_year');assert.equal(calls.at(-1).args.expected_version,3);assert.equal(pulls,1);
 refreshFails=true;await assert.rejects(()=>exports.deleteSchoolYear({id:'x',sync_version:3}),/was deleted.*could not refresh/);
});

test('School year UI provides confirmation and disables active/archived deletion without adding Delete to other settings',async()=>{
 const output=ts.transpileModule(readFileSync('src/AcademicWorkspace.tsx','utf8')+'\nexport {Configuration};',
  {compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText;
 const react={createElement:(type:any,props:any,...children:any[])=>({type,props:props||{},children}),Fragment:'fragment',useState:(initial:any)=>[initial,()=>{}],useEffect:()=>{},useRef:()=>({current:null})};
 const exports:any={},calls:any[]=[];let accepted=false,confirmation='';
 vm.runInNewContext(output,{exports,window:{confirm:(text:string)=>{confirmation=text;return accepted;}},
  require:(name:string)=>name==='react'?{...react,default:react}:name==='./academic-api'?{deleteSchoolYear:async(row:any)=>calls.push(row)}:{}});
 const inactive={id:'unused',name:'Unused year',active:false,archived:false,sync_version:7};
 const data={school_years:[inactive],grade_levels:[]};
 const tree=exports.Configuration({data,table:'school_years',heading:'School years'});
 const nodes=(node:any):any[]=>!node||typeof node!=='object'?[]:[node,...(node.children||[]).flatMap((child:any)=>Array.isArray(child)?child.flatMap(nodes):nodes(child))];
 const table=nodes(tree).find(n=>n.type?.name==='DataTable');assert.ok(table);
 const button=(row:any)=>nodes(table.props.actions(row)).find(n=>n.props['aria-label']?.startsWith('Delete school year'));
 assert.equal(button(inactive).props.disabled,false);
 assert.equal(button({...inactive,active:true}).props.disabled,true);
 assert.equal(button({...inactive,archived:true}).props.disabled,true);
 button(inactive).props.onClick();assert.equal(calls.length,0);assert.match(confirmation,/Unused year.*unused grading quarters.*cannot be undone/s);
 accepted=true;button(inactive).props.onClick();await Promise.resolve();assert.equal(calls.length,1);assert.equal(calls[0].sync_version,7);
 const other=exports.Configuration({data,table:'grade_levels',heading:'Grade levels'});
 const otherTable=nodes(other).find(n=>n.type?.name==='DataTable');assert.equal(nodes(otherTable.props.actions({id:'grade'})).some(n=>n.props['aria-label']?.startsWith('Delete')),false);
});
