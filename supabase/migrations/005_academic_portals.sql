-- Apply after 004. Existing students, enrollment links and quarterly grades are retained.
begin;
alter table school_settings add column school_address text not null default '',add column contact_phone text not null default '',add column contact_email text not null default '',add column support_contact text not null default '',add column logo_url text not null default '',add constraint secure_logo_url check(logo_url='' or logo_url ~ '^https://');
alter table profiles add column active boolean not null default true,
 add column must_change_password boolean not null default false,
 add column teacher_code text unique,
 add column phone text not null default '';
update profiles set teacher_code='T-'||upper(replace(id::text,'-','')) where role='teacher';
create or replace function public.is_admin() returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from profiles where id=auth.uid() and role='admin' and active and not must_change_password) $$;
create function public.is_staff() returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from profiles where id=auth.uid() and active and not must_change_password) $$;
alter table school_years add column archived boolean not null default false,
 add column grade_min numeric not null default 0 check(grade_min between 0 and 100),
 add column grade_max numeric not null default 100 check(grade_max between 0 and 100),
 add column passing_mark numeric not null default 75,
 add column quarter_decimals integer not null default 2 check(quarter_decimals between 0 and 2),
 add column policy_approved boolean not null default true,
 add constraint valid_grade_policy check(grade_min<=grade_max and passing_mark between grade_min and grade_max),
 add constraint archived_year_inactive check(not(archived and active));
update school_years set passing_mark=(select pass_mark from school_settings where id=1);
alter table school_years alter column passing_mark drop default;
create function public.default_year_policy() returns trigger language plpgsql security definer set search_path=public as $$
begin new.passing_mark=coalesce(new.passing_mark,(select pass_mark from school_settings where id=1));return new;end $$;
create trigger default_year_policy before insert on school_years for each row execute function default_year_policy();
alter table sections add column capacity integer check(capacity>0), add column active boolean not null default true;
alter table subjects add column code text, add column active boolean not null default true;
create unique index subject_code_per_grade on subjects(grade_level_id,lower(trim(code))) where code is not null and trim(code)<>'';
alter table assignments add column active boolean not null default true;
do $$ begin if exists(select 1 from assignments group by section_id,subject_id having count(*)>1) then raise exception 'Preflight: multiple teachers share a subject/section. Resolve these assignments before applying 005; no data was changed.'; end if;end $$;
create unique index one_active_subject_teacher on assignments(section_id,subject_id) where active;
alter table enrollments add column active boolean not null default true;
alter table grades add column approval_status text not null default 'Legacy', add column passing_mark numeric;
alter table documents add column verification_status text not null default 'Pending' check(verification_status in ('Pending','Verified','Needs Correction')),
 add column remarks text not null default '';
alter table audit_logs add column before_data jsonb, add column after_data jsonb;
create or replace function public.audit_change() returns trigger language plpgsql security definer set search_path=public as $$
begin
 insert into audit_logs(actor,action,table_name,record_id,before_data,after_data)
 values(auth.uid(),TG_OP,TG_TABLE_NAME,coalesce(to_jsonb(new)->>'id',to_jsonb(old)->>'id'),to_jsonb(old),to_jsonb(new));
 return coalesce(new,old);
end $$;

create table grading_periods(id uuid primary key default gen_random_uuid(), school_year_id uuid not null references school_years,
 quarter integer not null check(quarter between 1 and 4), starts_at timestamptz, ends_at timestamptz, encoding_open boolean not null default false,
 sync_version bigint not null default 1, updated_at timestamptz not null default now(), unique(school_year_id,quarter),
 check(ends_at is null or starts_at is null or ends_at>starts_at), check(not encoding_open or (starts_at is not null and ends_at is not null)));
insert into grading_periods(school_year_id,quarter) select y.id,q from school_years y cross join generate_series(1,4) q;
create function public.initialize_school_year() returns trigger language plpgsql security definer set search_path=public as $$
begin insert into grading_periods(school_year_id,quarter) select new.id,q from generate_series(1,4) q; return new; end $$;
create trigger school_year_periods after insert on school_years for each row execute function initialize_school_year();
create table subject_offerings(id uuid primary key default gen_random_uuid(),school_year_id uuid not null references school_years,
 subject_id uuid not null references subjects,active boolean not null default true, sync_version bigint not null default 1,updated_at timestamptz not null default now(),unique(school_year_id,subject_id));
