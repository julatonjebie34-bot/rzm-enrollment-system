-- Apply once, after 005. No records are deleted or reassigned.
begin;
do $$ begin
 if exists(select 1 from enrollments e join sections s on s.id=e.section_id
  where e.grade_level_id<>s.grade_level_id or e.school_year_id<>s.school_year_id or (e.active and not s.active)) then
  raise exception 'Preflight: resolve incompatible enrollments or inactive occupied sections before applying 006';end if;
 if exists(select 1 from sections s where s.capacity is not null and
  (select count(*) from enrollments e where e.section_id=s.id and e.active)>s.capacity) then
  raise exception 'Preflight: resolve sections above capacity before applying 006';end if;
end $$;
-- Every placement/capacity writer takes this lock BEFORE changing rows, including
-- legacy management routes. Volatile RPC queries see committed counts after waiting.
-- Supabase/PostgREST uses READ COMMITTED; reject stale-snapshot isolation explicitly.
create function public.lock_section_placements() returns void
language plpgsql volatile security definer set search_path=public as $$
begin
 if current_setting('transaction_isolation') <> 'read committed' then
  raise exception 'Section placement requires read committed isolation';
 end if;
 perform pg_advisory_xact_lock(628104,6006);
end $$;
create function public.serialize_section_placements() returns trigger
language plpgsql security definer set search_path=public as $$
begin perform lock_section_placements();return null;end $$;
create trigger placement_serialization before insert or update or delete on enrollments
for each statement execute function serialize_section_placements();
create trigger placement_serialization before insert or update or delete on sections
for each statement execute function serialize_section_placements();
create trigger placement_serialization before insert or update or delete on school_years
for each statement execute function serialize_section_placements();
create trigger placement_serialization before insert or update or delete on teacher_class_assignments
for each statement execute function serialize_section_placements();
-- Grade submission roster freezing and transfers share the same transaction lock.
create trigger placement_serialization before insert or update or delete on grade_submissions
for each statement execute function serialize_section_placements();

create function public.protect_section_placement() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if TG_TABLE_NAME='sections' then
  if exists(select 1 from enrollments where section_id=old.id and active) and not new.active then
   raise exception 'Transfer or deactivate active enrollments before deactivating this section';end if;
  if (new.grade_level_id,new.school_year_id) is distinct from (old.grade_level_id,old.school_year_id)
   and exists(select 1 from enrollments where section_id=old.id) then
   raise exception 'A section with enrollment history cannot change grade or school year';end if;
 else
  if (new.student_id,new.grade_level_id,new.school_year_id) is distinct from (old.student_id,old.grade_level_id,old.school_year_id) then
   raise exception 'Preserve enrollment identity, grade and school year; use a new enrollment for another year';end if;
 end if;
 return new;
end $$;
create trigger protect_section_placement before update on sections for each row execute function protect_section_placement();
create trigger protect_section_placement before update on enrollments for each row execute function protect_section_placement();

create function public.section_assignment_options(grade uuid,year uuid) returns jsonb
language plpgsql volatile security definer set search_path=public as $$
declare result jsonb;
begin
 if not is_admin() then raise exception 'Administrator access required';end if;
 select coalesce(jsonb_agg(to_jsonb(r) order by r.enrolled,r.name collate "C",r.id),'[]') into result from (
  select s.id,s.name,s.active,s.capacity,count(e.id)::integer enrolled,
   case when s.capacity is null then null else greatest(0,s.capacity-count(e.id)) end slots,
   coalesce((select p.full_name from teacher_class_assignments a join profiles p on p.id=a.teacher_id
    where a.section_id=s.id and a.active and p.active),'No adviser assigned') adviser,
   s.active and (s.capacity is null or count(e.id)<s.capacity) eligible
  from sections s left join enrollments e on e.section_id=s.id and e.active
  where s.grade_level_id=grade and s.school_year_id=year
  group by s.id
 ) r;
 return result;
end $$;

create function public.placement_preview(application uuid default null,enrollment uuid default null) returns jsonb
language plpgsql volatile security definer set search_path=public as $$
declare a applications; e enrollments; y uuid; g uuid; options jsonb; version bigint;
begin
 if not is_admin() then raise exception 'Administrator access required';end if;
 if (application is null)=(enrollment is null) then raise exception 'Choose one application or enrollment';end if;
 if application is not null then
  select * into a from applications where id=application;
  if not found or a.status in ('Approved','Enrolled','Rejected') then raise exception 'Application cannot be approved';end if;
  select school_year_id into y from enrollment_links where id=a.link_id;g=a.grade_level_id;version=a.sync_version;
  if not exists(select 1 from school_years where id=y and active and not archived) then raise exception 'Enrollment requires the active school year';end if;
 else
  select * into e from enrollments where id=enrollment;
  if not found or not e.active then raise exception 'Choose an active enrollment';end if;
  y=e.school_year_id;g=e.grade_level_id;version=e.sync_version;
  if exists(select 1 from school_years where id=y and archived) then raise exception 'Archived school year is read only';end if;
 end if;
 options=section_assignment_options(g,y);
 return jsonb_build_object('options',options,'expected_version',version,'current_section',e.section_id,
  'school_year_id',y,'grade_level_id',g,'application',case when application is not null then to_jsonb(a) else null end,
  'recommended',(select v->>'id' from jsonb_array_elements(options) v where (v->>'eligible')::boolean and (e.id is null or v->>'id'<>e.section_id::text) limit 1));
