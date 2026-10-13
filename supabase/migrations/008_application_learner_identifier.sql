-- Apply once after 007. Existing records are not backfilled or renumbered.
begin;
alter table public.students add column learner_identifier text unique
 check (learner_identifier is null or learner_identifier ~ '^113682[0-9]{6}$');
comment on column public.students.learner_identifier is 'Application-generated learner identifier. NOT an official DepEd/LIS LRN.';
create table public.learner_identifier_counters(approval_year integer primary key,last_value integer not null check(last_value between 1 and 9999));
create table public.learner_identifier_registry(identifier text primary key,student_id uuid not null unique references public.students(id),approval_year integer not null,issued_at timestamptz not null default now(),issued_by uuid references public.profiles(id));
alter table public.learner_identifier_counters enable row level security;
alter table public.learner_identifier_registry enable row level security;
revoke all on public.learner_identifier_counters,public.learner_identifier_registry from public,anon,authenticated;

create function public.protect_learner_identifier() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if TG_OP='UPDATE' and old.learner_identifier is not null and new.learner_identifier is distinct from old.learner_identifier then raise exception 'Application learner identifiers are permanent';end if;
 if new.learner_identifier is not null and not exists(select 1 from learner_identifier_registry where identifier=new.learner_identifier and student_id=new.id) then raise exception 'Learner identifiers must be assigned by the approval operation';end if;
 return new;
end $$;
create trigger protect_learner_identifier before insert or update on public.students for each row execute function public.protect_learner_identifier();

create function public.assign_application_learner_identifier(learner uuid) returns text
language plpgsql security definer set search_path=public as $$
declare student students;yr integer=extract(year from now() at time zone 'Asia/Manila');seq integer;candidate text;
begin
 if not is_admin() then raise exception 'Administrator access required';end if;
 select * into student from students where id=learner for update;
 if not found then raise exception 'Learner not found';end if;
 if student.learner_identifier is not null then return student.learner_identifier;end if;
 if student.lrn is not null then return null;end if;
 if not exists(select 1 from applications where student_id=learner and status='Enrolled' and enrollment_type='New' and lrn is null and not lrn_review_required and not suspected_duplicate) then raise exception 'An approved eligible new learner is required';end if;
 loop
  insert into learner_identifier_counters(approval_year,last_value) values(yr,1)
  on conflict(approval_year) do update set last_value=learner_identifier_counters.last_value+1
   where learner_identifier_counters.last_value<9999 returning last_value into seq;
  if seq is null then raise exception 'The 4-digit learner identifier sequence for this year is exhausted. Contact the administrator; no identifier was assigned';end if;
  candidate='113682'||right(yr::text,2)||lpad(seq::text,4,'0');
  exit when not exists(select 1 from learner_identifier_registry where identifier=candidate) and not exists(select 1 from students where lrn=candidate or learner_identifier=candidate);
 end loop;
 insert into learner_identifier_registry(identifier,student_id,approval_year,issued_by) values(candidate,learner,yr,auth.uid());
 update students set learner_identifier=candidate where id=learner;
 insert into audit_logs(actor,action,table_name,record_id,after_data) values(auth.uid(),'ASSIGN_APPLICATION_LEARNER_IDENTIFIER','students',learner::text,jsonb_build_object('learner_identifier',candidate,'official_lrn',false,'approval_year',yr));
 return candidate;
end $$;
revoke all on function public.protect_learner_identifier(),public.assign_application_learner_identifier(uuid) from public,anon,authenticated;
create or replace function public.approve_application(application uuid, section uuid) returns uuid language plpgsql security definer set search_path=public as $$ declare a applications; s uuid; y uuid; created_new boolean=false;begin
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
 if s is null then created_new=true;insert into students(lrn,first_name,last_name,birth_date,sex,address,contact,guardian_name,guardian_contact,temporary_reference,student_email,mother_available,mother_name,mother_contact,mother_address,father_available,father_name,father_contact,father_address,guardian_available,guardian_address,previously_attended,previous_school_address,last_grade_level_id,previous_school) values(a.lrn,a.first_name,a.last_name,a.birth_date,a.sex,a.address,a.contact,a.guardian_name,a.guardian_contact,case when a.lrn is null then a.reference else null end,a.student_email,a.mother_available,a.mother_name,a.mother_contact,a.mother_address,a.father_available,a.father_name,a.father_contact,a.father_address,a.guardian_available,a.guardian_address,a.previously_attended,a.previous_school_address,a.last_grade_level_id,a.previous_school) returning id into s;
 else if not exists(select 1 from students where id=s and (lrn is not distinct from a.lrn)) then raise exception 'Verify the selected learner LRN again';end if;update students set first_name=a.first_name,last_name=a.last_name,birth_date=a.birth_date,sex=a.sex,address=a.address,contact=a.contact,guardian_name=a.guardian_name,guardian_contact=a.guardian_contact,student_email=a.student_email,mother_available=a.mother_available,mother_name=a.mother_name,mother_contact=a.mother_contact,mother_address=a.mother_address,father_available=a.father_available,father_name=a.father_name,father_contact=a.father_contact,father_address=a.father_address,guardian_available=a.guardian_available,guardian_address=a.guardian_address,previously_attended=a.previously_attended,previous_school_address=a.previous_school_address,last_grade_level_id=a.last_grade_level_id,previous_school=a.previous_school where id=s;end if;
 insert into enrollments(student_id,school_year_id,grade_level_id,section_id) values(s,y,a.grade_level_id,section);
 update applications set status='Enrolled',student_id=s,lrn_status=case when a.lrn is null then 'Pending Assignment' else 'Verified' end where id=a.id;
 if created_new and a.enrollment_type='New' and a.lrn is null then perform assign_application_learner_identifier(s);end if;
 return s;
end $$;


-- Keep the restricted teacher projection; expose only the new identifier in addition.
drop function public.teacher_students();
create function public.teacher_students() returns table(id uuid,lrn text,first_name text,last_name text,guardian_name text,guardian_contact text,sex text,learner_identifier text)
language sql stable security definer set search_path=public as $$
 select s.id,s.lrn,s.first_name,s.last_name,
 case when s.guardian_available then s.guardian_name when s.mother_available then s.mother_name else s.father_name end,
 case when s.guardian_available then s.guardian_contact when s.mother_available then s.mother_contact else s.father_contact end,s.sex,s.learner_identifier
 from students s where is_staff() and exists(select 1 from enrollments e where e.student_id=s.id and can_view_enrollment(e.id)) $$;
revoke all on function public.teacher_students() from public,anon;
grant execute on function public.teacher_students() to authenticated;
commit;
