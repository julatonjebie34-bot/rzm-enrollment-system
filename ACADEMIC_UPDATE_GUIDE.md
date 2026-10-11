# RZM enrollment and academic portal update

Prepared 11 October 2026 for the existing project at `C:\Users\kasan\OneDrive\Desktop\RZM_Enrollment_System\enrollment-system`.

## Delivery status

The local source now includes the expanded administrator workspace, separate teacher navigation and workflows, database migration, updated Edge Functions, offline grade drafts, tests, and this guide. The live Supabase database and Vercel deployment have **not** been changed. Do the database and function steps below before publishing the new frontend. Pushing frontend code alone will not install the new database functions.

The existing local schema was inspected through migrations 001–004. The live database was not available for privileged inspection; run the supplied read-only preflight against it before applying migration 005. No production credentials or student data are included in the source archive.

## Preserved features

- Existing public enrollment URL format, welcome page, compact six-step form, student and family details, grade choices, documents, validation, reference number, Turnstile protection and no-account parent workflow.
- Existing enrollment link generator, multiple periods, publication dates, preview, form instructions, removed-link visibility, restoration and submission history.
- Existing students, UUID student identities, separately validated LRNs, applications, school years, grades, private document storage, school branding and responsive light/dark layouts.
- Existing offline management queue, conflict handling, enrollment reports and promotion controls, with online verification now required for approval/promotion.

## How the portals communicate

Parents use the existing `?enroll=<token>` public page. The `public-enrollment` Edge Function verifies the link, school year, fields, documents and Turnstile response, then calls the transactional application function. It creates a pending application in the same database used by staff.

Administrators review documents and learner identity, resolve possible duplicates, and approve the application into a section. Existing student records are reused where identity is confirmed. The resulting `enrollments` row links the stable student ID to its school year, grade and section. Assigned teachers see authorized students after synchronization.

Teachers save grades through IndexedDB and the grade draft queue. Online `grade_workflow` validates assignment, roster, period, permitted grade range, precision and expected version. Submitting freezes the class roster, entries and grading policy. Administrators review, approve and finalize that version; only finalization writes the official quarter columns in the existing `grades` table. Returning or reopening requires remarks and creates an immutable revision.

Database RLS and privileged operations enforce access independently of navigation. Teachers receive a limited student projection rather than raw enrollment personal details. Public applicants cannot query protected staff tables.

## Modules included

| Area | Implementation |
| --- | --- |
| Admin dashboard | Existing enrollment cards/charts plus actual teacher, active section, approval and grade-submission counts, progress and activity |
| Applications and documents | Existing review and approval; identity review, required rejection/correction reasons, verification states/remarks and audit history |
| Students and classes | Central student profiles, current grade/section search, enrollment history, capacities, adviser assignment and section transfers |
| Subjects and school years | Editable subject catalog, year-specific offerings, teacher assignments, four grading periods, encoding dates, year archive protection |
| Grade review | Draft → Submitted → Under Review → Approved or Returned → Finalized; frozen snapshots, exceptions with reasons, controlled reopening, revision history |
| Teacher portal | Dashboard, students, classes, subjects, profiles, grade encoding/status, academic records/history, reports, account settings and help |
| Staff accounts | Supabase Auth account creation, temporary password requirement, first-login password gate, reset email, activate/deactivate, unique teacher IDs and assignment permissions |
| Reports | Enrollment reports, class lists, teacher assignments, grade progress, finalized performance and school-year comparison; CSV and printable reports |
| Settings | School name/logo/address/contact/support details, school year, grading policy, theme, profile/password, other-session sign-out and cache controls |
| Audit | Actor/time/action/record and before/after changes; dedicated grade revisions and staff account audit events |

Quarter grades use the configured range within 0–100 and decimal precision. The retained default policy is **four-quarter average rounded to the nearest whole number**. Migration 005 copies the currently saved school passing mark into each existing year, and new years inherit the saved setting. It does not reset an existing passing mark to 75. Once a year has submitted grades, its grading policy is locked. Historical grades start as `Legacy`; they are preserved but are not represented as newly approved official grades.

