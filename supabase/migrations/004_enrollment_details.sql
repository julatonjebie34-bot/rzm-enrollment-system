-- Apply after 001, 002, and 003. Preserve existing students, applications, and access policies.
begin;
alter table public.applications
 add column student_email text,
 add column mother_available boolean not null default false,
 add column mother_name text not null default '',
 add column mother_contact text not null default '',
 add column mother_address text not null default '',
 add column father_available boolean not null default false,
 add column father_name text not null default '',
 add column father_contact text not null default '',
 add column father_address text not null default '',
 add column guardian_available boolean not null default true,
 add column guardian_address text not null default '',
 add column previously_attended boolean,
 add column previous_school_address text not null default '',
 add column last_grade_level_id uuid references public.grade_levels(id);
alter table public.students
 add column student_email text,
 add column mother_available boolean not null default false,
 add column mother_name text not null default '',
 add column mother_contact text not null default '',
 add column mother_address text not null default '',
 add column father_available boolean not null default false,
 add column father_name text not null default '',
 add column father_contact text not null default '',
 add column father_address text not null default '',
 add column guardian_available boolean not null default true,
 add column guardian_address text not null default '',
 add column previously_attended boolean,
 add column previous_school_address text not null default '',
 add column last_grade_level_id uuid references public.grade_levels(id),
 add column previous_school text not null default '';
update public.applications set previously_attended=nullif(trim(previous_school),'') is not null;
-- Only the enrollment link requested for this update is expanded; other link policies remain intact.
update public.enrollment_links set allowed_grade_ids=(select array_agg(id order by rank) from public.grade_levels where rank between 0 and 6)
 where token='7f4cbb6e-d080-4500-af2b-1891bd082799';

create function public.validate_extended_enrollment(d jsonb) returns void language plpgsql set search_path=public as $$
declare person text; field text; reachable boolean:=false;
begin
 if coalesce(d->>'contact','') !~ '^\+63(9[0-9]{9}|2[0-9]{8}|[3-8][0-9]{8})$' then raise exception 'invalidPhone';end if;
 if nullif(trim(d->>'student_email'),'') is not null and (jsonb_typeof(d->'student_email')<>'string' or length(d->>'student_email')>254 or d->>'student_email' !~ '^[^[:space:]@]+@[^[:space:]@.]+(\.[^[:space:]@.]+)+$') then raise exception 'invalidEmail';end if;
 foreach person in array array['mother','father','guardian'] loop
  if coalesce(jsonb_typeof(d->(person||'_available')),'')<>'boolean' then raise exception 'adultRequired';end if;
  if (d->>(person||'_available'))::boolean then
   reachable=true;
   if coalesce(jsonb_typeof(d->(person||'_name')),'')<>'string' or nullif(trim(d->>(person||'_name')),'') is null or length(d->>(person||'_name'))>1000 then raise exception 'INVALID_DETAILS';end if;
   if coalesce(d->>(person||'_contact'),'') !~ '^\+63(9[0-9]{9}|2[0-9]{8}|[3-8][0-9]{8})$' then raise exception 'invalidPhone';end if;
   if coalesce(jsonb_typeof(d->(person||'_address')),'')<>'string' or length(d->>(person||'_address'))>1000 then raise exception 'INVALID_DETAILS';end if;
  elsif coalesce(d->>(person||'_name'),'')<>'' or coalesce(d->>(person||'_contact'),'')<>'' or coalesce(d->>(person||'_address'),'')<>'' then raise exception 'INVALID_DETAILS';end if;
 end loop;
 if not reachable then raise exception 'adultRequired';end if;
 if coalesce(jsonb_typeof(d->'previously_attended'),'')<>'boolean' then raise exception 'previousAnswerRequired';end if;
 if (d->>'previously_attended')::boolean then
  foreach field in array array['previous_school','previous_school_address'] loop
   if coalesce(jsonb_typeof(d->field),'')<>'string' or nullif(trim(d->>field),'') is null or length(d->>field)>1000 then raise exception 'INVALID_DETAILS';end if;
  end loop;
  if nullif(d->>'last_grade_level_id','') is not null and not exists(select 1 from grade_levels where id=(d->>'last_grade_level_id')::uuid) then raise exception 'invalidGrade';end if;
 elsif coalesce(d->>'previous_school','')<>'' or coalesce(d->>'previous_school_address','')<>'' or nullif(d->>'last_grade_level_id','') is not null then raise exception 'INVALID_DETAILS';end if;