insert into subject_offerings(school_year_id,subject_id) select distinct s.school_year_id,a.subject_id from assignments a join sections s on s.id=a.section_id on conflict do nothing;
insert into subject_offerings(school_year_id,subject_id) select distinct e.school_year_id,g.subject_id from grades g join enrollments e on e.id=g.enrollment_id on conflict do nothing;
create table teacher_class_assignments(id uuid primary key default gen_random_uuid(),teacher_id uuid not null references profiles,section_id uuid not null references sections,
 active boolean not null default true, started_at timestamptz not null default now(),ended_at timestamptz,
 sync_version bigint not null default 1,updated_at timestamptz not null default now());
create unique index one_class_adviser on teacher_class_assignments(section_id) where active;
create table enrollment_history(id uuid primary key default gen_random_uuid(),enrollment_id uuid not null references enrollments,
 from_section_id uuid references sections,to_section_id uuid not null references sections,actor uuid references profiles,reason text not null,
 created_at timestamptz not null default now());
create table grade_submissions(id uuid primary key default gen_random_uuid(),assignment_id uuid not null references assignments,
 section_id uuid not null references sections,subject_id uuid not null references subjects,period_id uuid not null references grading_periods,
 teacher_id uuid not null references profiles,status text not null default 'Draft' check(status in ('Draft','Submitted','Under Review','Returned','Approved','Finalized')),
 entries jsonb not null default '{}' check(jsonb_typeof(entries)='object'), roster jsonb not null default '[]', policy jsonb not null default '{}',
 remarks text not null default '', exception_reason text not null default '',submitted_at timestamptz, reviewed_by uuid references profiles,
 sync_version bigint not null default 1,updated_at timestamptz not null default now(),unique(section_id,subject_id,period_id));
create table grade_revisions(id uuid primary key default gen_random_uuid(),submission_id uuid not null references grade_submissions,
 actor uuid not null references profiles,action text not null, before_data jsonb,after_data jsonb,remarks text not null default '',created_at timestamptz not null default now());
create table academic_operations(id uuid primary key,actor uuid not null references profiles,request jsonb not null,result jsonb not null,created_at timestamptz not null default now());
create index submission_review_queue on grade_submissions(status,period_id);
create index assignment_teacher on assignments(teacher_id,section_id) where active;
create index enrollment_section on enrollments(section_id) where active;
create index revision_submission on grade_revisions(submission_id,created_at);
create index history_enrollment on enrollment_history(enrollment_id,created_at);
create function public.guard_student_identity() returns trigger language plpgsql security definer set search_path=public as $$
declare identity_key text;
begin
 if TG_OP='UPDATE' then if (new.first_name,new.last_name,new.birth_date) is not distinct from (old.first_name,old.last_name,old.birth_date) then return new;end if;end if;
 identity_key=lower(trim(new.first_name))||'|'||lower(trim(new.last_name))||'|'||new.birth_date::text;
 perform pg_advisory_xact_lock(hashtextextended(identity_key,0));
 if exists(select 1 from students s where s.id<>new.id and lower(trim(s.first_name))=lower(trim(new.first_name)) and lower(trim(s.last_name))=lower(trim(new.last_name)) and s.birth_date=new.birth_date)
 and not exists(select 1 from applications a where a.reference=new.temporary_reference and a.identity_reviewed and a.student_id is null and length(trim(a.verification_reason))>0) then
 raise exception 'A student with matching name and birth date exists. Resolve identity review through the enrollment application before creating another profile';end if;
 return new;end $$;
create trigger guard_student_identity before insert or update on students for each row execute function guard_student_identity();

create or replace function public.can_view_enrollment(e uuid) returns boolean language sql stable security definer set search_path=public as $$
 select is_admin() or (is_staff() and exists(select 1 from enrollments n where n.id=e and n.active and (
 exists(select 1 from assignments a where a.section_id=n.section_id and a.teacher_id=auth.uid() and a.active) or
 exists(select 1 from teacher_class_assignments a where a.section_id=n.section_id and a.teacher_id=auth.uid() and a.active)))) $$;
-- Remove direct quarterly editing: only the validated finalization operation writes official grades.
drop policy admin_all on grades;
drop policy teacher_grade_update on grades;
create policy admin_grades_read on grades for select to authenticated using(is_admin());
revoke update on grades from authenticated;
revoke update(q1,q2,q3,q4) on grades from authenticated;
drop policy teacher_students on students;
-- Teachers get a limited projection, never the raw student/document table.
create function public.teacher_students() returns table(id uuid,lrn text,first_name text,last_name text,guardian_name text,guardian_contact text) language sql stable security definer set search_path=public as $$
 select s.id,s.lrn,s.first_name,s.last_name,
 case when s.guardian_available then s.guardian_name when s.mother_available then s.mother_name else s.father_name end,
 case when s.guardian_available then s.guardian_contact when s.mother_available then s.mother_contact else s.father_contact end
 from students s where is_staff() and exists(select 1 from enrollments e where e.student_id=s.id and can_view_enrollment(e.id)) $$;