end $$;
create or replace function public.approve_application(application uuid, section uuid) returns uuid language plpgsql security definer set search_path=public as $$ declare a applications; s uuid; y uuid;begin
 if not is_admin() then raise exception 'Admin access required';end if;
 perform public.lock_section_placements();
 select * into a from applications where id=application for update;if a.id is null or a.status in ('Approved','Enrolled','Rejected') then raise exception 'Application cannot be approved';end if;
 if a.lrn_review_required or a.suspected_duplicate then raise exception 'Resolve LRN/duplicate review before approval';end if;
 select school_year_id into y from enrollment_links where id=a.link_id;
 if not exists(select 1 from school_years where id=y and active and not archived) then raise exception 'Enrollment requires the active school year';end if;
 if not exists(select 1 from sections where id=section and grade_level_id=a.grade_level_id and school_year_id=y) then raise exception 'Choose a section for this grade and year';end if;
 perform pg_advisory_xact_lock(hashtextextended(lower(trim(a.first_name))||'|'||lower(trim(a.last_name))||'|'||a.birth_date::text,0));
 if a.lrn is null and a.student_id is null and not a.identity_reviewed and exists(select 1 from students where lower(trim(first_name))=lower(trim(a.first_name)) and lower(trim(last_name))=lower(trim(a.last_name)) and birth_date=a.birth_date) then raise exception 'Resolve matching learner review before approval';end if;
 s=a.student_id;if s is null and a.lrn is not null then select id into s from students where lrn=a.lrn;end if;
 if s is null then insert into students(lrn,first_name,last_name,birth_date,sex,address,contact,guardian_name,guardian_contact,temporary_reference,student_email,mother_available,mother_name,mother_contact,mother_address,father_available,father_name,father_contact,father_address,guardian_available,guardian_address,previously_attended,previous_school_address,last_grade_level_id,previous_school) values(a.lrn,a.first_name,a.last_name,a.birth_date,a.sex,a.address,a.contact,a.guardian_name,a.guardian_contact,case when a.lrn is null then a.reference else null end,a.student_email,a.mother_available,a.mother_name,a.mother_contact,a.mother_address,a.father_available,a.father_name,a.father_contact,a.father_address,a.guardian_available,a.guardian_address,a.previously_attended,a.previous_school_address,a.last_grade_level_id,a.previous_school) returning id into s;
 else if not exists(select 1 from students where id=s and (lrn is not distinct from a.lrn)) then raise exception 'Verify the selected learner LRN again';end if;update students set first_name=a.first_name,last_name=a.last_name,birth_date=a.birth_date,sex=a.sex,address=a.address,contact=a.contact,guardian_name=a.guardian_name,guardian_contact=a.guardian_contact,student_email=a.student_email,mother_available=a.mother_available,mother_name=a.mother_name,mother_contact=a.mother_contact,mother_address=a.mother_address,father_available=a.father_available,father_name=a.father_name,father_contact=a.father_contact,father_address=a.father_address,guardian_available=a.guardian_available,guardian_address=a.guardian_address,previously_attended=a.previously_attended,previous_school_address=a.previous_school_address,last_grade_level_id=a.last_grade_level_id,previous_school=a.previous_school where id=s;end if;
 insert into enrollments(student_id,school_year_id,grade_level_id,section_id) values(s,y,a.grade_level_id,section);
 update applications set status='Enrolled',student_id=s,lrn_status=case when a.lrn is null then 'Pending Assignment' else 'Verified' end where id=a.id;return s;
end $$;

-- Idempotency receipts reuse the protected academic_operations table from 005.
create function public.confirm_section_placement(operation uuid,application uuid,enrollment uuid,
 selected_section uuid,method text,expected_version bigint,reason text default '') returns jsonb
