import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

test('Smart advisers, transactional bulk plans, private notifications and stale-preview protection',async()=>{
 const db=new PGlite();const admin=crypto.randomUUID(),anna=crypto.randomUUID(),bea=crypto.randomUUID(),outsider=crypto.randomUUID();
 const one=async(sql:string,args:any[]=[])=>((await db.query(sql,args)).rows[0] as any);
 const as=async(id:string)=>db.exec(`reset role;select set_config('request.jwt.claim.sub','${id}',false);set role authenticated;`);
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid,bucket_id text);alter table storage.objects enable row level security;`);
 for(const f of ['001_school.sql','002_offline_sync.sql','003_enrollment_guide_lrn.sql','004_enrollment_details.sql','005_academic_portals.sql','006_section_assignment.sql','007_smart_advisers.sql'])await db.exec(readFileSync('supabase/migrations/'+f,'utf8'));
 await db.exec(`grant usage on schema public,auth to authenticated,anon;grant select on all tables in schema public to authenticated;grant insert,update,delete on profiles,school_years,sections,students,enrollments,enrollment_links,applications,subjects,assignments to authenticated;insert into auth.users values('${admin}'),('${anna}'),('${bea}'),('${outsider}');insert into profiles(id,full_name,role,can_grade) values('${admin}','Admin','admin',true),('${anna}','Anna','teacher',true),('${bea}','Bea','teacher',true),('${outsider}','AAA Unqualified','teacher',true);`);
 const y=await one("insert into school_years(name,active) values('2026',true) returning *"),y2=await one("insert into school_years(name) values('2027') returning *"),g=await one('select id from grade_levels where rank=3'),g2=await one('select id from grade_levels where rank=4');
 const section=async(name:string,year=y.id,grade=g.id,capacity=2)=>one('insert into sections(name,school_year_id,grade_level_id,capacity) values($1,$2,$3,$4) returning *',[name,year,grade,capacity]);
 const a=await section('A target'),b=await section('B target'),teaching=await section('Teaching source'),wrong=await section('Other grade',y.id,g2.id),otherYear=await section('Other year',y2.id);
 const subject=await one("insert into subjects(name,grade_level_id) values('Math',$1) returning *",[g.id]);
 const subject2=await one("insert into subjects(name,grade_level_id) values('Reading',$1) returning *",[g.id]);
 await db.query('insert into subject_offerings(subject_id,school_year_id) values($1,$2),($3,$2),($1,$4)',[subject.id,y.id,subject2.id,y2.id]);
 await db.query('insert into assignments(teacher_id,section_id,subject_id) values($1,$2,$3),($4,$2,$5),($6,$7,$3)',[anna,teaching.id,subject.id,bea,subject2.id,outsider,otherYear.id]);
 // Exclude the teaching source from placement without deactivating its assignments.
 await db.query('update sections set capacity=1 where id=$1',[teaching.id]);
 const seed=await one("insert into students(first_name,last_name,birth_date,sex,address,contact,guardian_name,guardian_contact) values('Seed','Fixture','2018-01-01','Male','Synthetic','09171234567','Guardian','09171234567') returning *");
 await db.query('insert into enrollments(student_id,school_year_id,grade_level_id,section_id) values($1,$2,$3,$4)',[seed.id,y.id,g.id,teaching.id]);
 const link=await one("insert into enrollment_links(title,school_year_id,allowed_grade_ids,opens_at,closes_at) values('Fixture',$1,$2,now(),now()+interval '1 day') returning *",[y.id,[g.id]]);
 const app=async(first:string)=>one("insert into applications(link_id,grade_level_id,first_name,last_name,birth_date,sex,address,contact,guardian_name,guardian_contact,enrollment_type) values($1,$2,$3,'Fixture','2018-01-01','Female','Synthetic','09171234567','Guardian','09171234567','New') returning *",[link.id,g.id,first]);
 await as(admin);
 const rec=async(id:string)=>(await one('select adviser_recommendation($1) r',[id])).r;
 assert.equal((await rec(a.id)).teacher_id,anna,'ties use teacher name; other-year teacher excluded');
 assert.equal((await rec(wrong.id)).eligible,false,'no teacher assigned to this grade');
 await db.query('select change_section_adviser($1,$2,null)',[teaching.id,anna]);
 assert.equal((await rec(a.id)).teacher_id,bea,'fewest adviser sections wins');
 assert.equal((await rec(teaching.id)).teacher_id,anna,'existing advisers remain');
 await as(outsider);await assert.rejects(()=>rec(a.id),/Administrator/);await assert.rejects(()=>db.query('select confirm_auto_adviser($1,$2,null)',[a.id,outsider]),/Administrator/);
 await as(admin);
 const alice=await app('Alice');const preview=(await one('select smart_placement_preview($1,null) r',[alice.id])).r;const option=preview.options.find((s:any)=>s.id===a.id);
 const smart=async(ap:any,sec:string,teacher:string,assignment:string|null=null,op=crypto.randomUUID())=>(await one('select smart_confirm_placement($1,$2,null,$3,$4,$5,$6,true,$7,$8) r',[op,ap.id,sec,'Manual',ap.sync_version,'Test',teacher,assignment])).r;
 await assert.rejects(()=>smart(alice,a.id,anna),/Teacher recommendation changed/);assert.equal((await one('select count(*) n from teacher_class_assignments where section_id=$1',[a.id])).n,0);
 const op=crypto.randomUUID();const approved=await smart(alice,a.id,option.teacher.teacher_id,null,op);assert.deepEqual(await smart(alice,a.id,option.teacher.teacher_id,null,op),approved);
 assert.equal((await rec(a.id)).teacher_id,bea);
 await as(bea);const notices=(await db.query('select * from teacher_notifications')).rows as any[];assert.ok(notices.some(n=>n.event==='joined'));assert.ok(notices.some(n=>n.event==='adviser'));assert.ok(notices.every(n=>n.recipient===bea&&!n.message.includes('Alice')));
 await assert.rejects(()=>db.query("update teacher_notifications set message='fake'"),/permission/);
 await db.query('select read_teacher_notifications($1)',[[notices[0].id]]);assert.ok((await one('select read_at from teacher_notifications where id=$1',[notices[0].id])).read_at);
 await as(outsider);assert.equal((await one('select count(*) n from teacher_notifications')).n,0);await db.query('select read_teacher_notifications($1)',[[notices.at(-1).id]]);
 await as(bea);assert.equal((await one('select read_at from teacher_notifications where id=$1',[notices.at(-1).id])).read_at,null);
 await as(admin);
 const bob=await app('Bob'),cara=await app('Cara');
 const batch=async(ids:string[])=>(await one('select batch_placement_preview($1) r',[ids])).r;
 let plan=await batch([bob.id,cara.id]);assert.equal(plan.length,2);assert.equal(plan[0].section_id,b.id);assert.equal(plan[0].teacher.teacher_id,anna);assert.equal(plan[1].section_id,a.id,'virtual count affects second placement');
 assert.equal((await one('select count(*) n from teacher_class_assignments where section_id=$1',[b.id])).n,0,'preview does not assign teachers');
 await assert.rejects(()=>batch([bob.id,bob.id]),/different/);
 const confirmBatch=async(ids:string[],plan:any,op=crypto.randomUUID())=>(await one('select confirm_batch_placement($1,$2,$3) r',[op,ids,plan])).r;
 const tampered=structuredClone(plan);tampered[0].teacher.teacher_id=outsider;await assert.rejects(()=>confirmBatch([bob.id,cara.id],tampered),/Batch placement changed/);
 await db.query("update applications set note='Updated review' where id=$1",[bob.id]);await assert.rejects(()=>confirmBatch([bob.id,cara.id],plan),/Batch placement changed/);
 plan=await batch([bob.id,cara.id]);const bop=crypto.randomUUID();const results=await confirmBatch([bob.id,cara.id],plan,bop);assert.equal(results.length,2);assert.deepEqual(await confirmBatch([bob.id,cara.id],plan,bop),results);
 assert.equal((await one('select count(*) n from enrollments where section_id=$1',[a.id])).n,2);
 // Failure late in a batch rolls back all students, advisers, receipts and notices.
 const extra=await section('C empty');const duplicate=await app('Seed');const clean=await app('Rollback test');
 await db.query('update applications set id=$1 where id=$2',['ffffffff-ffff-ffff-ffff-ffffffffffff',duplicate.id]);duplicate.id='ffffffff-ffff-ffff-ffff-ffffffffffff';
 const badPlan=await batch([duplicate.id,clean.id]);assert.equal(badPlan.at(-1).application,duplicate.id);
 const before=(await one('select count(*) n from applications where status=\'Enrolled\'')).n;
 await assert.rejects(()=>confirmBatch([duplicate.id,clean.id],badPlan),/matching learner|matching name/);
 assert.equal((await one('select count(*) n from applications where status=\'Enrolled\'')).n,before);
 assert.equal((await one('select count(*) n from teacher_class_assignments where section_id=$1',[extra.id])).n,0);
 // Transfer emits left/joined notices and preserves existing adviser.
 const move=(await one('select placement_preview(null,$1) r',[approved.enrollment_id])).r;
 await db.query('select confirm_section_placement($1,null,$2,$3,\'Manual\',$4,\'Move\')',[crypto.randomUUID(),approved.enrollment_id,b.id,move.expected_version]);
 await as(bea);assert.ok((await db.query("select * from teacher_notifications where event='left'")).rows.length);await as(anna);assert.ok((await db.query("select * from teacher_notifications where event='joined'")).rows.length);
 await as(admin);await db.query('update profiles set active=false where id=$1',[anna]);assert.equal((await rec(b.id)).eligible,false,'inactive incumbent is not silently replaced');
 await as(anna);assert.equal((await one('select count(*) n from teacher_notifications')).n,0);
 await db.exec('reset role;set role anon');await assert.rejects(()=>rec(extra.id),/permission/);
 }finally{await db.close()}
});
