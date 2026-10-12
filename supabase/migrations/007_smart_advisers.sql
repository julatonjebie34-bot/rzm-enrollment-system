-- Apply once after 006. Existing advisers and placements are preserved.
begin;
-- Candidate eligibility changes participate in the placement transaction lock.
create trigger placement_serialization before insert or update or delete on assignments for each statement execute function serialize_section_placements();
create trigger placement_serialization before insert or update or delete on profiles for each statement execute function serialize_section_placements();
create trigger placement_serialization before insert or update or delete on subjects for each statement execute function serialize_section_placements();
create trigger placement_serialization before insert or update or delete on subject_offerings for each statement execute function serialize_section_placements();

create function public.adviser_recommendation(section uuid,planned jsonb default '{}') returns jsonb
language plpgsql volatile security definer set search_path=public as $$
declare s sections; a teacher_class_assignments; p profiles; n integer; teacher_id uuid;
begin
 if not is_admin() then raise exception 'Administrator access required';end if;
 select * into s from sections where id=section and active;
 if not found then raise exception 'Choose an active section';end if;
 select * into a from teacher_class_assignments where section_id=section and active;
 if found then
  select * into p from profiles where id=a.teacher_id;
  return jsonb_build_object('teacher_id',p.id,'name',p.full_name,'assignment_id',a.id,'needs_assignment',false,'eligible',p.active and p.role='teacher','reason',case when p.active then 'Existing adviser retained' else 'Existing adviser is inactive. Change the adviser before automatic placement.' end);
 end if;
 if planned ? section::text then
  select * into p from profiles where id=(planned->>section::text)::uuid;
  return jsonb_build_object('teacher_id',p.id,'name',p.full_name,'assignment_id',null,'needs_assignment',true,'eligible',true,'reason','Adviser already proposed for this section in this batch');
 end if;
 select pr.id, (select count(*) from teacher_class_assignments ca join sections cs on cs.id=ca.section_id where ca.teacher_id=pr.id and ca.active and cs.active and cs.school_year_id=s.school_year_id)
   +(select count(*) from jsonb_each_text(planned) v where v.value=pr.id::text) as load
 into teacher_id,n
 from profiles pr
 where pr.active and pr.role='teacher' and exists(
  select 1 from assignments ta join sections ts on ts.id=ta.section_id join subjects su on su.id=ta.subject_id
  join subject_offerings so on so.subject_id=ta.subject_id and so.school_year_id=ts.school_year_id
  where ta.teacher_id=pr.id and ta.active and ts.active and su.active and so.active and ts.grade_level_id=s.grade_level_id and ts.school_year_id=s.school_year_id)
 order by load,pr.full_name collate "C",pr.id limit 1;
 select * into p from profiles where id=teacher_id;
 if p.id is null then return jsonb_build_object('teacher_id',null,'name','No eligible teacher','assignment_id',null,'needs_assignment',true,'eligible',false,'reason','Assign an active teacher to a subject for this grade and school year first.');end if;
 return jsonb_build_object('teacher_id',p.id,'name',p.full_name,'assignment_id',null,'needs_assignment',true,'eligible',true,'load',n,'reason','Already teaches this grade and school year; fewest adviser sections. Ties use teacher name, then ID.');
end $$;

create function public.smart_placement_preview(application uuid default null,enrollment uuid default null) returns jsonb
language plpgsql volatile security definer set search_path=public as $$
declare result jsonb; options jsonb='[]'; opt jsonb;
begin
 result=placement_preview(application,enrollment);
 for opt in select value from jsonb_array_elements(result->'options') loop
  if (opt->>'active')::boolean then opt=opt||jsonb_build_object('teacher',adviser_recommendation((opt->>'id')::uuid));end if;
  options=options||jsonb_build_array(opt);
 end loop;
 return result||jsonb_build_object('options',options);
end $$;

