-- Apply once AFTER 001_school.sql. No service-role key is used by the browser.
begin;
create function public.stamp_sync_version() returns trigger language plpgsql set search_path=public as $$
begin new.updated_at=clock_timestamp(); if TG_OP='UPDATE' then new.sync_version=old.sync_version+1; else new.sync_version=1; end if; return new; end $$;
do $$ declare t text; begin foreach t in array array['profiles','school_settings','school_years','grade_levels','sections','subjects','assignments','students','enrollment_links','applications','documents','enrollments','grades'] loop
 execute format('alter table public.%I add column sync_version bigint not null default 1, add column updated_at timestamptz not null default now()',t);
 execute format('create trigger sync_version_stamp before insert or update on public.%I for each row execute function public.stamp_sync_version()',t);
 end loop; end $$;
create table public.sync_receipts(actor uuid not null references auth.users, operation uuid not null, request jsonb not null, result jsonb not null, created_at timestamptz not null default now(),primary key(actor,operation));
alter table public.sync_receipts enable row level security;
create policy own_receipts_read on public.sync_receipts for select to authenticated using(actor=auth.uid());
create policy own_receipts_insert on public.sync_receipts for insert to authenticated with check(actor=auth.uid());
grant select,insert on public.sync_receipts to authenticated;
revoke update,delete on public.sync_receipts from authenticated,anon;
create function public.sync_management_change(operation uuid,target_table text,kind text,payload jsonb,expected_version bigint default null) returns jsonb
language plpgsql security invoker set search_path=public as $$
declare actor_id uuid:=auth.uid(); req jsonb; prior public.sync_receipts; current_row jsonb; result_row jsonb; result jsonb; cols text; vals text; sets text; allowed text[]; field text; record_id text; affected bigint;
begin
 if actor_id is null then raise exception 'Authentication required'; end if;
 if kind in ('approve','promote') and not public.is_admin() then raise exception 'Admin access required';end if;
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
 elsif kind='promote' and target_table='enrollments' then record_id=payload->>'enrollment';
 else raise exception 'Unsupported operation'; end if;
 if record_id is null then raise exception 'Record ID required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(target_table||record_id,0));
 execute format('select to_jsonb(r) from public.%I r where id::text=$1 for update',target_table) into current_row using record_id;
 if (expected_version is null and current_row is not null) or (expected_version is not null and (current_row is null or (current_row->>'sync_version')::bigint<>expected_version)) then return jsonb_build_object('status','conflict','record',current_row);end if;
 if kind='approve' then perform public.approve_application((payload->>'application')::uuid,(payload->>'section')::uuid);
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
revoke all on function public.sync_management_change(uuid,text,text,jsonb,bigint) from public,anon;
grant execute on function public.sync_management_change(uuid,text,text,jsonb,bigint) to authenticated;
commit;
