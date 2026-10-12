import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import vm from 'node:vm';
import ts from 'typescript';

test('Section placement: recommendation, atomic approval, transfers, adviser access and guards',async()=>{
 const db=new PGlite();
 const admin=crypto.randomUUID(),teacher=crypto.randomUUID(),other=crypto.randomUUID();
 const one=async(sql:string,args:any[]=[])=>((await db.query(sql,args)).rows[0] as any);
 const as=async(id:string)=>db.exec(`reset role;select set_config('request.jwt.claim.sub','${id}',false);set role authenticated;`);
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid,bucket_id text);alter table storage.objects enable row level security;`);
 for(const f of ['001_school.sql','002_offline_sync.sql','003_enrollment_guide_lrn.sql','004_enrollment_details.sql','005_academic_portals.sql','006_section_assignment.sql'])await db.exec(readFileSync('supabase/migrations/'+f,'utf8'));
 await db.exec(`grant usage on schema public,auth to authenticated,anon;grant select,insert,update,delete on profiles,school_years,sections,students,enrollments,enrollment_links,applications,subjects,assignments to authenticated;grant select on grades,audit_logs to authenticated;grant usage on all sequences in schema public to authenticated;insert into auth.users values('${admin}'),('${teacher}'),('${other}');insert into profiles(id,full_name,role,can_grade) values('${admin}','Admin','admin',true),('${teacher}','Adviser One','teacher',true),('${other}','Adviser Two','teacher',true);`);
 await db.exec('grant select on all tables in schema public to authenticated');
 await as(admin);
 const year=await one("insert into school_years(name,active) values('2026',true) returning *");
 const nextYear=await one("insert into school_years(name) values('2027') returning *");
 const grade=await one('select * from grade_levels where rank=3'),wrongGrade=await one('select * from grade_levels where rank=4');
 const sec=async(name:string,cap:number|null,gr=grade.id,yr=year.id,active=true)=>one('insert into sections(name,capacity,grade_level_id,school_year_id,active) values($1,$2,$3,$4,$5) returning *',[name,cap,gr,yr,active]);
 const a=await sec('Mabini',2),b=await sec('Rizal',2),full=await sec('Bonifacio',1),inactive=await sec('Inactive',20,grade.id,year.id,false),wrong=await sec('Wrong grade',20,wrongGrade.id),future=await sec('Wrong year',20,grade.id,nextYear.id);
 const student=async(first:string)=>one("insert into students(first_name,last_name,birth_date,sex,address,contact,guardian_name,guardian_contact) values($1,'Test','2018-01-01','Male','Synthetic','09171234567','Guardian','09171234567') returning *",[first]);
 for(const [name,section] of [['Seed A',a],['Seed Full',full]] as const){const st=await student(name);await db.query('insert into enrollments(student_id,school_year_id,grade_level_id,section_id) values($1,$2,$3,$4)',[st.id,year.id,grade.id,section.id]);}
 const link=await one("insert into enrollment_links(title,school_year_id,allowed_grade_ids,opens_at,closes_at,published) values('Test',$1,$2,now()-interval '1 day',now()+interval '1 day',true) returning *",[year.id,[grade.id]]);
 const app=async(first:string,lrn:string|null=null)=>one("insert into applications(link_id,grade_level_id,first_name,last_name,birth_date,sex,address,contact,guardian_name,guardian_contact,enrollment_type,lrn) values($1,$2,$3,'Application','2018-01-01','Female','Synthetic','09171234567','Guardian','09171234567','New',$4) returning *",[link.id,grade.id,first,lrn]);
 const preview=async(application:string|null,enrollment:string|null=null)=>(await one('select placement_preview($1,$2) r',[application,enrollment])).r;
 const place=async(application:string|null,section:string,version:number,method='Automatic',enrollment:string|null=null,reason='',operation=crypto.randomUUID())=>(await one('select confirm_section_placement($1,$2,$3,$4,$5,$6,$7) r',[operation,application,enrollment,section,method,version,reason])).r;
 let application=await app('Alice','123456789012');
 let p=await preview(application.id);assert.equal(p.recommended,b.id);assert.equal(p.options.find((s:any)=>s.id===b.id).adviser,'No adviser assigned');assert.equal(p.options.find((s:any)=>s.id===inactive.id).eligible,false);assert.equal(p.options.some((s:any)=>s.id===wrong.id||s.id===future.id),false);
 // Rejections roll back identity creation, enrollment and application status.
 for(const destination of [full.id,inactive.id,wrong.id,future.id])await assert.rejects(()=>place(application.id,destination,p.expected_version,'Manual'),/full, inactive or incompatible/);
 assert.equal((await one('select status from applications where id=$1',[application.id])).status,'Pending');assert.equal((await one("select count(*) n from students where first_name='Alice'")).n,0);
 await db.query('select change_section_adviser($1,$2,null)',[b.id,teacher]);
 const op=crypto.randomUUID();const result=await place(application.id,b.id,p.expected_version,'Automatic',null,'',op);
 assert.deepEqual(await place(application.id,b.id,p.expected_version,'Automatic',null,'',op),result);
 await assert.rejects(()=>place(application.id,b.id,p.expected_version),/cannot be approved/);
 await as(teacher);assert.equal((await one('select count(*) n from teacher_students()')).n,1);assert.equal((await one('select sex from teacher_students()')).sex,'Female');
 await assert.rejects(()=>preview(application.id),/Administrator/);await assert.rejects(()=>place(null,a.id,1,'Manual',result.enrollment_id),/Administrator/);
 await as(other);assert.equal((await one('select count(*) n from teacher_students()')).n,0);assert.equal((await one('select count(*) n from enrollments')).n,0);
 await as(admin);
 const second=await app('Bea');p=await preview(second.id);assert.equal(p.recommended,a.id,'Equal counts use section name');
 // Manual override deliberately selects a different eligible section.
 await place(second.id,b.id,p.expected_version,'Manual');
 const third=await app('Cora');p=await preview(third.id);await place(third.id,a.id,p.expected_version);
 const blocked=await app('Dora');p=await preview(blocked.id);assert.equal(p.recommended,null);assert.equal(p.options.filter((s:any)=>s.eligible).length,0);
 await assert.rejects(()=>place(blocked.id,a.id,p.expected_version,'Manual'),/full/);
 await assert.rejects(()=>db.query('update sections set active=false where id=$1',[b.id]),/active enrollments/);
 await assert.rejects(()=>db.query('delete from sections where id=$1',[inactive.id]),/Deactivate or archive/);
 await assert.rejects(()=>db.query('update sections set capacity=1 where id=$1',[b.id]),/Capacity/);
 await assert.rejects(()=>db.query('update sections set grade_level_id=$1 where id=$2',[wrongGrade.id,b.id]),/history/);
 // A changed recommendation must be shown again, never silently substituted.
 const dest=await sec('New section',2);p=await preview(blocked.id);assert.equal(p.recommended,dest.id);
 const before=await sec('AAA tie',2);await assert.rejects(()=>place(blocked.id,dest.id,p.expected_version),/Availability changed/);
 p=await preview(blocked.id);assert.equal(p.recommended,before.id);
 // Concurrent callers in this embedded engine are serialized. Native multi-session
 // lock contention requires the additional deployment checklist / PostgreSQL test.
 const limited=await sec('Single slot',1);const race1=await app('Race one'),race2=await app('Race two');
 const attempts=await Promise.allSettled([place(race1.id,limited.id,race1.sync_version,'Manual'),place(race2.id,limited.id,race2.sync_version,'Manual')]);
 assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);assert.equal((await one('select count(*) n from enrollments where section_id=$1 and active',[limited.id])).n,1);
 // Transfer changes roster access but preserves enrollment ID and quarterly records.
 await db.query('select change_section_adviser($1,$2,null)',[dest.id,other]);
 await db.exec('reset role');
 const subject=await one("insert into subjects(name,grade_level_id) values('History',$1) returning *",[grade.id]);
 await db.query('insert into grades(enrollment_id,subject_id,q1) values($1,$2,85)',[result.enrollment_id,subject.id]);
 await as(admin);p=await preview(null,result.enrollment_id);
 await assert.rejects(()=>place(null,wrong.id,p.expected_version,'Manual',result.enrollment_id),/incompatible/);
 const moved=await place(null,dest.id,p.expected_version,'Manual',result.enrollment_id,'Parent requested transfer');assert.equal(moved.enrollment_id,result.enrollment_id);
 assert.equal((await one('select q1 from grades where enrollment_id=$1',[result.enrollment_id])).q1,'85');
 assert.equal((await one('select lrn from students where id=$1',[result.student_id])).lrn,'123456789012');
 assert.equal((await one('select reason from enrollment_history where enrollment_id=$1 and from_section_id=$2',[result.enrollment_id,b.id])).reason,'Parent requested transfer');
 await assert.rejects(()=>place(null,a.id,p.expected_version,'Manual',result.enrollment_id),/Record changed/);
 await as(teacher);assert.equal((await db.query('select * from teacher_students()')).rows.some((s:any)=>s.id===result.student_id),false);
 await as(other);assert.equal((await one('select id from teacher_students()')).id,result.student_id);
 await as(admin);
 const otherLink=await one("insert into enrollment_links(title,school_year_id,allowed_grade_ids,opens_at,closes_at) values('Returning',$1,$2,now(),now()+interval '1 day') returning *",[year.id,[grade.id]]);
 const returningSql="insert into applications(link_id,grade_level_id,first_name,last_name,birth_date,sex,address,contact,guardian_name,guardian_contact,enrollment_type,lrn,student_id,identity_reviewed) values($1,$2,'Alice','Application','2018-01-01','Female','Synthetic','09171234567','Guardian','09171234567','Returning','123456789012',$3,true) returning *";
 await assert.rejects(()=>one(returningSql,[otherLink.id,grade.id,result.student_id]),/ACTIVE_LRN_APPLICATION/);
 // Original unique learner/year constraint is still enforced even across links.
 await assert.rejects(()=>db.query('insert into enrollments(student_id,school_year_id,grade_level_id,section_id) values($1,$2,$3,$4)',[result.student_id,year.id,grade.id,dest.id]),/unique/);
 assert.ok((await one("select count(*) n from audit_logs where action='APPROVE_AND_ASSIGN'")).n>=4);assert.equal((await one("select count(*) n from audit_logs where action='SECTION_TRANSFER'")).n,1);
 const adviser=(await one('select id from teacher_class_assignments where section_id=$1 and active',[dest.id])).id;
 await db.query('select change_section_adviser($1,$2,$3)',[dest.id,teacher,adviser]);assert.equal((await one('select active from teacher_class_assignments where id=$1',[adviser])).active,false);
 await assert.rejects(()=>db.query('select change_section_adviser($1,$2,$3)',[dest.id,other,adviser]),/Adviser changed/);
 // No compatible sections returns an empty recommendation, not a random grade.
 const emptyGrade=await one('select id from grade_levels where rank=6');
 const emptyApp=await app('Empty grade');await db.query('update applications set grade_level_id=$1 where id=$2',[emptyGrade.id,emptyApp.id]);
 const empty=await preview(emptyApp.id);assert.deepEqual(empty.options,[]);assert.equal(empty.recommended,null);
 const changedApp=await app('Edited');const stale=await preview(changedApp.id);await db.query("update applications set note='Reviewed again' where id=$1",[changedApp.id]);
 await assert.rejects(()=>place(changedApp.id,dest.id,stale.expected_version,'Manual'),/Record changed/);
 await db.query('update school_years set active=false where id=$1',[year.id]);await assert.rejects(()=>preview(changedApp.id),/active school year/);
 await db.query('update school_years set active=true where id=$1',[nextYear.id]);
 const returningLink=await one("insert into enrollment_links(title,school_year_id,allowed_grade_ids,opens_at,closes_at) values('Next year',$1,$2,now(),now()+interval '1 day') returning *",[nextYear.id,[grade.id]]);
 const returning=await one(returningSql,[returningLink.id,grade.id,result.student_id]);
 const continued=await place(returning.id,future.id,returning.sync_version);assert.equal(continued.student_id,result.student_id);assert.notEqual(continued.enrollment_id,result.enrollment_id);
 assert.equal((await one('select q1 from grades where enrollment_id=$1',[result.enrollment_id])).q1,'85');
 await as(other);assert.equal((await one('select count(*) n from teacher_students()')).n,0);
 await db.exec('reset role;set role anon');await assert.rejects(()=>preview(blocked.id),/permission/);
 }finally{await db.close()}
});

test('Placement client requires online server validation and blocks pending offline changes',async()=>{
 let online=false,pending=0;const calls:any[]=[];const exports:any={};
 const fakeDb={rpc:async(name:string,args:any)=>{calls.push({name,args});return {data:{ok:true}}}};
 const ctx=vm.createContext({exports,Error,require:(id:string)=>id==='./academic-api'?{requireOnline:()=>{if(!online)throw Error('Reconnect')}}:id==='./offline'?{get status(){return {pending}}}:{db:fakeDb}});
 vm.runInContext(ts.transpileModule(readFileSync('src/section-assignment-api.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,ctx);
 await assert.rejects(()=>exports.placementPreview('a',null),/Reconnect/);await assert.rejects(()=>exports.confirmPlacement({}),/Reconnect/);assert.equal(calls.length,0);
 online=true;pending=1;await assert.rejects(()=>exports.confirmPlacement({}),/Synchronize/);assert.equal(calls.length,0);
 pending=0;await exports.confirmPlacement({operation:'stable-id'});assert.equal(calls[0].name,'smart_confirm_placement');assert.equal(calls[0].args.operation,'stable-id');
});