create function public.smart_confirm_placement(operation uuid,application uuid,enrollment uuid,selected_section uuid,method text,expected_version bigint,reason text,use_auto_teacher boolean,expected_teacher uuid,expected_assignment uuid) returns jsonb
language plpgsql volatile security definer set search_path=public as $$
declare req jsonb; prior academic_operations; choice jsonb; result jsonb;
begin
 if not is_admin() then raise exception 'Administrator access required';end if;
 if operation is null or use_auto_teacher is null then raise exception 'Operation and teacher selection mode required';end if;
 perform lock_section_placements();
 req=jsonb_build_object('kind','smart_placement','application',application,'enrollment',enrollment,'section',selected_section,'method',method,'version',expected_version,'reason',reason,'auto_teacher',use_auto_teacher,'teacher',expected_teacher,'assignment',expected_assignment);
 select * into prior from academic_operations where id=operation;
 if found then if prior.actor<>auth.uid() or prior.request<>req then raise exception 'Operation UUID reused';end if;return prior.result;end if;
 choice=adviser_recommendation(selected_section);
 if use_auto_teacher then
  if not (choice->>'eligible')::boolean then raise exception '%',choice->>'reason';end if;
  if (choice->>'teacher_id')::uuid is distinct from expected_teacher or (choice->>'assignment_id')::uuid is distinct from expected_assignment then raise exception 'Teacher recommendation changed. Refresh and confirm the new placement';end if;
  if (choice->>'needs_assignment')::boolean then perform change_section_adviser(selected_section,expected_teacher,null);end if;
 end if;
 result=confirm_section_placement(gen_random_uuid(),application,enrollment,selected_section,method,expected_version,reason);
 result=result||jsonb_build_object('teacher',case when use_auto_teacher then choice else null end);
 insert into academic_operations(id,actor,request,result) values(operation,auth.uid(),req,result);
 insert into audit_logs(actor,action,table_name,record_id,after_data) values(auth.uid(),'SMART_PLACEMENT','enrollments',result->>'enrollment_id',req||result);
 return result;
end $$;

-- Preview simulates counts and adviser workloads without writing records.
create function public.batch_placement_preview(application_ids uuid[]) returns jsonb
language plpgsql volatile security definer set search_path=public as $$
declare id uuid; p jsonb; opt jsonb; teacher jsonb; result jsonb='[]'; counts jsonb='{}'; planned jsonb='{}';
begin
 if not is_admin() then raise exception 'Administrator access required';end if;
 if coalesce(cardinality(application_ids),0) not between 1 and 50 or exists(select 1 from unnest(application_ids) i group by i having count(*)>1) then raise exception 'Select 1–50 different reviewed applications';end if;
 for id in select unnest(application_ids) order by 1 loop
  p=placement_preview(id,null);
  if (p->'application'->>'lrn_review_required')::boolean or (p->'application'->>'suspected_duplicate')::boolean then raise exception 'Resolve identity review before bulk approval';end if;
  select v || jsonb_build_object('enrolled',(v->>'enrolled')::integer+coalesce((counts->>(v->>'id'))::integer,0)) into opt
  from jsonb_array_elements(p->'options') v
  where (v->>'active')::boolean and ((v->>'capacity') is null or (v->>'enrolled')::integer+coalesce((counts->>(v->>'id'))::integer,0)<(v->>'capacity')::integer)
  order by (v->>'enrolled')::integer+coalesce((counts->>(v->>'id'))::integer,0),(v->>'name') collate "C",v->>'id' limit 1;
  if opt is null then raise exception 'No available section for %. Create a section or adjust capacity.',p->'application'->>'reference';end if;
  teacher=adviser_recommendation((opt->>'id')::uuid,planned);
  if not (teacher->>'eligible')::boolean then raise exception '%: %',opt->>'name',teacher->>'reason';end if;
  result=result||jsonb_build_array(jsonb_build_object('application',id,'reference',p->'application'->>'reference','student',concat_ws(' ',p->'application'->>'first_name',p->'application'->>'last_name'),'grade_level_id',p->>'grade_level_id','school_year_id',p->>'school_year_id','expected_version',p->'expected_version','section_id',opt->>'id','section',opt->>'name','enrolled',opt->'enrolled','capacity',opt->'capacity','teacher',teacher));
  counts=jsonb_set(counts,array[opt->>'id'],to_jsonb(coalesce((counts->>(opt->>'id'))::integer,0)+1));
  if (teacher->>'needs_assignment')::boolean then planned=jsonb_set(planned,array[opt->>'id'],teacher->'teacher_id');end if;
 end loop;
 return result;
end $$;

create function public.confirm_batch_placement(operation uuid,application_ids uuid[],reviewed_plan jsonb) returns jsonb
language plpgsql volatile security definer set search_path=public as $$
declare req jsonb; prior academic_operations; plan jsonb; r jsonb; c jsonb; result jsonb='[]';
begin
 if not is_admin() then raise exception 'Administrator access required';end if;
 if operation is null then raise exception 'Operation required';end if;
 perform lock_section_placements();
 req=jsonb_build_object('kind','batch_placement','ids',application_ids,'plan',reviewed_plan);
 select * into prior from academic_operations where id=operation;
 if found then if prior.actor<>auth.uid() or prior.request<>req then raise exception 'Operation UUID reused';end if;return prior.result;end if;
 perform 1 from applications where id=any(application_ids) order by id for update;
 plan=batch_placement_preview(application_ids);
 if reviewed_plan is null or plan<>reviewed_plan then raise exception 'Batch placement changed. Refresh the preview and confirm again';end if;
 for r in select value from jsonb_array_elements(plan) loop
  c=adviser_recommendation((r->>'section_id')::uuid);
  result=result||jsonb_build_array(smart_confirm_placement(gen_random_uuid(),(r->>'application')::uuid,null,(r->>'section_id')::uuid,'Automatic',(r->>'expected_version')::bigint,'Bulk approval',true,(r->'teacher'->>'teacher_id')::uuid,(c->>'assignment_id')::uuid));
 end loop;
 insert into academic_operations(id,actor,request,result) values(operation,auth.uid(),req,result);
 return result;
