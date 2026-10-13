import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

test('Approval identifiers: uniqueness, preservation, authorization and rollback',async()=>{
 const db=new PGlite();const admin=crypto.randomUUID(),anna=crypto.randomUUID(),bea=crypto.randomUUID(),outsider=crypto.randomUUID();
 const one=async(sql:string,args:any[]=[])=>((await db.query(sql,args)).rows[0] as any);
 const as=async(id:string)=>db.exec(`reset role;select set_config('request.jwt.claim.sub','${id}',false);set role authenticated;`);
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid,bucket_id text);alter table storage.objects enable row level security;`);
 for(const f of ['001_school.sql','002_offline_sync.sql','003_enrollment_guide_lrn.sql','004_enrollment_details.sql','005_academic_portals.sql','006_section_assignment.sql','007_smart_advisers.sql','008_application_learner_identifier.sql'])await db.exec(readFileSync('supabase/migrations/'+f,'utf8'));
 await db.exec(`grant usage on schema public,auth to authenticated,anon;grant select on all tables in schema public to authenticated;grant insert,update,delete on profiles,school_years,sections,students,enrollments,enrollment_links,applications,subjects,assignments to authenticated;insert into auth.users values('${admin}'),('${anna}'),('${bea}'),('${outsider}');insert into profiles(id,full_name,role,can_grade) values('${admin}','Admin','admin',true),('${anna}','Anna','teacher',true),('${bea}','Bea','teacher',true),('${outsider}','AAA Unqualified','teacher',true);`);

 await db.exec('revoke all on learner_identifier_registry,learner_identifier_counters from authenticated');
 const y=await one("insert into school_years(name,active) values('2026',true) returning *"),g=await one('select id from grade_levels where rank=0');
 const section=await one("insert into sections(name,school_year_id,grade_level_id,capacity) values('New learners',$1,$2,50) returning *",[y.id,g.id]);
 const link=await one("insert into enrollment_links(title,school_year_id,allowed_grade_ids,opens_at,closes_at) values('Fixture',$1,$2,now(),now()+interval '1 day') returning *",[y.id,[g.id]]);
 const app=async(first:string,lrn:string|null=null,type='New')=>one("insert into applications(link_id,grade_level_id,first_name,last_name,birth_date,sex,address,contact,guardian_name,guardian_contact,enrollment_type,lrn) values($1,$2,$3,'Fixture','2020-01-01','Female','Synthetic','09171234567','Guardian','09171234567',$4,$5) returning *",[link.id,g.id,first,type,lrn]);
 const approve=async(a:any)=>(await one('select approve_application($1,$2) id',[a.id,section.id])).id;
 const prefix='113682'+(await one("select to_char(now() at time zone 'Asia/Manila','YY') yr")).yr;
 await as(admin);
 const a=await app('Ana'),b=await app('Ben');
 assert.equal((await one('select count(*) n from students')).n,0);
 await assert.rejects(()=>db.query('select assign_application_learner_identifier($1)',[a.id]),/permission/);
 const sid=await approve(a);let student=await one('select * from students where id=$1',[sid]);
 assert.equal(student.learner_identifier,prefix+'0001');assert.equal(student.lrn,null);
 const second=await approve(b);assert.equal((await one('select learner_identifier from students where id=$1',[second])).learner_identifier,prefix+'0002');
 await assert.rejects(()=>approve(a),/cannot be approved/);assert.equal((await one('select learner_identifier from students where id=$1',[sid])).learner_identifier,prefix+'0001');
 await db.query("update students set address='Changed' where id=$1",[sid]);
 await assert.rejects(()=>db.query("update students set learner_identifier=null where id=$1",[sid]),/permanent/);
 await assert.rejects(()=>db.query("update students set learner_identifier=$1 where id=$2",[prefix+'9999',sid]),/permanent/);
 const official=await app('Official','123456789012');const oid=await approve(official);assert.equal((await one('select learner_identifier from students where id=$1',[oid])).learner_identifier,null);
 const rejected=await app('Rejected');await db.query("update applications set status='Rejected',note='Test rejection' where id=$1",[rejected.id]);await assert.rejects(()=>approve(rejected),/cannot be approved/);
 const pending=await app('Pending');assert.equal((await one('select student_id from applications where id=$1',[pending.id])).student_id,null);
 const returning=await app('Returning',null,'Returning');const rid=await approve(returning);assert.equal((await one('select learner_identifier from students where id=$1',[rid])).learner_identifier,null);
 // Promotion/re-enrollment links the same stable learner and never issues again.
 await db.exec('reset role');await db.query('update school_years set active=false where id=$1',[y.id]);
 const next=await one("insert into school_years(name,active) values('2027',true) returning *");
 const nextSection=await one("insert into sections(name,school_year_id,grade_level_id) values('Next year',$1,$2) returning *",[next.id,g.id]);
 const nextLink=await one("insert into enrollment_links(title,school_year_id,allowed_grade_ids,opens_at,closes_at) values('Next',$1,$2,now(),now()+interval '1 day') returning *",[next.id,[g.id]]);
 await as(admin);const again=await app('Ana',null,'Returning');await db.query('update applications set link_id=$1,student_id=$2,identity_reviewed=true where id=$3',[nextLink.id,sid,again.id]);
 await db.query('select approve_application($1,$2)',[again.id,nextSection.id]);assert.equal((await one('select learner_identifier from students where id=$1',[sid])).learner_identifier,prefix+'0001');
 await db.query('update students set lrn=$1 where id=$2',['222222222222',sid]);assert.equal((await one('select learner_identifier from students where id=$1',[sid])).learner_identifier,prefix+'0001');
 // Teacher projection is restricted and includes application ID only for assigned learners.
 await db.query('select change_section_adviser($1,$2,null)',[nextSection.id,anna]);await as(anna);
 const visible=(await db.query('select * from teacher_students()')).rows as any[];assert.equal(visible.length,1);assert.equal(visible[0].learner_identifier,prefix+'0001');
 await assert.rejects(()=>db.query('select * from learner_identifier_registry'),/permission/);
 await assert.rejects(()=>db.query('select assign_application_learner_identifier($1)',[sid]),/permission/);
 // Exhaustion fails the whole approval, leaving no new student or enrollment.
 await db.exec('reset role');await db.query('update learner_identifier_counters set last_value=9999');await as(admin);
 const exhausted=await app('Exhausted');await db.query('update applications set link_id=$1 where id=$2',[nextLink.id,exhausted.id]);
 await assert.rejects(()=>db.query('select approve_application($1,$2)',[exhausted.id,nextSection.id]),/exhausted/);
 assert.equal((await one('select status from applications where id=$1',[exhausted.id])).status,'Pending');assert.equal((await one("select count(*) n from students where first_name='Exhausted'")).n,0);
 await db.exec('reset role;set role anon');await assert.rejects(()=>db.query('select * from teacher_students()'),/permission/);
 }finally{await db.close()}
});