drop policy teacher_assignments on assignments;
create policy teacher_assignments on assignments for select to authenticated using(is_staff() and teacher_id=auth.uid() and active);
do $$ declare t text; begin
 foreach t in array array['school_settings','school_years','grade_levels','sections','subjects'] loop
 execute format('drop policy staff_read on %I',t);
 execute format('create policy staff_read on %I for select to authenticated using(public.is_staff())',t);
 end loop;
 foreach t in array array['grading_periods','subject_offerings','teacher_class_assignments','enrollment_history','grade_submissions','grade_revisions','academic_operations'] loop
 execute format('alter table %I enable row level security',t);
 execute format('create policy admin_read on %I for select to authenticated using(public.is_admin())',t);
 execute format('grant select on %I to authenticated',t);
 execute format('revoke insert,update,delete on %I from authenticated,anon',t);
 end loop;
 foreach t in array array['grading_periods','subject_offerings','teacher_class_assignments','grade_submissions'] loop
 execute format('create trigger sync_version_stamp before insert or update on %I for each row execute function public.stamp_sync_version()',t);
 execute format('create trigger audit after insert or update or delete on %I for each row execute function public.audit_change()',t);
 end loop;
end $$;
create policy staff_periods on grading_periods for select to authenticated using(is_staff());
create policy staff_offerings on subject_offerings for select to authenticated using(is_staff());
create policy own_class on teacher_class_assignments for select to authenticated using(is_staff() and teacher_id=auth.uid() and active);
create policy own_history on enrollment_history for select to authenticated using(can_view_enrollment(enrollment_id));
create policy own_submissions on grade_submissions for select to authenticated using(is_staff() and teacher_id=auth.uid() and exists(select 1 from assignments a where a.section_id=grade_submissions.section_id and a.subject_id=grade_submissions.subject_id and a.teacher_id=auth.uid() and a.active));
create policy own_revisions on grade_revisions for select to authenticated using(exists(select 1 from grade_submissions s where s.id=submission_id));
-- Receipts can contain frozen personal records; expose them only through the authorized RPC.
drop policy own_receipts_read on sync_receipts;
drop policy own_receipts_insert on sync_receipts;
create policy own_receipts_read on sync_receipts for select to authenticated using(is_admin() and actor=auth.uid());
create policy own_receipts_insert on sync_receipts for insert to authenticated with check(is_admin() and actor=auth.uid());

create function public.teacher_directory() returns table(id uuid,full_name text,teacher_code text) language sql stable security definer set search_path=public as $$
 select p.id,p.full_name,p.teacher_code from profiles p where is_staff() and (p.id=auth.uid() or exists(
 select 1 from teacher_class_assignments c join enrollments e on e.section_id=c.section_id where c.teacher_id=p.id and c.active and can_view_enrollment(e.id))) $$;
-- New subject rows do not rewrite historical years. Offerings determine the curriculum for new enrollments.
drop trigger subject_backfill on subjects;
create or replace function public.assign_subjects() returns trigger language plpgsql security definer set search_path=public as $$
begin insert into grades(enrollment_id,subject_id) select new.id,s.id from subjects s join subject_offerings o on o.subject_id=s.id where s.grade_level_id=new.grade_level_id and s.active and o.active and o.school_year_id=new.school_year_id on conflict do nothing;return new;end $$;
create function public.offering_grades() returns trigger language plpgsql security definer set search_path=public as $$
begin if new.active then insert into grades(enrollment_id,subject_id) select e.id,new.subject_id from enrollments e join subjects s on s.grade_level_id=e.grade_level_id where s.id=new.subject_id and e.school_year_id=new.school_year_id and e.active on conflict do nothing;end if;return new;end $$;
create trigger offering_grades after insert or update on subject_offerings for each row execute function offering_grades();