## Files changed and added

Changed: `src/main.tsx`, `src/AuthScreen.tsx`, `src/auth.css`, `src/PublicEnrollment.tsx`, `src/lib.ts`, `src/offline.ts`, `src/SyncStatus.tsx`, both `supabase/functions/*/index.ts`, and `README.md`.

Added:

- `src/AcademicWorkspace.tsx`: administrator/teacher modules, grade editor/review, configuration forms, reports, staff accounts and help.
- `src/academic-api.ts`: online privileged operations and expected-version handling.
- `src/academic.css`: consistent responsive workspace, tables, forms and print styling.
- `src/IdentityReview.tsx`: enrollment identity verification interface.
- `supabase/migrations/005_academic_portals.sql`: schema expansion, RLS, guards, grade workflow, receipts and revision history.
- `supabase/preflight_academic.sql`: read-only compatibility/conflict/count checks.
- `tests/academic-portals.test.ts`, `tests/offline-academic.test.ts`, `tests/staff-access.test.ts`: database, queue and staff endpoint regressions.
- `.env.example`: public configuration template, with no secret key.
- `ACADEMIC_UPDATE_GUIDE.md`: this document.

Existing unrelated edits in `src/enrollment-guide.css` and `supabase/.temp/cli-latest` were left alone. Review those separately before committing them. The source archive includes the current CSS but excludes the temporary CLI directory.

## Database mapping

Reuse existing names instead of creating a second student database:

| Requested entity | Existing or new implementation |
| --- | --- |
| Teachers | `profiles` with teacher role, teacher_code, active, must_change_password, phone and can_grade |
| Enrollment applications / documents | Existing `applications` / `documents` |
| Student enrollments | Existing `enrollments`, with active state and `enrollment_history` |
| Teacher subject assignments | Existing `assignments`, with active state and uniqueness protection |
| School catalog | Existing `school_years`, `grade_levels`, `sections`, `subjects`; new `subject_offerings` |
| Advisers | New `teacher_class_assignments` |
| Academic workflow | New `grading_periods`, `grade_submissions`, `grade_revisions`; existing `grades` for official quarters |
| Offline receipts | Existing `sync_receipts` plus new `academic_operations` for grade operations |
| Audit | Existing `audit_logs`, extended with before_data and after_data |

Migration 005 is transactional and intended to run **once after 004**. It preserves records, adds constraints/indexes and closes new grading periods initially. It aborts if existing assignments contain competing teachers for the same section and subject; resolve genuine conflicts using school records before retrying. Do not drop student tables or rerun migration 001 on the existing database.

## Deployment order for this existing site

1. Back up the Supabase database and confirm migrations 001–004 are already installed. Run `supabase/preflight_academic.sql` in SQL Editor. Confirm all five expected columns appear, the assignment-conflict query returns no rows, and retain the reported counts/passing mark. If the live schema differs, stop and reconcile it before running 005.
2. Test the migration in a separate Supabase staging project restored from an authorized backup. Then run the entire `005_academic_portals.sql` once in the intended production SQL Editor. Compare student/application/enrollment/grade/document/link counts afterward. A SQL error means the transaction must be rolled back before retrying; do not run fragments to skip an error.
3. Deploy both updated Edge Functions from the project folder using your own Supabase login. `supabase/config.toml` disables gateway JWT verification; `manage-users` verifies JWTs and profile authorization inside the function. Never remove those checks.

```cmd
cd /d "C:\Users\kasan\OneDrive\Desktop\RZM_Enrollment_System\enrollment-system"
npx supabase login
npx supabase functions deploy manage-users --project-ref yiazkffyceujhtsxvgds
npx supabase functions deploy public-enrollment --project-ref yiazkffyceujhtsxvgds
```

