-- Apply AFTER 001 and 002. Existing applications/students are retained.
begin;
create sequence public.temporary_enrollment_sequence;
alter table public.applications
 add column submission_id uuid unique,
 add column submission_fingerprint text,
 add column lrn_status text not null default 'Needs Verification' check(lrn_status in ('Pending Assignment','Needs Verification','Verified')),
 add column lrn_verified_at timestamptz,
 add column identity_reviewed boolean not null default false,
 add column lrn_review_required boolean not null default false,
 add column suspected_duplicate boolean not null default false,
 add column verification_reason text not null default '';
alter table public.students
 add column temporary_reference text unique,
 add column lrn_status text not null default 'Pending Assignment' check(lrn_status in ('Pending Assignment','Verified'));
update students set lrn_status=case when lrn is null then 'Pending Assignment' else 'Verified' end;
update applications set lrn_status=case when lrn is null then 'Pending Assignment' when status in ('Approved','Enrolled') then 'Verified' else 'Needs Verification' end;
create function public.student_lrn_status() returns trigger language plpgsql set search_path=public as $$ begin new.lrn_status=case when new.lrn is null then 'Pending Assignment' else 'Verified' end;return new;end $$;
create trigger student_lrn_status before insert or update on students for each row execute function public.student_lrn_status();
-- Assigning/correcting an official LRN updates linked applications and existing audit logs.
create function public.propagate_student_lrn() returns trigger language plpgsql security definer set search_path=public as $$ begin
 update applications set lrn=new.lrn,lrn_status=case when new.lrn is null then 'Pending Assignment' else 'Verified' end where student_id=new.id and (lrn is null or lrn is not distinct from old.lrn);return new;
end $$;
create trigger propagate_student_lrn after update of lrn on students for each row when(old.lrn is distinct from new.lrn) execute function public.propagate_student_lrn();
-- Editing a pending application after verification requires a fresh staff decision.
create function public.invalidate_lrn_review() returns trigger language plpgsql set search_path=public as $$ begin
 if new.status not in ('Enrolled','Approved','Rejected') and new.lrn_verified_at is not distinct from old.lrn_verified_at and row(new.lrn,new.first_name,new.last_name,new.birth_date) is distinct from row(old.lrn,old.first_name,old.last_name,old.birth_date) then
 new.identity_reviewed=false;new.lrn_review_required=true;new.lrn_status='Needs Verification';new.verification_reason='Learner details or LRN changed after submission; staff verification required';end if;return new;
end $$;
create trigger invalidate_lrn_review before update on applications for each row execute function public.invalidate_lrn_review();
-- Legacy duplicate applications are retained and flagged rather than deleted to build an index.
update applications a set suspected_duplicate=true,lrn_review_required=true,verification_reason='Existing active applications share an LRN in this school year; staff review required'
 where a.lrn is not null and a.status<>'Rejected' and exists(select 1 from applications b join enrollment_links l on l.id=b.link_id join enrollment_links own on own.id=a.link_id where b.id<>a.id and b.lrn=a.lrn and b.status<>'Rejected' and l.school_year_id=own.school_year_id);
-- A transaction lock and guarded trigger also protect older management writes and imports.
create function public.guard_year_lrn() returns trigger language plpgsql security definer set search_path=public as $$ declare y uuid;begin
 if new.lrn is null or new.status='Rejected' then return new;end if;
 if TG_OP='UPDATE' and new.lrn is not distinct from old.lrn and new.link_id=old.link_id and old.status<>'Rejected' then return new;end if;
 select school_year_id into y from enrollment_links where id=new.link_id;
 perform pg_advisory_xact_lock(hashtextextended(y::text||new.lrn,0));
 if exists(select 1 from applications a join enrollment_links l on l.id=a.link_id where a.id<>new.id and a.lrn=new.lrn and a.status<>'Rejected' and l.school_year_id=y) then raise exception using errcode='23505',message='ACTIVE_LRN_APPLICATION';end if;return new;end $$;