-- Common guards apply to the old management API as well as the new portal.
create function public.guard_academic_record() returns trigger language plpgsql security definer set search_path=public as $$
declare yr uuid; sec uuid; cap integer; sid uuid; sub uuid;
begin
 if TG_OP='DELETE' then raise exception 'Deactivate or archive records to preserve history'; end if;
 if TG_TABLE_NAME='school_years' then
  if TG_OP='UPDATE' and old.archived then raise exception 'Archived school year is read only'; end if;
  if new.archived and exists(select 1 from grade_submissions g join grading_periods p on p.id=g.period_id where p.school_year_id=new.id and g.status<>'Finalized') then raise exception 'Finish all grade submissions before archiving this school year';end if;
  if TG_OP='UPDATE' and (new.grade_min,new.grade_max,new.passing_mark,new.quarter_decimals,new.policy_approved) is distinct from (old.grade_min,old.grade_max,old.passing_mark,old.quarter_decimals,old.policy_approved)
   and exists(select 1 from grade_submissions g join grading_periods p on p.id=g.period_id where p.school_year_id=new.id and g.status in ('Submitted','Under Review','Approved','Finalized')) then raise exception 'Grading policy is locked after submission'; end if;
  return new;
 elsif TG_TABLE_NAME in ('grading_periods','subject_offerings','sections','enrollments') then yr=new.school_year_id;
 elsif TG_TABLE_NAME in ('assignments','teacher_class_assignments') then select school_year_id into yr from sections where id=new.section_id;
 elsif TG_TABLE_NAME='grades' then select school_year_id into yr from enrollments where id=new.enrollment_id;
 elsif TG_TABLE_NAME='enrollment_links' then yr=new.school_year_id;
 elsif TG_TABLE_NAME='applications' then select school_year_id into yr from enrollment_links where id=new.link_id;
 elsif TG_TABLE_NAME='documents' then select l.school_year_id into yr from applications ap join enrollment_links l on l.id=ap.link_id where ap.id=new.application_id;
 end if;
 if exists(select 1 from school_years where id=yr and archived) then raise exception 'Archived school year is read only'; end if;
 if TG_TABLE_NAME='enrollments' then
  perform pg_advisory_xact_lock(hashtextextended(new.section_id::text,0));
  select capacity into cap from sections where id=new.section_id and active;
  if not found then raise exception 'Choose an active section'; end if;
  if new.active and cap is not null and (select count(*) from enrollments where section_id=new.section_id and active and id<>new.id)>=cap then raise exception 'Section capacity reached'; end if;
  if TG_OP='UPDATE' and (new.section_id,new.active) is distinct from (old.section_id,old.active) and exists(select 1 from grade_submissions g where g.section_id in (old.section_id,new.section_id) and g.status in ('Submitted','Under Review','Approved')) then raise exception 'Finish or return pending grade submissions before transferring students'; end if;
  if TG_OP='INSERT' then insert into enrollment_history(enrollment_id,to_section_id,actor,reason) values(new.id,new.section_id,auth.uid(),'Initial assignment');
  elsif new.section_id<>old.section_id then insert into enrollment_history(enrollment_id,from_section_id,to_section_id,actor,reason) values(new.id,old.section_id,new.section_id,auth.uid(),coalesce(nullif(current_setting('rzm.transfer_reason',true),''),'Section transfer')); end if;
 elsif TG_TABLE_NAME in ('assignments','teacher_class_assignments') then
  if not exists(select 1 from profiles where id=new.teacher_id and role='teacher' and active) then raise exception 'Choose an active teacher'; end if;
  if TG_OP='UPDATE' and (new.teacher_id,new.section_id) is distinct from (old.teacher_id,old.section_id) then raise exception 'Deactivate the old assignment and create a new one'; end if;
  if TG_TABLE_NAME='assignments' then
   if TG_OP='UPDATE' and new.subject_id<>old.subject_id then raise exception 'Create a new subject assignment'; end if;
   if TG_OP='UPDATE' and not new.active and exists(select 1 from grade_submissions where assignment_id=new.id and status in ('Submitted','Under Review','Approved')) then raise exception 'Return or finalize pending grades before deactivating assignment'; end if;
   if new.active and not exists(select 1 from subject_offerings o join subjects s on s.id=o.subject_id where o.school_year_id=yr and o.subject_id=new.subject_id and o.active and s.active) then raise exception 'Activate a subject offering for this school year first'; end if;
  end if;
 elsif TG_TABLE_NAME='sections' then
  if new.capacity is not null and new.capacity<(select count(*) from enrollments where section_id=new.id and active) then raise exception 'Capacity cannot be less than the current class size'; end if;
 end if;
 return new;