4. In Supabase Edge Function Secrets, make sure `ALLOWED_ORIGINS` includes exactly `https://rzm-enrollment-system.vercel.app`, without a trailing slash. Preserve any other deliberately authorized origins; do not allow every Vercel deployment by wildcard. Keep `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` configured and register the stable school hostname in Cloudflare. Supabase supplies the server-side service-role key to its functions; it must never appear in Vite variables or the browser.
5. In Supabase Auth, disable public signup, configure the production Site URL and allowed reset redirect `https://rzm-enrollment-system.vercel.app/?reset-password=1`, and configure a working email provider for password resets. Actual reset email delivery still needs testing. Keep existing Vercel `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` values; `.env.example` is only a template.
6. Check the app locally, then commit and push the reviewed source. These commands explicitly stage this update and exclude the unrelated temporary CLI change. Check any previously staged changes with `git diff --cached` before committing.

```cmd
npm ci
npm test
npm run build
git diff --check
git add src/main.tsx src/AuthScreen.tsx src/auth.css src/PublicEnrollment.tsx src/lib.ts src/offline.ts src/SyncStatus.tsx src/AcademicWorkspace.tsx src/academic-api.ts src/academic.css src/IdentityReview.tsx
git add supabase/migrations/005_academic_portals.sql supabase/preflight_academic.sql supabase/functions/manage-users/index.ts supabase/functions/public-enrollment/index.ts
git add tests/academic-portals.test.ts tests/offline-academic.test.ts tests/staff-access.test.ts .env.example README.md ACADEMIC_UPDATE_GUIDE.md
git diff --cached --stat
git commit -m "Add teacher portal and reviewed academic records workflow"
git push origin main
```

7. Check the GitHub build/test job and Vercel deployment result. Confirm the production alias points to the successful new deployment. Open the stable domain, refresh, and sign in again so permissions and cached data are refreshed. A Git push updates Vercel only when its repository integration and production branch are configured correctly.
8. In Admin, review School Year Management policy values, configure four quarter start/end dates and open only the intended encoding period. Create/confirm year-specific subject offerings, sections, advisers and teacher subject assignments. Assign students through Class Assignments. Existing subject assignments/grade rows supply the migration's initial offerings; the migration does not invent curriculum subjects or adviser identities.

Use a short coordinated maintenance window for the database/function/frontend switch: the old frontend's direct grade edits will be rejected after the new database restrictions are installed. Do not downgrade only the frontend to regain direct grade access. Keep backups and investigate failed deployment checks before resuming school use.

## Offline behavior and privacy

- On a private device, staff may explicitly enable offline access for eight hours after online login. Cached school data is stored in IndexedDB, partitioned by account; localStorage holds small preferences/deadline metadata, not the student database.
- Open the intended class/quarter online once so its server-authorized roster is available offline. Save grades as drafts. Reconnect to synchronize automatically, or use Sync Now.
- Draft operations have UUIDs and expected versions. A retry uses the same operation ID. Stale data becomes a conflict; grade conflicts cannot force-overwrite a submitted record. Use the cloud version and re-enter reviewed corrections. Failed operations can be inspected/cancelled after reconnecting; storage failures are reported instead of showing a false save success.
- Enrollment approval, promotion, submission, grade review/approval and finalization require online server validation. Offline decisions cannot finalize records.
- Documents, audit snapshots and grade revision snapshots are online-only. Teacher caches contain only assignment-authorized student fields. Logout removes the current session/access deadline and isolates any unsynchronized work to its original account. Account Settings can clear that account's cache after pending work is synchronized.
- IndexedDB is browser storage, not an encrypted vault against someone controlling the same OS/browser profile. Use device encryption and separate protected OS accounts for school devices. Revocation while disconnected cannot be learned until reconnection; the trusted offline window limits normal UI access but is not remote device erasure.
- If a finalized learner transfers sections, their original quarter remains with the original submission. Authorized reopening retains its historical roster; the new section cannot submit a duplicate quarter. Deactivate rather than delete assignments to preserve history. If the original teacher assignment is inactive, an administrator must arrange an authorized active assignment before a correction can be encoded.

## Testing evidence and release checklist