create trigger guard_year_lrn before insert or update on applications for each row execute function public.guard_year_lrn();
create table public.enrollment_rate_limits(bucket text primary key,window_start timestamptz not null,hits int not null);
alter table public.enrollment_rate_limits enable row level security;
revoke all on public.enrollment_rate_limits from public,anon,authenticated;
create function public.consume_enrollment_limit(bucket_key text,maximum int,window_seconds int default 60) returns boolean language plpgsql security definer set search_path=public as $$ declare n int;begin
 delete from enrollment_rate_limits where window_start<now()-interval '1 day';
 insert into enrollment_rate_limits(bucket,window_start,hits) values(bucket_key,now(),1) on conflict(bucket) do update set hits=case when enrollment_rate_limits.window_start<now()-make_interval(secs=>window_seconds) then 1 else enrollment_rate_limits.hits+1 end,window_start=case when enrollment_rate_limits.window_start<now()-make_interval(secs=>window_seconds) then now() else enrollment_rate_limits.window_start end returning hits into n;return n<=maximum;end $$;
revoke all on function public.consume_enrollment_limit(text,int,int) from public,anon,authenticated;
grant execute on function public.consume_enrollment_limit(text,int,int) to service_role;
create function public.check_public_lrn(link_token uuid,official_lrn text,learner_type text) returns jsonb language plpgsql security definer set search_path=public as $$ declare l enrollment_links;begin
 select * into l from enrollment_links where token=link_token and published and not archived and now() between opens_at and closes_at;
 if l.id is null then raise exception 'LINK_UNAVAILABLE';end if;
 if official_lrn is null or learner_type is null or official_lrn!~'^[0-9]{12}$' or learner_type not in ('New','Returning','Transferee') then raise exception 'INVALID_LRN';end if;
 if exists(select 1 from applications a join enrollment_links e on e.id=a.link_id where a.lrn=official_lrn and a.status<>'Rejected' and e.school_year_id=l.school_year_id) then return jsonb_build_object('status','duplicate_application');end if;
 if exists(select 1 from students where lrn=official_lrn) then return jsonb_build_object('status',case when learner_type='New' then 'existing_new' else 'needs_review' end);end if;
 return jsonb_build_object('status','eligible');end $$;