end $$;
-- Enrollment history references the newly inserted enrollment, so use an AFTER trigger.
do $$ declare t text; begin foreach t in array array['school_years','sections','enrollments','assignments','teacher_class_assignments','subject_offerings','grading_periods','grades','enrollment_links','applications','documents'] loop
 execute format('create trigger academic_guard after insert or update or delete on %I for each row execute function public.guard_academic_record()',t);
 end loop; end $$;
create function public.preserve_subject_catalog() returns trigger language plpgsql security definer set search_path=public as $$
begin if (new.name,new.code,new.grade_level_id) is distinct from (old.name,old.code,old.grade_level_id) and
 (exists(select 1 from grades where subject_id=old.id and coalesce(q1,q2,q3,q4) is not null) or exists(select 1 from subject_offerings o join school_years y on y.id=o.school_year_id where o.subject_id=old.id and y.archived)) then raise exception 'This subject has academic history. Create a new subject to preserve the historical curriculum';end if;return new;end $$;
create trigger preserve_subject_catalog before update on subjects for each row execute function preserve_subject_catalog();
create function public.require_application_reason() returns trigger language plpgsql as $$
begin if new.status in ('Rejected','Incomplete') and (TG_OP='INSERT' or new.status<>old.status) and length(trim(coalesce(new.note,'')))=0 then raise exception 'A rejection or correction reason is required'; end if;return new;end $$;
create trigger application_reason before insert or update on applications for each row execute function require_application_reason();

-- Only a constrained administrator RPC can modify new configuration tables.
create function public.academic_admin_save(target_table text,payload jsonb,expected_version bigint default null) returns jsonb language plpgsql security definer set search_path=public as $$
declare allowed text[]; field text; current_row jsonb; result_row jsonb; cols text; vals text; sets text; record_id text;
begin
 if not is_admin() then raise exception 'Administrator access required'; end if;
 allowed=case target_table
 when 'school_settings' then array['school_name','pass_mark','school_address','contact_phone','contact_email','support_contact','logo_url']
 when 'grade_levels' then array['name','rank']
 when 'school_years' then array['name','active','archived','grade_min','grade_max','passing_mark','quarter_decimals','policy_approved']
 when 'grading_periods' then array['starts_at','ends_at','encoding_open']
 when 'sections' then array['name','grade_level_id','school_year_id','capacity','active']
 when 'subjects' then array['name','grade_level_id','code','active']
 when 'subject_offerings' then array['school_year_id','subject_id','active']
 when 'assignments' then array['teacher_id','section_id','subject_id','active']
 when 'teacher_class_assignments' then array['teacher_id','section_id','active','ended_at']
 when 'documents' then array['verification_status','remarks']
 when 'enrollments' then array['student_id','grade_level_id','school_year_id','section_id','active'] end;
 if allowed is null then raise exception 'Unsupported configuration table'; end if;
 for field in select jsonb_object_keys(payload) loop if field<>'id' and not field=any(allowed) then raise exception 'Unsupported field: %',field; end if; end loop;
 record_id=coalesce(payload->>'id',gen_random_uuid()::text); payload=payload||jsonb_build_object('id',record_id);
 perform pg_advisory_xact_lock(hashtextextended(target_table||record_id::text,0));
 execute format('select to_jsonb(r) from %I r where id::text=$1 for update',target_table) into current_row using record_id;
 if (current_row is null and expected_version is not null) or (current_row is not null and (expected_version is null or (current_row->>'sync_version')::bigint<>expected_version)) then raise exception 'Record changed. Refresh before saving'; end if;
 if target_table='documents' and payload->>'verification_status'='Needs Correction' and length(trim(coalesce(payload->>'remarks','')))=0 then raise exception 'Verification remarks are required'; end if;
 if current_row is null then
  if target_table in ('documents','grading_periods','school_settings') then raise exception 'Record must already exist'; end if;
  select string_agg(format('%I',k),','),string_agg(format('v.%I',k),',') into cols,vals from jsonb_object_keys(payload) k;
  execute format('insert into %I (%s) select %s from jsonb_populate_record(null::%I,$1) v returning to_jsonb(%I.*)',target_table,cols,vals,target_table,target_table) into result_row using payload;
 else
  select string_agg(format('%I=v.%I',k,k),',') into sets from jsonb_object_keys(payload) k where k<>'id';
  if sets is null then raise exception 'No changes supplied'; end if;
  execute format('update %I r set %s from jsonb_populate_record(null::%I,$1) v where r.id::text=$2 returning to_jsonb(r.*)',target_table,sets,target_table) into result_row using payload,record_id;
 end if; return result_row;