Local checks completed on 11 October 2026:

- 12 tests across five files passed using Node's in-process test runner. Database tests execute migrations in PGlite with simulated Supabase auth/storage. They cover access restrictions, duplicate identity/capacity guards, four-quarter finalization, returns/reopening, frozen versions, idempotency, stale conflicts, archive guards and corrections after a section transfer.
- Offline tests cover ordered retries, account isolation, conflicts, quota failures and denial of offline approval. Staff endpoint tests use a mocked Supabase client and cover token/origin/role checks, first-login password changes and absence of passwords from profile/audit writes.
- Frontend and Edge Function TypeScript checks passed. `git diff --check` passed.
- Local browser checks used synthetic students and a local SQL fixture: teacher class visibility, draft entry/sync/submission, administrator review/approval/finalization and mobile layouts. No actual school grades were changed.
- The normal `npm run build` was blocked here by a sandbox `spawn EPERM` when Vite starts esbuild. An in-process TypeScript/Rollup fixture build succeeded for browser checking. Run the normal build in CMD and require CI/Vercel success before release; the fixture build is not a substitute for that check.

Run these acceptance checks on staging, then smoke-test the configured production services without altering real students for testing:

- [ ] Valid public link opens without login; allowed grades, family details, navigation, documents and reference confirmation work.
- [ ] Closed/expired/archived links cannot submit; previous applications remain available.
- [ ] Duplicate LRN and same-name/birthdate cases require appropriate identity review and do not create an accidental second learner.
- [ ] Administrator rejection/correction requires a reason; document verification remarks and audit entries are visible.
- [ ] Enrollment approval creates/reuses one student and assigns one school-year enrollment; assigned teacher sees it.
- [ ] Create a test teacher, complete first-login password change, reset via real email, deactivate, and verify protected access is denied.
- [ ] A second teacher and an anonymous browser cannot read or export the first teacher's protected class records, documents or grade submissions through direct API calls.
- [ ] Close a quarter; saving/submitting fails. Reopen with dates and validate numeric bounds, precision, blanks, missing student, wrong assignment and duplicate submission.
- [ ] Save offline, reload on the trusted device, reconnect and confirm exactly one replay. Update the same record from a second session and confirm a conflict instead of lost changes.
- [ ] Submit, review, return with remarks, correct, approve, finalize and reopen. Confirm locked views, immutable history, official values and rounded four-quarter final.
- [ ] Transfer a finalized learner, correct the old quarter, and confirm the new section cannot create a second official quarter record.
- [ ] Archive a completed year; edits and old public-link submissions fail while history/reports remain readable.
- [ ] Switch accounts, sign out, clear caches and test trusted-window expiry on a shared test device.
- [ ] Verify desktop/mobile navigation, keyboard labels, light/dark themes, CSV in Excel, printed/PDF reports and Supabase private document access.
- [ ] Confirm Turnstile verification, CORS, real Supabase Auth/Storage, reset emails, Vercel service-worker delivery and production build on the actual services.

## Configuration still owned by the school

The school must supply its current curriculum offerings, teacher identities and assignments, quarter dates, contact/support details, authorized grading policy values and official report templates. No subjects are permanently hard-coded into the new workflow. This update accepts quarterly grades; it does not implement raw assessment-component weighting/transmutation.

Exports are CSV (Excel-compatible) and browser Print/Save as PDF. Native XLSX and official SF9/SF10 layouts are not included because no approved templates were provided. Reports identify unfinalized legacy grades rather than certifying them. Large deployments still use paginated full authorized datasets in the browser; server-side analytics/filtering may be needed as volume grows.

Production database backups, record retention/deletion schedules, privacy notices, permitted offline devices, SMTP delivery and real-service acceptance checks require the project owner/school. This guide does not certify legal compliance or claim production security testing.

Relevant implementation references: [Supabase database functions](https://supabase.com/docs/guides/database/functions), [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security), [Supabase Auth administrative user updates](https://supabase.com/docs/reference/javascript/auth-admin-updateuserbyid).