revoke all on function public.check_public_lrn(uuid,text,text) from public,anon,authenticated;
grant execute on function public.check_public_lrn(uuid,text,text) to service_role;
create function public.submit_public_application(link_token uuid,submission uuid,details jsonb,uploaded_documents jsonb) returns jsonb language plpgsql security definer set search_path=public as $$
declare l enrollment_links; prior applications; a applications; clean jsonb; official text; ref text; possible boolean; known boolean; needs_review boolean; field text; doc jsonb; fingerprint text; counter bigint;
begin
 if submission is null then raise exception 'INVALID_SUBMISSION';end if;
 select * into l from enrollment_links where token=link_token and published and not archived and now() between opens_at and closes_at for share;
 if l.id is null then raise exception 'LINK_UNAVAILABLE';end if;
 for field in select unnest(array['first_name','last_name','birth_date','sex','address','contact','guardian_name','guardian_contact','grade_level_id','enrollment_type']) loop
 if jsonb_typeof(details->field)<>'string' or nullif(trim(details->>field),'') is null or length(details->>field)>1000 then raise exception 'INVALID_DETAILS';end if;end loop;
 if coalesce(jsonb_typeof(details->'lrn'),'null') not in ('string','null') or coalesce(jsonb_typeof(details->'has_lrn'),'')<>'boolean' then raise exception 'INVALID_LRN';end if;
 official=nullif(details->>'lrn','');
 if (details->>'has_lrn'='true' and official is null) or (details->>'has_lrn'='false' and official is not null) then raise exception 'INVALID_LRN';end if;
 if official is not null and official!~'^[0-9]{12}$' then raise exception 'INVALID_LRN';end if;
 if details->>'enrollment_type' not in ('New','Returning','Transferee') or details->>'sex' not in ('Male','Female') or not (details->>'grade_level_id')::uuid=any(l.allowed_grade_ids) then raise exception 'INVALID_DETAILS';end if;
 if details->>'birth_date'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or (details->>'birth_date')::date>current_date then raise exception 'INVALID_DETAILS';end if;
 clean=details-'submission_id';fingerprint=md5(clean::text);
 perform pg_advisory_xact_lock(hashtextextended(submission::text,0));
 select * into prior from applications where submission_id=submission;
 if found then if prior.link_id<>l.id or prior.submission_fingerprint<>fingerprint then raise exception 'SUBMISSION_CHANGED';end if;return jsonb_build_object('reference',prior.reference,'lrn_status',prior.lrn_status,'replayed',true);end if;
 if official is not null then
 perform pg_advisory_xact_lock(hashtextextended(l.school_year_id::text||official,0));
 if exists(select 1 from applications p join enrollment_links e on e.id=p.link_id where p.lrn=official and p.status<>'Rejected' and e.school_year_id=l.school_year_id) then raise exception 'ACTIVE_LRN_APPLICATION';end if;
 select exists(select 1 from students where lrn=official) into known;
 if known and details->>'enrollment_type'='New' then raise exception 'EXISTING_LRN_CONTACT_SCHOOL';end if;
 else known=false;end if;
 perform pg_advisory_xact_lock(hashtextextended(lower(trim(details->>'first_name'))||'|'||lower(trim(details->>'last_name'))||'|'||(details->>'birth_date')::date::text,0));
 possible=exists(select 1 from students s where lower(trim(s.first_name))=lower(trim(details->>'first_name')) and lower(trim(s.last_name))=lower(trim(details->>'last_name')) and s.birth_date=(details->>'birth_date')::date) or exists(select 1 from applications p join enrollment_links e on e.id=p.link_id where p.status<>'Rejected' and e.school_year_id=l.school_year_id and lower(trim(p.first_name))=lower(trim(details->>'first_name')) and lower(trim(p.last_name))=lower(trim(details->>'last_name')) and p.birth_date=(details->>'birth_date')::date);
 needs_review=known or possible or (official is null and details->>'enrollment_type'<>'New');
 if official is null and details->>'enrollment_type'='New' then counter=nextval('temporary_enrollment_sequence');ref='RZM-TEMP-'||extract(year from now())::int||'-'||lpad(counter::text,greatest(6,length(counter::text)),'0');else ref='RZM-'||upper(replace(gen_random_uuid()::text,'-',''));end if;
 if jsonb_typeof(uploaded_documents)<>'array' or jsonb_array_length(uploaded_documents)<>2 then raise exception 'MISSING_DOCUMENTS';end if;
 if not exists(select 1 from jsonb_array_elements(uploaded_documents) d where d->>'kind'='Photo') or not exists(select 1 from jsonb_array_elements(uploaded_documents) d where d->>'kind'='Birth Certificate') then raise exception 'MISSING_DOCUMENTS';end if;
 insert into applications(submission_id,submission_fingerprint,reference,link_id,grade_level_id,lrn,first_name,last_name,birth_date,sex,address,contact,guardian_name,guardian_contact,previous_school,enrollment_type,extra_answers,lrn_status,lrn_review_required,suspected_duplicate,verification_reason)
 values(submission,fingerprint,ref,l.id,(details->>'grade_level_id')::uuid,official,trim(details->>'first_name'),trim(details->>'last_name'),(details->>'birth_date')::date,details->>'sex',trim(details->>'address'),trim(details->>'contact'),trim(details->>'guardian_name'),trim(details->>'guardian_contact'),left(coalesce(details->>'previous_school',''),300),details->>'enrollment_type',coalesce(details->'extra_answers','{}'::jsonb),case when official is null and details->>'enrollment_type'='New' then 'Pending Assignment' else 'Needs Verification' end,needs_review,possible,case when known then 'Existing official LRN: confirm the learner record' when possible then 'Possible matching learner details: review before creating a student' when needs_review then 'Returning/transferring learner without a known LRN' else '' end) returning * into a;
 for doc in select * from jsonb_array_elements(uploaded_documents) loop
 if nullif(doc->>'path','') is null then raise exception 'MISSING_DOCUMENTS';end if;
 insert into documents(application_id,kind,path) values(a.id,doc->>'kind',doc->>'path');end loop;
 return jsonb_build_object('reference',a.reference,'lrn_status',a.lrn_status,'replayed',false);