end $$;

-- Server-authorized rosters preserve corrections after a section transfer.
create function public.grade_roster(assignment uuid,period uuid) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare a assignments; p grading_periods; s grade_submissions; result jsonb;
begin
 if not is_staff() then raise exception 'Active staff access required';end if;
 select * into a from assignments where id=assignment;
 select * into p from grading_periods where id=period;
 if a.id is null or p.id is null or not a.active or not exists(select 1 from sections where id=a.section_id and school_year_id=p.school_year_id) then raise exception 'Invalid assignment or period';end if;
 if not is_admin() and a.teacher_id<>auth.uid() then raise exception 'Only the assigned teacher can view this roster';end if;
 select * into s from grade_submissions where section_id=a.section_id and subject_id=a.subject_id and period_id=p.id;
 if s.id is not null and s.status<>'Draft' then return s.roster;end if;
 select coalesce(jsonb_agg(jsonb_build_object('enrollment_id',e.id,'student_id',st.id,'name',st.last_name||', '||st.first_name,'lrn',st.lrn) order by st.last_name,st.first_name,e.id),'[]') into result
 from enrollments e join students st on st.id=e.student_id where e.section_id=a.section_id and e.school_year_id=p.school_year_id and e.active
 and not exists(select 1 from grade_submissions prior where prior.period_id=p.id and prior.subject_id=a.subject_id and prior.section_id<>a.section_id and prior.status<>'Draft' and exists(select 1 from jsonb_array_elements(prior.roster) r where r->>'enrollment_id'=e.id::text));
 return result;
end $$;

create function public.grade_workflow(operation uuid,action text,assignment uuid,period uuid,expected_version bigint default null,entries jsonb default '{}',remarks text default '') returns jsonb
language plpgsql security definer set search_path=public as $$
declare a assignments; p grading_periods; y school_years; s grade_submissions; before_row jsonb; req jsonb; receipt academic_operations;
 roster_now jsonb; item record; val numeric; result jsonb; n integer; invalid integer; target text; complete boolean; is_new boolean:=false; policy_now jsonb;