end $$;

create table public.teacher_notifications(
 id uuid primary key default gen_random_uuid(),recipient uuid not null references profiles,
 section_id uuid not null references sections,event text not null,message text not null,
 created_at timestamptz not null default now(),read_at timestamptz);
create index teacher_notifications_inbox on teacher_notifications(recipient,created_at desc);
alter table teacher_notifications enable row level security;
revoke all on teacher_notifications from anon,authenticated;
grant select on teacher_notifications to authenticated;
create policy own_notifications on teacher_notifications for select to authenticated using(is_staff() and recipient=auth.uid());
-- Notices deliberately contain no learner names or other private learner fields.
create function public.notify_section_teachers(section uuid,kind text) returns void
language plpgsql security definer set search_path=public as $$
begin
 insert into teacher_notifications(recipient,section_id,event,message)
 select distinct pr.id,s.id,kind,case kind when 'joined' then 'A learner joined ' when 'left' then 'A learner left ' else 'You are now adviser of ' end||s.name||'. Refresh your section roster.'
 from sections s join profiles pr on pr.active and pr.role='teacher'
 where s.id=section and (exists(select 1 from teacher_class_assignments a where a.section_id=s.id and a.teacher_id=pr.id and a.active)
 or (kind<>'adviser' and exists(select 1 from assignments a where a.section_id=s.id and a.teacher_id=pr.id and a.active)));
end $$;
create function public.section_notification_event() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if TG_TABLE_NAME='teacher_class_assignments' then
  if new.active and (TG_OP='INSERT' or not old.active) then perform notify_section_teachers(new.section_id,'adviser');end if;
 else
  if TG_OP='INSERT' then if new.active then perform notify_section_teachers(new.section_id,'joined');end if;
  elsif (new.section_id,new.active) is distinct from (old.section_id,old.active) then
   if old.active then perform notify_section_teachers(old.section_id,'left');end if;
   if new.active then perform notify_section_teachers(new.section_id,'joined');end if;
  end if;
 end if;return new;
end $$;
create trigger section_notifications after insert or update on enrollments for each row execute function section_notification_event();
create trigger adviser_notifications after insert or update on teacher_class_assignments for each row execute function section_notification_event();
create function public.read_teacher_notifications(notification_ids uuid[]) returns void
language plpgsql security definer set search_path=public as $$
begin
 if not is_staff() then raise exception 'Active staff access required';end if;
 update teacher_notifications set read_at=coalesce(read_at,now()) where recipient=auth.uid() and id=any(notification_ids);
end $$;
revoke all on function adviser_recommendation(uuid,jsonb),smart_placement_preview(uuid,uuid),smart_confirm_placement(uuid,uuid,uuid,uuid,text,bigint,text,boolean,uuid,uuid),batch_placement_preview(uuid[]),confirm_batch_placement(uuid,uuid[],jsonb),notify_section_teachers(uuid,text),section_notification_event(),read_teacher_notifications(uuid[]) from public,anon;
grant execute on function adviser_recommendation(uuid,jsonb),smart_placement_preview(uuid,uuid),smart_confirm_placement(uuid,uuid,uuid,uuid,text,bigint,text,boolean,uuid,uuid),batch_placement_preview(uuid[]),confirm_batch_placement(uuid,uuid[],jsonb),read_teacher_notifications(uuid[]) to authenticated;

create function public.confirm_auto_adviser(section uuid,expected_teacher uuid,expected_assignment uuid) returns void
language plpgsql volatile security definer set search_path=public as $$
declare c jsonb;
begin
 if not is_admin() then raise exception 'Administrator access required';end if;
 perform lock_section_placements();
 c=adviser_recommendation(section);
 if not (c->>'eligible')::boolean then raise exception '%',c->>'reason';end if;
 if (c->>'teacher_id')::uuid is distinct from expected_teacher or (c->>'assignment_id')::uuid is distinct from expected_assignment then raise exception 'Teacher recommendation changed. Preview again';end if;
 if (c->>'needs_assignment')::boolean then perform change_section_adviser(section,expected_teacher,null);end if;
end $$;
revoke all on function confirm_auto_adviser(uuid,uuid,uuid) from public,anon;
grant execute on function confirm_auto_adviser(uuid,uuid,uuid) to authenticated;

commit;
