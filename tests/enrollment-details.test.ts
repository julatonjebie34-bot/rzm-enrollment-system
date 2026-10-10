import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {initialDetails,changeDetails,restoreDetails,validateStep,phone} from '../supabase/functions/_shared/enrollment-details.ts';
import {cleanDetails} from '../supabase/functions/public-enrollment/validation.ts';
const grade='00000000-0000-0000-0000-000000000010';
const fixture=()=>({...initialDetails(),first_name:'Test',last_name:'Learner',birth_date:'2015-01-01',sex:'Female',grade_level_id:grade,address:'Actual student address',contact:'0917 123 4567',student_email:'learner@example.com',mother_available:true,mother_name:'Test Mother',mother_contact:'0918 123 4567',mother_address:'Mother address',father_available:true,father_name:'Test Father',father_contact:'(02) 8123 4567',father_address:'Father address',guardian_available:false,previously_attended:false});
test('Philippine contact validation accepts mobile and landline formats and rejects garbage',()=>{
 for(const value of ['0917 123 4567','+63 917 123 4567','639171234567'])assert.equal(phone(value),'+639171234567');
 assert.equal(phone('(02) 8123 4567'),'+63281234567');assert.equal(phone('053 123 4567'),'+63531234567');
 for(const value of ['123','+1 212 555 1234','abc09171234567','++639171234567'])assert.equal(phone(value),null);
});
test('navigation, address synchronization and hidden school details retain the correct values',()=>{
 let form=fixture();form=changeDetails(form,'mother_same_address',true) as any;form=changeDetails(form,'address','Updated learner address') as any;
 assert.equal(form.mother_address,'Updated learner address');assert.equal(form.father_address,'Father address');
 form=changeDetails(form,'mother_same_address',false) as any;form=changeDetails(form,'mother_address','Independent address') as any;form=changeDetails(form,'address','Another learner address') as any;assert.equal(form.mother_address,'Independent address');
 form=changeDetails(form,'previously_attended',true) as any;assert.equal(validateStep(form,3,[grade])?.field,'previous_school');
 Object.assign(form,{previous_school:'Old school',previous_school_address:'Old school address',last_grade_level_id:grade});assert.equal(validateStep(form,3,[grade]),null);
 form=changeDetails(form,'previously_attended',false) as any;assert.equal(form.previous_school,'');assert.equal(form.previous_school_address,'');assert.equal(form.last_grade_level_id,'');assert.equal(validateStep(form,3,[grade]),null);
 const restored=restoreDetails(JSON.parse(JSON.stringify(form)));assert.equal(restored.grade_level_id,grade);assert.equal(restored.mother_address,'Independent address');assert.equal(restored.previously_attended,false);
});
test('frontend and API validate email, required address, grade IDs and available adults',()=>{
 const value=fixture();const link={allowed_grade_ids:[grade],valid_grade_ids:[grade]};for(let step=0;step<4;step++)assert.equal(validateStep(value,step,[grade]),null);
 const cleaned=cleanDetails(value,link);assert.equal(cleaned.student_email,'learner@example.com');assert.equal(cleaned.guardian_name,'');assert.equal(cleaned.mother_contact,'+639181234567');assert.equal(cleaned.father_contact,'+63281234567');assert.equal(cleaned.previous_school,'');
 assert.equal(cleanDetails({...value,student_email:''},link).student_email,null);
 for(const student_email of ['bad@',42])assert.throws(()=>cleanDetails({...value,student_email},link),/invalidEmail/);
 assert.throws(()=>cleanDetails({...value,address:' '},link),/requiredError/);assert.throws(()=>cleanDetails({...value,grade_level_id:'invented'},link),/invalidGrade/);
 assert.throws(()=>cleanDetails({...value,mother_available:false,father_available:false},link),/adultRequired/);
 assert.equal(validateStep({...value,previously_attended:null},3,[grade])?.code,'previousAnswerRequired');
});
test('migration preserves records; all seven grades, family data, approval, replay and RLS work',async()=>{
 const db=new PGlite();
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid,bucket_id text);alter table storage.objects enable row level security;`);
 for(const file of ['001_school.sql','002_offline_sync.sql','003_enrollment_guide_lrn.sql'])await db.exec(readFileSync('supabase/migrations/'+file,'utf8'));
 const one=async(sql:string,args:any[]=[])=>((await db.query(sql,args)).rows[0] as any);
 await db.exec(`insert into auth.users values('00000000-0000-0000-0000-000000000001');insert into profiles values('00000000-0000-0000-0000-000000000001','Admin','admin',true,1,now());select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);`);
 const year=await one("insert into school_years(name) values('2026–2027') returning id");const g6=await one('select id from grade_levels where rank=6');
 const link=await one("insert into enrollment_links(token,title,school_year_id,allowed_grade_ids,published,opens_at,closes_at) values('7f4cbb6e-d080-4500-af2b-1891bd082799','Enrollment',$1,array[$2::uuid],true,now()-interval '1 day',now()+interval '1 day') returning *",[year.id,g6.id]);
 const legacy=await one("insert into students(first_name,last_name,birth_date,sex,address,contact,guardian_name,guardian_contact) values('Legacy','Student','2014-01-01','Male','Saved address','123','Original Guardian','456') returning id");
 await db.exec(readFileSync('supabase/migrations/004_enrollment_details.sql','utf8'));
 assert.equal((await one('select address from students where id=$1',[legacy.id])).address,'Saved address');
 const updated=await one('select * from enrollment_links where id=$1',[link.id]);assert.equal(updated.allowed_grade_ids.length,7);
 const grades=(await db.query('select id,name from grade_levels order by rank')).rows as any[];assert.deepEqual(grades.map(g=>g.name),['Kindergarten','Grade 1','Grade 2','Grade 3','Grade 4','Grade 5','Grade 6']);
 const docs=[{kind:'Photo',path:'test/photo.png'},{kind:'Birth Certificate',path:'test/birth.pdf'}];
 for(let i=0;i<grades.length;i++){
  const details=cleanDetails({...fixture(),first_name:'Test '+i,grade_level_id:grades[i].id,previously_attended:i===6,previous_school:'Previous School',previous_school_address:'School address',last_grade_level_id:grades[0].id},updated);
  const submission=crypto.randomUUID();const uploaded=docs.map(d=>({...d,path:i+'/'+d.path}));
  const response=await one('select submit_public_application($1,$2,$3,$4) as result',[link.token,submission,details,uploaded]);assert.ok(response.result.reference);
  const app=await one('select * from applications where submission_id=$1',[submission]);assert.equal(app.grade_level_id,grades[i].id);assert.equal(app.student_email,details.student_email);assert.equal(app.mother_address,'Mother address');assert.equal(app.father_address,'Father address');assert.equal(app.guardian_name,'');
  assert.equal(app.previous_school,i===6?'Previous School':'');assert.equal(app.previous_school_address,i===6?'School address':'');
  const replay=await one('select submit_public_application($1,$2,$3,$4) as result',[link.token,submission,details,uploaded]);assert.equal(replay.result.replayed,true);
  await assert.rejects(()=>one('select submit_public_application($1,$2,$3,$4)',[link.token,submission,{...details,student_email:'changed@example.com'},uploaded]),/SUBMISSION_CHANGED/);
  const section=await one("insert into sections(name,grade_level_id,school_year_id) values('A',$1,$2) returning id",[grades[i].id,year.id]);const approved=await one('select approve_application($1,$2) as id',[app.id,section.id]);const student=await one('select * from students where id=$1',[approved.id]);
  for(const field of ['student_email','mother_name','mother_contact','mother_address','father_name','father_contact','father_address','guardian_name','guardian_contact','guardian_address','previous_school_address'])assert.equal(student[field],app[field]);
 }
 const bad=cleanDetails({...fixture(),grade_level_id:g6.id},updated);
 await assert.rejects(()=>one('select submit_public_application($1,$2,$3,$4)',[link.token,crypto.randomUUID(),{...bad,contact:'garbage'},docs]),/invalidPhone/);
 await db.exec('grant usage on schema public,auth to authenticated,anon;grant select,insert,update on all tables in schema public to authenticated;grant select on applications,students to anon;grant usage on all sequences in schema public to authenticated;set role authenticated;');
 const student=await one("select * from students where first_name='Test 0'");const sync=await one("select sync_management_change($1,'students','write',$2,$3) as result",[crypto.randomUUID(),{id:student.id,mother_address:'Edited mother address'},student.sync_version]);assert.equal(sync.result.status,'synced');assert.equal((await one('select mother_address from students where id=$1',[student.id])).mother_address,'Edited mother address');
 await db.exec('reset role;set role anon;');assert.equal((await db.query('select * from applications')).rows.length,0);assert.equal((await db.query('select * from students')).rows.length,0);
 await assert.rejects(()=>one('select submit_public_application($1,$2,$3,$4)',[link.token,crypto.randomUUID(),bad,docs]),/permission denied/);
 }finally{await db.close();}
});