begin
 if not is_staff() then raise exception 'Active staff access required'; end if;
 if operation is null then raise exception 'Operation UUID required'; end if;
 req=jsonb_build_object('action',action,'assignment',assignment,'period',period,'expected',expected_version,'entries',entries,'remarks',remarks);
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||operation::text,0));
 select * into receipt from academic_operations where id=operation;
 if found then
  if receipt.actor<>auth.uid() or receipt.request<>req then raise exception 'Operation UUID reused'; end if;
  if not is_admin() and not exists(select 1 from assignments assigned join profiles pr on pr.id=assigned.teacher_id where assigned.id=assignment and assigned.teacher_id=auth.uid() and assigned.active and pr.can_grade) then raise exception 'Only the assigned teacher can access this receipt';end if;
  return receipt.result;
 end if;
 select * into a from assignments where id=assignment for share;
 select * into p from grading_periods where id=period for share;
 select * into y from school_years where id=p.school_year_id for share;
 if a.id is null or p.id is null or not a.active or y.archived or not exists(select 1 from sections where id=a.section_id and school_year_id=p.school_year_id) then raise exception 'Assignment and period must belong to an active school year'; end if;
 if not is_admin() and (a.teacher_id<>auth.uid() or not exists(select 1 from profiles where id=auth.uid() and can_grade)) then raise exception 'Only the assigned teacher can encode these grades'; end if;
 if not exists(select 1 from subject_offerings o join subjects sj on sj.id=o.subject_id where o.subject_id=a.subject_id and o.school_year_id=y.id and o.active and sj.active) then raise exception 'Subject offering is inactive'; end if;
 perform pg_advisory_xact_lock(hashtextextended(a.section_id::text,0));
 perform pg_advisory_xact_lock(hashtextextended(a.section_id::text||a.subject_id::text||period::text,0));
 select * into s from grade_submissions where section_id=a.section_id and subject_id=a.subject_id and period_id=period for update;
 if (s.id is null and expected_version is not null) or (s.id is not null and (expected_version is null or expected_version<>s.sync_version)) then return jsonb_build_object('status','conflict','record',to_jsonb(s)); end if;
 before_row=to_jsonb(s);
 if s.id is null then
  if action<>'save' then raise exception 'Save a draft before submitting'; end if;
  is_new=true;s.status='Draft';s.exception_reason='';
 end if;
 if action in ('save','submit') then
  if s.status not in ('Draft','Returned') then raise exception 'Submitted grades are locked. Request an authorized reopening'; end if;
  if not p.encoding_open or now()<p.starts_at or now()>p.ends_at then raise exception 'Grade encoding period is closed'; end if;
  if not y.policy_approved then raise exception 'Administrator must approve the grading policy first'; end if;
  roster_now=grade_roster(a.id,p.id);
  if exists(select 1 from jsonb_array_elements(roster_now) r where not exists(select 1 from enrollments e where e.id=(r->>'enrollment_id')::uuid and e.active and e.school_year_id=y.id)) then raise exception 'A learner in this frozen roster is no longer actively enrolled';end if;
  if jsonb_typeof(entries)<>'object' or entries is null then raise exception 'Grades must be an object'; end if;
  for item in select * from jsonb_each(entries) loop
   if not exists(select 1 from jsonb_array_elements(roster_now) r where r->>'enrollment_id'=item.key) then raise exception 'Student is not actively enrolled in this class'; end if;
   if item.value<>'null'::jsonb then
    if jsonb_typeof(item.value)<>'number' then raise exception 'Grades must be numeric'; end if;
    val=(item.value::text)::numeric;
    if val<y.grade_min or val>y.grade_max or val<>round(val,y.quarter_decimals) then raise exception 'Grade outside the approved range or decimal precision'; end if;
   end if;
  end loop;
  select count(*) into invalid from jsonb_array_elements(roster_now) r where not(entries ? (r->>'enrollment_id')) or entries->(r->>'enrollment_id')='null'::jsonb;
  if action='submit' and (jsonb_array_length(roster_now)=0 or (invalid>0 and s.exception_reason='')) then raise exception 'Every student requires a grade before submission'; end if;
  policy_now=jsonb_build_object('minimum',y.grade_min,'maximum',y.grade_max,'passing_mark',y.passing_mark,'quarter_decimals',y.quarter_decimals,'final_rule','round_four_quarter_average');
  if is_new then
   insert into grade_submissions(assignment_id,section_id,subject_id,period_id,teacher_id,entries,roster,policy) values(a.id,a.section_id,a.subject_id,p.id,a.teacher_id,grade_workflow.entries,roster_now,policy_now) returning * into s;
  else
  update grade_submissions set assignment_id=a.id,teacher_id=a.teacher_id,entries=grade_workflow.entries,roster=roster_now,
   policy=policy_now,
   status=case when action='submit' then 'Submitted' else s.status end,submitted_at=case when action='submit' then now() else null end,reviewed_by=null
   where id=s.id returning * into s;
  end if;
 elsif action='exception' then
  if not is_admin() or s.status not in ('Draft','Returned') or length(trim(remarks))<3 then raise exception 'An administrator must give a reason for an incomplete-submission exception'; end if;
  update grade_submissions set exception_reason=grade_workflow.remarks where id=s.id returning * into s;
 else
  if not is_admin() then raise exception 'Administrator access required to review grades'; end if;
  target=case action when 'review' then 'Under Review' when 'approve' then 'Approved' when 'return' then 'Returned' when 'finalize' then 'Finalized' when 'reopen' then 'Returned' end;
  if target is null or not ((action='review' and s.status='Submitted') or (action='approve' and s.status='Under Review') or (action='return' and s.status in ('Submitted','Under Review')) or (action='finalize' and s.status='Approved') or (action='reopen' and s.status in ('Approved','Finalized'))) then raise exception 'Invalid grade status transition'; end if;
  if action in ('return','reopen') and length(trim(remarks))<3 then raise exception 'Correction or reopening remarks are required'; end if;
  if action='finalize' then
   for item in select * from jsonb_array_elements(s.roster) loop
    -- A transfer after finalization preserves the old submission and official history.
    if not exists(select 1 from enrollments where id=(item.value->>'enrollment_id')::uuid and active and school_year_id=y.id) then raise exception 'Class roster changed. Return these grades for correction'; end if;
    val=nullif(s.entries->>(item.value->>'enrollment_id'),'')::numeric;
    insert into grades(enrollment_id,subject_id) values((item.value->>'enrollment_id')::uuid,s.subject_id) on conflict do nothing;
    execute format('update grades set q%s=$1,approval_status=''Partial'',passing_mark=$2 where enrollment_id=$3 and subject_id=$4',p.quarter)
     using val,(s.policy->>'passing_mark')::numeric,(item.value->>'enrollment_id')::uuid,s.subject_id;
   end loop;
  end if;
  update grade_submissions set status=target,remarks=grade_workflow.remarks,reviewed_by=auth.uid() where id=s.id returning * into s;
  -- Official status needs four finalized quarters for this enrollment and subject, including historical sections.
  if action in ('finalize','reopen') then
   for item in select * from jsonb_array_elements(s.roster) loop
    select count(distinct gp.quarter)=4 into complete from grade_submissions gs join grading_periods gp on gp.id=gs.period_id
     where gs.subject_id=s.subject_id and gp.school_year_id=y.id and gs.status='Finalized' and gs.entries ? (item.value->>'enrollment_id') and gs.entries->(item.value->>'enrollment_id')<>'null'::jsonb;
    update grades set approval_status=case when complete then 'Finalized' when action='reopen' then 'Correction pending' else 'Partial' end
     where enrollment_id=(item.value->>'enrollment_id')::uuid and subject_id=s.subject_id;
   end loop;
  end if;
 end if;
 insert into grade_revisions(submission_id,actor,action,before_data,after_data,remarks) values(s.id,auth.uid(),action,before_row,to_jsonb(s),grade_workflow.remarks);
 result=jsonb_build_object('status','synced','record',to_jsonb(s));
 insert into academic_operations(id,actor,request,result) values(operation,auth.uid(),req,result);
 return result;