language plpgsql volatile security definer set search_path=public as $$
declare req jsonb; prior academic_operations; preview jsonb; student uuid; e enrollments; result jsonb;
begin
 if not is_admin() then raise exception 'Administrator access required';end if;
 if operation is null or selected_section is null or method not in ('Automatic','Manual') or method is null then raise exception 'Valid operation, method and section required';end if;
 if length(coalesce(reason,''))>2000 then raise exception 'Transfer reason is too long';end if;
 perform lock_section_placements();
 req=jsonb_build_object('kind','section_placement','application',application,'enrollment',enrollment,'section',selected_section,'method',method,'version',expected_version,'reason',reason);
 select * into prior from academic_operations where id=operation;
 if found then
  if prior.actor<>auth.uid() or prior.request<>req then raise exception 'Operation UUID reused';end if;
  return prior.result;
 end if;
 -- Lock the reviewed record before comparing its version.
 if application is not null then perform 1 from applications where id=application for update;
 else perform 1 from enrollments where id=enrollment for update;end if;
 preview=placement_preview(application,enrollment);
 if expected_version is null or (preview->>'expected_version')::bigint<>expected_version then raise exception 'Record changed. Refresh and review before confirming';end if;
 if method='Automatic' and (preview->>'recommended') is distinct from selected_section::text then
  raise exception 'Availability changed. Review the new recommended section and confirm again';end if;
 if not exists(select 1 from jsonb_array_elements(preview->'options') v where v->>'id'=selected_section::text and (v->>'eligible')::boolean) then
  raise exception 'Section is full, inactive or incompatible. Refresh and choose an available section';end if;
 if application is not null then
  student=approve_application(application,selected_section);
  select * into e from enrollments where student_id=student and school_year_id=(preview->>'school_year_id')::uuid;
 else
  if method<>'Manual' then raise exception 'Choose a destination explicitly for transfers';end if;
  select * into e from enrollments where id=enrollment;
  if e.section_id=selected_section then raise exception 'Choose a different destination section';end if;
  perform set_config('rzm.transfer_reason',coalesce(nullif(trim(reason),''),'Section transfer'),true);
  update enrollments set section_id=selected_section where id=enrollment returning * into e;
  student=e.student_id;
 end if;
 result=jsonb_build_object('student_id',student,'enrollment_id',e.id,'section_id',selected_section);
 insert into audit_logs(actor,action,table_name,record_id,after_data)
 values(auth.uid(),case when application is null then 'SECTION_TRANSFER' else 'APPROVE_AND_ASSIGN' end,'enrollments',e.id::text,req||result);
 insert into academic_operations(id,actor,request,result) values(operation,auth.uid(),req,result);
 return result;
end $$;
-- Extend only the existing restricted teacher projection with sex for roster totals.
drop function public.teacher_students();
create function public.teacher_students() returns table(id uuid,lrn text,first_name text,last_name text,guardian_name text,guardian_contact text,sex text)
language sql stable security definer set search_path=public as $$
 select s.id,s.lrn,s.first_name,s.last_name,
 case when s.guardian_available then s.guardian_name when s.mother_available then s.mother_name else s.father_name end,
 case when s.guardian_available then s.guardian_contact when s.mother_available then s.mother_contact else s.father_contact end,s.sex
 from students s where is_staff() and exists(select 1 from enrollments e where e.student_id=s.id and can_view_enrollment(e.id)) $$;
revoke all on function lock_section_placements(),serialize_section_placements(),protect_section_placement(),section_assignment_options(uuid,uuid),placement_preview(uuid,uuid),confirm_section_placement(uuid,uuid,uuid,uuid,text,bigint,text),teacher_students() from public,anon;
grant execute on function placement_preview(uuid,uuid),confirm_section_placement(uuid,uuid,uuid,uuid,text,bigint,text),teacher_students() to authenticated;
create or replace function public.grade_workflow(operation uuid,action text,assignment uuid,period uuid,expected_version bigint default null,entries jsonb default '{}',remarks text default '') returns jsonb
language plpgsql security definer set search_path=public as $$
declare a assignments; p grading_periods; y school_years; s grade_submissions; before_row jsonb; req jsonb; receipt academic_operations;
 roster_now jsonb; item record; val numeric; result jsonb; n integer; invalid integer; target text; complete boolean; is_new boolean:=false; policy_now jsonb;
begin
 perform lock_section_placements();
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

-- Adviser changes are atomic; former assignments remain queryable in history.
create function public.change_section_adviser(section uuid,teacher uuid,expected_assignment uuid) returns void
language plpgsql security definer set search_path=public as $$
declare current_id uuid; current_teacher uuid;
begin
 if not is_admin() then raise exception 'Administrator access required';end if;
 perform lock_section_placements();
 perform 1 from sections s join school_years y on y.id=s.school_year_id where s.id=section and s.active and not y.archived for update of s;
 if not found then raise exception 'Choose an active section in a non-archived year';end if;
 select id,teacher_id into current_id,current_teacher from teacher_class_assignments where section_id=section and active for update;
 if current_id is distinct from expected_assignment then raise exception 'Adviser changed. Refresh before saving';end if;
 if teacher is not null and not exists(select 1 from profiles where id=teacher and role='teacher' and active) then raise exception 'Choose an active teacher';end if;
 if current_teacher is not distinct from teacher then return;end if;
 update teacher_class_assignments set active=false,ended_at=now() where id=current_id;
 if teacher is not null then insert into teacher_class_assignments(teacher_id,section_id) values(teacher,section);end if;
end $$;
revoke all on function change_section_adviser(uuid,uuid,uuid) from public,anon;
grant execute on function change_section_adviser(uuid,uuid,uuid) to authenticated;

commit;
