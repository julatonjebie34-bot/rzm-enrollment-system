-- Read-only checks before 005_academic_portals.sql. Run in Supabase SQL Editor.
-- The first result should include all columns listed below. No personal student data is selected.
select table_name,column_name from information_schema.columns
where table_schema='public' and (table_name,column_name) in
 (('profiles','sync_version'),('applications','identity_reviewed'),('applications','mother_name'),('students','mother_name'),('grades','final_grade'))
order by table_name,column_name;

-- Must return ZERO rows: choose the correct teacher for each conflicting assignment
-- using current school records before migrating. Migration 005 will abort without changing data if conflicts remain.
select section_id,subject_id,count(*) as assignment_count,array_agg(id) as assignment_ids,array_agg(teacher_id) as teacher_ids
from public.assignments group by section_id,subject_id having count(*)>1;

-- Preserve this passing mark. The migration copies it into existing school-year policies.
select school_name,pass_mark from public.school_settings where id=1;

-- Record these counts to compare after migration. None should decrease.
select 'students' as entity,count(*) from public.students union all
select 'applications',count(*) from public.applications union all
select 'enrollments',count(*) from public.enrollments union all
select 'grades',count(*) from public.grades union all
select 'documents',count(*) from public.documents union all
select 'enrollment_links',count(*) from public.enrollment_links;