end $$;

-- Promotion cannot use unreviewed legacy or partially approved grades.
alter function public.promote_student(uuid,uuid,uuid) rename to promote_student_legacy;
revoke all on function public.promote_student_legacy(uuid,uuid,uuid) from public,anon,authenticated;
create function public.promote_student(enrollment uuid,target_year uuid,target_section uuid) returns uuid language plpgsql security definer set search_path=public as $$
declare n enrollments; next_grade uuid; result uuid;
begin
 if not is_admin() then raise exception 'Admin access required'; end if;
 select * into n from enrollments where id=enrollment for update;
 if n.id is null or n.school_year_id=target_year then raise exception 'Choose a different school year'; end if;
 if not exists(select 1 from grades where enrollment_id=enrollment) or exists(select 1 from grades where enrollment_id=enrollment and (approval_status<>'Finalized' or final_grade is null or final_grade<passing_mark)) then raise exception 'All subjects require finalized passing grades'; end if;
 select id into next_grade from grade_levels where rank=(select rank+1 from grade_levels where id=n.grade_level_id);
 if next_grade is null then raise exception 'No next grade level'; end if;
 insert into enrollments(student_id,school_year_id,grade_level_id,section_id) values(n.student_id,target_year,next_grade,target_section) returning id into result;return result;
end $$;
create function public.record_staff_login() returns void language plpgsql security definer set search_path=public as $$
begin if not exists(select 1 from profiles where id=auth.uid() and active) then raise exception 'Active staff access required'; end if;insert into audit_logs(actor,action,table_name,record_id) values(auth.uid(),'LOGIN','profiles',auth.uid()::text);end $$;
do $$ declare f text; begin foreach f in array array['is_staff()','teacher_students()','teacher_directory()','grade_roster(uuid,uuid)','academic_admin_save(text,jsonb,bigint)','grade_workflow(uuid,text,uuid,uuid,bigint,jsonb,text)','record_staff_login()','promote_student(uuid,uuid,uuid)'] loop
 execute 'revoke all on function public.'||f||' from public,anon';execute 'grant execute on function public.'||f||' to authenticated';end loop;end $$;
-- Trigger helpers cannot be invoked as RPC endpoints.
revoke all on function initialize_school_year(),guard_academic_record(),require_application_reason(),offering_grades(),default_year_policy(),guard_student_identity(),preserve_subject_catalog() from public,anon,authenticated;
-- Closing a school year also prevents submissions through an old, still-published link.
alter function public.submit_public_application(uuid,uuid,jsonb,jsonb) rename to submit_public_application_legacy;
revoke all on function submit_public_application_legacy(uuid,uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
create function public.submit_public_application(link_token uuid,submission uuid,details jsonb,uploaded_documents jsonb) returns jsonb language plpgsql security definer set search_path=public as $$
declare y school_years;
begin select sy.* into y from school_years sy join enrollment_links l on l.school_year_id=sy.id where l.token=link_token for share of sy;
 if y.archived then raise exception 'This school year is archived'; end if;
 return submit_public_application_legacy(link_token,submission,details,uploaded_documents);end $$;
revoke all on function submit_public_application(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function submit_public_application(uuid,uuid,jsonb,jsonb) to service_role;
commit;
