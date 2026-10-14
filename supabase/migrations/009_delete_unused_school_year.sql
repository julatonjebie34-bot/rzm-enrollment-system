-- Apply once after 008. Adds an admin-only operation; does not delete any year.
BEGIN;

CREATE FUNCTION public.guard_school_year_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE year_id uuid; y school_years;
BEGIN
 IF TG_TABLE_NAME='school_years' THEN year_id=old.id; ELSE year_id=old.school_year_id; END IF;
 IF NOT is_admin() OR current_setting('rzm.delete_school_year',true) IS DISTINCT FROM year_id::text THEN
  RAISE EXCEPTION 'Use the administrator school year deletion action';
 END IF;
 SELECT * INTO y FROM school_years WHERE id=year_id FOR UPDATE;
 IF NOT FOUND OR y.active OR y.archived THEN
  RAISE EXCEPTION 'Only an inactive, unarchived school year can be deleted';
 END IF;
 IF EXISTS(SELECT 1 FROM sections WHERE school_year_id=year_id)
 OR EXISTS(SELECT 1 FROM enrollment_links WHERE school_year_id=year_id)
 OR EXISTS(SELECT 1 FROM enrollments WHERE school_year_id=year_id)
 OR EXISTS(SELECT 1 FROM grade_submissions s JOIN grading_periods p ON p.id=s.period_id WHERE p.school_year_id=year_id) THEN
  RAISE EXCEPTION 'This school year has sections, enrollment links, student enrollments or grade history. Keep or archive it instead';
 END IF;
 RETURN old;
END $$;
REVOKE ALL ON FUNCTION public.guard_school_year_delete() FROM public,anon,authenticated;

-- Preserve INSERT/UPDATE validation; only DELETE gets a narrower guard.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['school_years','grading_periods','subject_offerings'] LOOP
  EXECUTE format('DROP TRIGGER academic_guard ON public.%I',t);
  EXECUTE format('CREATE TRIGGER academic_guard AFTER INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.guard_academic_record()',t);
  EXECUTE format('CREATE TRIGGER school_year_delete_guard BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.guard_school_year_delete()',t);
 END LOOP;
END $$;
REVOKE DELETE ON public.school_years,public.grading_periods,public.subject_offerings FROM anon,authenticated;

CREATE FUNCTION public.delete_unused_school_year(target_year uuid,expected_version bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE y school_years; prior_context text; quarters_removed integer; offerings_removed integer;
BEGIN
 IF NOT is_admin() THEN RAISE EXCEPTION 'Administrator access required'; END IF;
 PERFORM lock_section_placements();
 SELECT * INTO y FROM school_years WHERE id=target_year FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'School year no longer exists. Refresh the page'; END IF;
 IF expected_version IS NULL OR expected_version<>y.sync_version THEN
  RAISE EXCEPTION 'This school year changed. Refresh and review it before deleting';
 END IF;
 IF y.active THEN RAISE EXCEPTION 'Deactivate this school year before deleting it'; END IF;
 IF y.archived THEN RAISE EXCEPTION 'Archived school years are preserved and cannot be deleted'; END IF;
 IF EXISTS(SELECT 1 FROM sections WHERE school_year_id=y.id)
 OR EXISTS(SELECT 1 FROM enrollment_links WHERE school_year_id=y.id)
 OR EXISTS(SELECT 1 FROM enrollments WHERE school_year_id=y.id)
 OR EXISTS(SELECT 1 FROM grade_submissions s JOIN grading_periods p ON p.id=s.period_id WHERE p.school_year_id=y.id) THEN
  RAISE EXCEPTION 'This school year has sections, enrollment links, student enrollments or grade history. Keep or archive it instead';
 END IF;
 -- The locked parent row and foreign keys protect against concurrent inserts.
 prior_context=current_setting('rzm.delete_school_year',true);
 PERFORM set_config('rzm.delete_school_year',target_year::text,true);
 DELETE FROM subject_offerings WHERE school_year_id=target_year;
 GET DIAGNOSTICS offerings_removed=ROW_COUNT;
 DELETE FROM grading_periods WHERE school_year_id=target_year;
 GET DIAGNOSTICS quarters_removed=ROW_COUNT;
 DELETE FROM school_years WHERE id=target_year;
 PERFORM set_config('rzm.delete_school_year',coalesce(prior_context,''),true);
 INSERT INTO audit_logs(actor,action,table_name,record_id,before_data,after_data)
 VALUES(auth.uid(),'DELETE_UNUSED_SCHOOL_YEAR','school_years',y.id::text,to_jsonb(y),
   jsonb_build_object('quarters_removed',quarters_removed,'subject_offerings_removed',offerings_removed));
 RETURN jsonb_build_object('id',y.id,'name',y.name);
END $$;
REVOKE ALL ON FUNCTION public.delete_unused_school_year(uuid,bigint) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.delete_unused_school_year(uuid,bigint) TO authenticated;
COMMIT;