end $$;
revoke all on function public.validate_extended_enrollment(jsonb) from public,anon,authenticated;
grant execute on function public.validate_extended_enrollment(jsonb) to service_role;
create or replace function public.submit_public_application(link_token uuid,submission uuid,details jsonb,uploaded_documents jsonb) returns jsonb language plpgsql security definer set search_path=public as $$
declare l enrollment_links; prior applications; a applications; clean jsonb; official text; ref text; possible boolean; known boolean; needs_review boolean; field text; doc jsonb; fingerprint text; counter bigint;
begin
 if submission is null then raise exception 'INVALID_SUBMISSION';end if;
 select * into l from enrollment_links where token=link_token and published and not archived and now() between opens_at and closes_at for share;
 if l.id is null then raise exception 'LINK_UNAVAILABLE';end if;
 for field in select unnest(array['first_name','last_name','birth_date','sex','address','contact','grade_level_id','enrollment_type']) loop
 if jsonb_typeof(details->field)<>'string' or nullif(trim(details->>field),'') is null or length(details->>field)>1000 then raise exception 'INVALID_DETAILS';end if;end loop;
 if coalesce(jsonb_typeof(details->'lrn'),'null') not in ('string','null') or coalesce(jsonb_typeof(details->'has_lrn'),'')<>'boolean' then raise exception 'INVALID_LRN';end if;
 official=nullif(details->>'lrn','');
 if (details->>'has_lrn'='true' and official is null) or (details->>'has_lrn'='false' and official is not null) then raise exception 'INVALID_LRN';end if;
 if official is not null and official!~'^[0-9]{12}$' then raise exception 'INVALID_LRN';end if;
 if details->>'enrollment_type' not in ('New','Returning','Transferee') or details->>'sex' not in ('Male','Female') or not (details->>'grade_level_id')::uuid=any(l.allowed_grade_ids) then raise exception 'INVALID_DETAILS';end if;
 if details->>'birth_date'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or (details->>'birth_date')::date>current_date then raise exception 'INVALID_DETAILS';end if;
 perform validate_extended_enrollment(details);
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
 insert into applications(submission_id,submission_fingerprint,reference,link_id,grade_level_id,lrn,first_name,last_name,birth_date,sex,address,contact,guardian_name,guardian_contact,previous_school,enrollment_type,extra_answers,lrn_status,lrn_review_required,suspected_duplicate,verification_reason,student_email,mother_available,mother_name,mother_contact,mother_address,father_available,father_name,father_contact,father_address,guardian_available,guardian_address,previously_attended,previous_school_address,last_grade_level_id)
 values(submission,fingerprint,ref,l.id,(details->>'grade_level_id')::uuid,official,trim(details->>'first_name'),trim(details->>'last_name'),(details->>'birth_date')::date,details->>'sex',trim(details->>'address'),trim(details->>'contact'),trim(details->>'guardian_name'),trim(details->>'guardian_contact'),coalesce(details->>'previous_school',''),details->>'enrollment_type',coalesce(details->'extra_answers','{}'::jsonb),case when official is null and details->>'enrollment_type'='New' then 'Pending Assignment' else 'Needs Verification' end,needs_review,possible,case when known then 'Existing official LRN: confirm the learner record' when possible then 'Possible matching learner details: review before creating a student' when needs_review then 'Returning/transferring learner without a known LRN' else '' end,nullif(details->>'student_email',''),(details->>'mother_available')::boolean,coalesce(details->>'mother_name',''),coalesce(details->>'mother_contact',''),coalesce(details->>'mother_address',''),(details->>'father_available')::boolean,coalesce(details->>'father_name',''),coalesce(details->>'father_contact',''),coalesce(details->>'father_address',''),(details->>'guardian_available')::boolean,coalesce(details->>'guardian_address',''),(details->>'previously_attended')::boolean,coalesce(details->>'previous_school_address',''),nullif(details->>'last_grade_level_id','')::uuid) returning * into a;
 for doc in select * from jsonb_array_elements(uploaded_documents) loop
 if nullif(doc->>'path','') is null then raise exception 'MISSING_DOCUMENTS';end if;
 insert into documents(application_id,kind,path) values(a.id,doc->>'kind',doc->>'path');end loop;
 return jsonb_build_object('reference',a.reference,'lrn_status',a.lrn_status,'replayed',false);