end $$;
revoke all on function public.submit_public_application(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.submit_public_application(uuid,uuid,jsonb,jsonb) to service_role;
create function public.resolve_lrn_review(application uuid,existing_student uuid,official_lrn text,resolution_note text) returns void language plpgsql security definer set search_path=public as $$
declare a applications; s students; official text:=nullif(official_lrn,'');begin
 if not is_admin() then raise exception 'Admin access required';end if;
 if nullif(trim(resolution_note),'') is null then raise exception 'Explain the verification decision';end if;
 if official is not null and official!~'^[0-9]{12}$' then raise exception 'LRN must have exactly 12 digits';end if;
 select * into a from applications where id=application for update;if a.id is null or a.status in ('Enrolled','Approved','Rejected') then raise exception 'Application cannot be reviewed';end if;
 if existing_student is not null then select * into s from students where id=existing_student for update;if s.id is null then raise exception 'Student not found';end if;
 if s.lrn is not null and official is not null and s.lrn<>official then raise exception 'Selected student has a different official LRN';end if;
 official=coalesce(official,s.lrn);if s.lrn is null and official is not null then update students set lrn=official where id=s.id;end if;
 else if official is not null and exists(select 1 from students where lrn=official) then raise exception 'Select the existing learner record for this LRN';end if;end if;
 update applications set student_id=existing_student,lrn=official,lrn_verified_at=clock_timestamp(),identity_reviewed=true,lrn_review_required=false,suspected_duplicate=false,lrn_status=case when official is null then 'Pending Assignment' else 'Verified' end,verification_reason=left(trim(resolution_note),1000) where id=a.id;
end $$;
revoke all on function public.resolve_lrn_review(uuid,uuid,text,text) from public,anon;
grant execute on function public.resolve_lrn_review(uuid,uuid,text,text) to authenticated;
-- Approval continues to be admin-only; verified re-enrollment reuses the student record.
create or replace function public.approve_application(application uuid, section uuid) returns uuid language plpgsql security definer set search_path=public as $$ declare a applications; s uuid; y uuid;begin
 if not is_admin() then raise exception 'Admin access required';end if;
 select * into a from applications where id=application for update;if a.id is null or a.status in ('Approved','Enrolled','Rejected') then raise exception 'Application cannot be approved';end if;
 if a.lrn_review_required or a.suspected_duplicate then raise exception 'Resolve LRN/duplicate review before approval';end if;
 select school_year_id into y from enrollment_links where id=a.link_id;
 if not exists(select 1 from sections where id=section and grade_level_id=a.grade_level_id and school_year_id=y) then raise exception 'Choose a section for this grade and year';end if;
 perform pg_advisory_xact_lock(hashtextextended(lower(trim(a.first_name))||'|'||lower(trim(a.last_name))||'|'||a.birth_date::text,0));
 if a.lrn is null and a.student_id is null and not a.identity_reviewed and exists(select 1 from students where lower(trim(first_name))=lower(trim(a.first_name)) and lower(trim(last_name))=lower(trim(a.last_name)) and birth_date=a.birth_date) then raise exception 'Resolve matching learner review before approval';end if;
 s=a.student_id;if s is null and a.lrn is not null then select id into s from students where lrn=a.lrn;end if;
 if s is null then insert into students(lrn,first_name,last_name,birth_date,sex,address,contact,guardian_name,guardian_contact,temporary_reference) values(a.lrn,a.first_name,a.last_name,a.birth_date,a.sex,a.address,a.contact,a.guardian_name,a.guardian_contact,case when a.lrn is null then a.reference else null end) returning id into s;
 else if not exists(select 1 from students where id=s and (lrn is not distinct from a.lrn)) then raise exception 'Verify the selected learner LRN again';end if;update students set first_name=a.first_name,last_name=a.last_name,birth_date=a.birth_date,sex=a.sex,address=a.address,contact=a.contact,guardian_name=a.guardian_name,guardian_contact=a.guardian_contact where id=s;end if;
 insert into enrollments(student_id,school_year_id,grade_level_id,section_id) values(s,y,a.grade_level_id,section);
 update applications set status='Enrolled',student_id=s,lrn_status=case when a.lrn is null then 'Pending Assignment' else 'Verified' end where id=a.id;return s;
end $$;

-- Extend the existing offline receipt protocol without altering migration 002.
create or replace function public.sync_management_change(operation uuid,target_table text,kind text,payload jsonb,expected_version bigint default null) returns jsonb
language plpgsql security invoker set search_path=public as $$
declare actor_id uuid:=auth.uid(); req jsonb; prior public.sync_receipts; current_row jsonb; result_row jsonb; result jsonb; cols text; vals text; sets text; allowed text[]; field text; record_id text; affected bigint;
begin
 if actor_id is null then raise exception 'Authentication required'; end if;
 if kind in ('approve','promote','review_lrn') and not public.is_admin() then raise exception 'Admin access required';end if;
 if operation is null then raise exception 'Operation UUID required'; end if;
 req=jsonb_build_object('table',target_table,'kind',kind,'payload',payload,'expected',expected_version);
 perform pg_advisory_xact_lock(hashtextextended(actor_id::text||operation::text,0));
 select * into prior from public.sync_receipts where actor=actor_id and sync_receipts.operation=sync_management_change.operation;
 if found then if prior.request<>req then raise exception 'Operation UUID reused with a different request'; end if;return prior.result;end if;
 allowed=case target_table
 when 'students' then array['lrn','first_name','last_name','birth_date','sex','address','contact','guardian_name','guardian_contact']
 when 'enrollment_links' then array['token','title','school_year_id','allowed_grade_ids','published','archived','opens_at','closes_at','instructions','extra_questions']
 when 'applications' then array['lrn','first_name','last_name','birth_date','sex','address','contact','guardian_name','guardian_contact','previous_school','note','status']
 when 'school_settings' then array['school_name','pass_mark']
 when 'school_years' then array['name','active']
 when 'grade_levels' then array['name','rank']
 when 'sections' then array['name','grade_level_id','school_year_id']
 when 'subjects' then array['name','grade_level_id']
 when 'assignments' then array['teacher_id','section_id','subject_id']
 when 'grades' then array['q1','q2','q3','q4']
 when 'enrollments' then array[]::text[]
 when 'profiles' then array['full_name','role','can_grade'] end;
 if allowed is null then raise exception 'Table is not editable offline'; end if;
 if kind='write' then
  record_id=payload->>'id';
  for field in select jsonb_object_keys(payload) loop if field<>'id' and not field=any(allowed) then raise exception 'Field not editable: %',field;end if;end loop;
 elsif kind='approve' and target_table='applications' then record_id=payload->>'application';
 elsif kind='review_lrn' and target_table='applications' then record_id=payload->>'application';
 elsif kind='promote' and target_table='enrollments' then record_id=payload->>'enrollment';
 else raise exception 'Unsupported operation'; end if;
 if record_id is null then raise exception 'Record ID required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(target_table||record_id,0));
 execute format('select to_jsonb(r) from public.%I r where id::text=$1 for update',target_table) into current_row using record_id;
 if (expected_version is null and current_row is not null) or (expected_version is not null and (current_row is null or (current_row->>'sync_version')::bigint<>expected_version)) then return jsonb_build_object('status','conflict','record',current_row);end if;
 if kind='approve' then perform public.approve_application((payload->>'application')::uuid,(payload->>'section')::uuid);
 elsif kind='review_lrn' then perform public.resolve_lrn_review((payload->>'application')::uuid,nullif(payload->>'existing_student','')::uuid,payload->>'official_lrn',payload->>'resolution_note');
 elsif kind='promote' then perform public.promote_student((payload->>'enrollment')::uuid,(payload->>'target_year')::uuid,(payload->>'target_section')::uuid);
 else
  if expected_version is null then
   if target_table in ('applications','grades','profiles','school_settings') then raise exception 'This record must already exist';end if;
   select string_agg(format('%I',k),','),string_agg(format('v.%I',k),',') into cols,vals from jsonb_object_keys(payload) k;
   execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I,$1) v returning to_jsonb(%I.*)',target_table,cols,vals,target_table,target_table) into result_row using payload;
  else
   select string_agg(format('%I=v.%I',k,k),',') into sets from jsonb_object_keys(payload) k where k<>'id';
   if sets is null then raise exception 'No fields to update';end if;
   execute format('update public.%I r set %s from jsonb_populate_record(null::public.%I,$1) v where r.id::text=$2 returning to_jsonb(r.*)',target_table,sets,target_table) into result_row using payload,record_id;
   get diagnostics affected=row_count;if affected<>1 then raise exception 'Record missing or permission denied';end if;
  end if;
 end if;
 if kind<>'write' then execute format('select to_jsonb(r) from public.%I r where id::text=$1',target_table) into result_row using record_id;end if;
 result=jsonb_build_object('status','synced','record',result_row);
 insert into public.sync_receipts(actor,operation,request,result) values(actor_id,operation,req,result);
 return result;
end $$;

commit;