end $$;

create or replace function public.approve_application(application uuid, section uuid) returns uuid language plpgsql security definer set search_path=public as $$ declare a applications; s uuid; y uuid;begin
 if not is_admin() then raise exception 'Admin access required';end if;
 select * into a from applications where id=application for update;if a.id is null or a.status in ('Approved','Enrolled','Rejected') then raise exception 'Application cannot be approved';end if;
 if a.lrn_review_required or a.suspected_duplicate then raise exception 'Resolve LRN/duplicate review before approval';end if;
 select school_year_id into y from enrollment_links where id=a.link_id;
 if not exists(select 1 from sections where id=section and grade_level_id=a.grade_level_id and school_year_id=y) then raise exception 'Choose a section for this grade and year';end if;
 perform pg_advisory_xact_lock(hashtextextended(lower(trim(a.first_name))||'|'||lower(trim(a.last_name))||'|'||a.birth_date::text,0));
 if a.lrn is null and a.student_id is null and not a.identity_reviewed and exists(select 1 from students where lower(trim(first_name))=lower(trim(a.first_name)) and lower(trim(last_name))=lower(trim(a.last_name)) and birth_date=a.birth_date) then raise exception 'Resolve matching learner review before approval';end if;
 s=a.student_id;if s is null and a.lrn is not null then select id into s from students where lrn=a.lrn;end if;
 if s is null then insert into students(lrn,first_name,last_name,birth_date,sex,address,contact,guardian_name,guardian_contact,temporary_reference,student_email,mother_available,mother_name,mother_contact,mother_address,father_available,father_name,father_contact,father_address,guardian_available,guardian_address,previously_attended,previous_school_address,last_grade_level_id,previous_school) values(a.lrn,a.first_name,a.last_name,a.birth_date,a.sex,a.address,a.contact,a.guardian_name,a.guardian_contact,case when a.lrn is null then a.reference else null end,a.student_email,a.mother_available,a.mother_name,a.mother_contact,a.mother_address,a.father_available,a.father_name,a.father_contact,a.father_address,a.guardian_available,a.guardian_address,a.previously_attended,a.previous_school_address,a.last_grade_level_id,a.previous_school) returning id into s;
 else if not exists(select 1 from students where id=s and (lrn is not distinct from a.lrn)) then raise exception 'Verify the selected learner LRN again';end if;update students set first_name=a.first_name,last_name=a.last_name,birth_date=a.birth_date,sex=a.sex,address=a.address,contact=a.contact,guardian_name=a.guardian_name,guardian_contact=a.guardian_contact,student_email=a.student_email,mother_available=a.mother_available,mother_name=a.mother_name,mother_contact=a.mother_contact,mother_address=a.mother_address,father_available=a.father_available,father_name=a.father_name,father_contact=a.father_contact,father_address=a.father_address,guardian_available=a.guardian_available,guardian_address=a.guardian_address,previously_attended=a.previously_attended,previous_school_address=a.previous_school_address,last_grade_level_id=a.last_grade_level_id,previous_school=a.previous_school where id=s;end if;
 insert into enrollments(student_id,school_year_id,grade_level_id,section_id) values(s,y,a.grade_level_id,section);
 update applications set status='Enrolled',student_id=s,lrn_status=case when a.lrn is null then 'Pending Assignment' else 'Verified' end where id=a.id;return s;
end $$;


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
 when 'students' then array['student_email','mother_available','mother_name','mother_contact','mother_address','father_available','father_name','father_contact','father_address','guardian_available','guardian_address','previously_attended','previous_school_address','last_grade_level_id','previous_school','lrn','first_name','last_name','birth_date','sex','address','contact','guardian_name','guardian_contact']
 when 'enrollment_links' then array['token','title','school_year_id','allowed_grade_ids','published','archived','opens_at','closes_at','instructions','extra_questions']
 when 'applications' then array['student_email','mother_available','mother_name','mother_contact','mother_address','father_available','father_name','father_contact','father_address','guardian_available','guardian_address','previously_attended','previous_school_address','last_grade_level_id','lrn','first_name','last_name','birth_date','sex','address','contact','guardian_name','guardian_contact','previous_school','note','status']
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
