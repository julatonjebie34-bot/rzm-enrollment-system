# RZM Enrollment and Student Management System

A React + TypeScript application for Restituta Z. Medina Elementary School. Vercel hosts the interface; Supabase provides PostgreSQL, staff authentication, Edge Functions, and private document storage. Parents enroll through a school-generated link without creating accounts.

## Included

- Responsive administrator dashboard, live counts, recent applications, grade distribution, light/dark theme.
- Student database, profiles, search, documents, enrollment history, academic history and printing.
- Applications with pending, review, incomplete, rejected, and enrolled states; editing and transactional approval into a section.
- Enrollment links with grade selection, school year, opening/closing dates, publishing, archiving, preview and copying.
- Form builder for instructions and additional optional text questions. Core fields remain fixed for consistent student records.
- Six-step public enrollment, field validation, private photo/birth certificate uploads, duplicate LRN checks, reference confirmation, and Turnstile anti-bot protection.
- Grade levels, sections, subjects, teacher assignments, automatic subject assignment, quarterly grades, final grades and configurable passing threshold.
- Teacher accounts with assigned-class visibility. Grade editing requires both assignment and explicit permission.
- Admin-controlled promotion to the next grade/year, requiring complete passing grades, preserving historical enrollment.
- Staff creation and permission editing; password changes; audit metadata for database changes.
- School-year/grade/section report filters; master lists, class lists, grade reports, enrollment history, statistics; CSV and browser print/PDF.
- Database row-level security, private file access, GitHub build/test workflow, Vercel routing configuration, reproducible dependency lockfile.

## 1. Run locally

Install Node.js 22 or newer. In this folder:

```sh
npm ci
cp .env.example .env.local
npm run dev
```

Fill `.env.local` with your Supabase Project URL and publishable key (the legacy anon key also works). These two values are intended for the browser. **Never put a service-role/secret key in a VITE variable, GitHub, or chat.** Without configuration, the application shows setup instructions rather than fictitious student records.

## 2. Create the Supabase database

Create a Supabase project. Open SQL Editor and run the entire `supabase/migrations/001_school.sql` once. It creates tables, policies, triggers, RPC functions, grade-level defaults and a private document bucket. For existing projects, use a fresh database or review schema conflicts before running; the migration is not intended to run twice.

In Auth settings, disable public email signup; only staff created by the administrator should have accounts. Configure a strong password policy. Configure production Site URL and local/Vercel redirect URLs for future auth recovery flows.

### First administrator

In Supabase Authentication → Users, add a staff user with email/password and confirm the email. Copy its user UUID, then run in SQL Editor:

```sql
insert into public.profiles (id, full_name, role, can_grade)
values ('REPLACE-WITH-AUTH-USER-UUID', 'School Administrator', 'admin', true);
```

Only SQL Editor/project owners can bootstrap the first administrator. The application does not automatically make newly signed-in users administrators.

## 3. Deploy Edge Functions

Use Supabase CLI with your own authenticated account:

```sh
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase functions deploy public-enrollment
npx supabase functions deploy manage-users
```

`supabase/config.toml` disables the legacy JWT gateway for both functions. The staff function verifies the access token itself and checks the administrator profile; the public function requires an open published enrollment link and successful Turnstile verification. Supabase provides `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to deployed Edge Functions; these never go into the client.

In Supabase Edge Functions → Secrets, configure:

- `ALLOWED_ORIGINS`: comma-separated exact origins, e.g. `http://localhost:5173,https://your-school.vercel.app` (no trailing slash).
- `TURNSTILE_SITE_KEY`: Cloudflare Turnstile site key.
- `TURNSTILE_SECRET_KEY`: matching secret key.

Create a free Turnstile widget in Cloudflare and register your localhost/deployed domains. The public form loads the widget and verification requires the `enrollment` action. Submissions intentionally remain disabled until these values are configured. Preview origins must be added explicitly if testing public forms on Vercel preview URLs.

## 4. Upload to your new GitHub repository

Create an empty private repository named `rzm-enrollment-system` in your GitHub account. Do not initialize it with a README. Using a terminal in the project folder:

```sh
git init -b main
git add .
git commit -m "Build RZM enrollment and student records system"
git remote add origin https://github.com/YOUR_USERNAME/rzm-enrollment-system.git
git push -u origin main
```

Alternatively, upload the extracted source files using GitHub's web interface. Include the files inside this folder as repository-root files. Do not upload `node_modules`, `dist`, `.env.local` or the ZIP itself. `.gitignore` excludes local credentials and generated files. The GitHub Action runs tests and a production build on pushes and pull requests.

## 5. Deploy on Vercel

In Vercel choose Add New → Project → import your GitHub repository. Use framework **Vite**, root directory `./`, install command `npm ci`, build command `npm run build`, output directory `dist`. Add:

```
VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR-PUBLISHABLE-KEY
```

Deploy. Add the resulting exact Vercel origin to `ALLOWED_ORIGINS` and the Turnstile allowed domains. Environment-variable changes on Vercel require redeployment. `vercel.json` includes SPA routing to prevent missing-page errors.

## 6. Configure the school

1. Sign in as the bootstrap administrator.
2. Settings → School Information: set school name and passing mark.
3. Settings → School Years: create the current year and activate it. Deactivate the old year before activating a different year; only one active year is permitted.
4. Academics → Subjects: add subjects for each grade. Grade-level defaults are already included. Adding a subject also adds missing records to existing enrollments in that grade.
5. Academics → Sections: create sections for the correct school year and grade.
6. Users & Access: add teachers with a temporary password of at least 12 characters. Tell them to change it after first sign-in. Teacher grade entry is disabled unless explicitly enabled.
7. Faculty → Assignments: assign teachers to subjects and sections with matching grade levels.
8. Enrollment Links: choose the year, allowed grades, dates and publish the link. In the grade selector use Ctrl/Cmd to select multiple grades on desktop.
9. Enrollment Form Builder: customize instructions and optional questions for each link.
10. Copy the link and share it with parents. Submission creates a pending application, not an approved enrollment.
11. Review application details/documents, then choose a section in “Approve into section…”. Student record, enrollment and subjects are created in one transaction. A returning student's existing LRN updates the existing profile.
12. Enter quarterly grades; reports remain incomplete until all four quarters are present.
13. For promotion, create the next school year and next-grade sections first. Grade 6 has no next elementary grade and cannot be promoted by this flow.

## Validation and boundaries

`npm test` runs the migration against an embedded PostgreSQL engine with simulated Supabase auth/storage tables. It verifies approval/section constraints, automatic subjects, quarterly averages, incomplete promotion rejection, teacher access, unauthorized access denial, successful promotion and audit creation. `npm run build` checks frontend TypeScript and creates production assets.

These checks do not replace deployment verification: actual Supabase Auth, Storage, Edge Functions, Turnstile, email delivery, Vercel hosting and real browser workflows need testing against your configured projects. The delivered source was not deployed to your accounts. No production credentials or student data are included.

The default final grade is `round((Q1+Q2+Q3+Q4)/4)`, with a default passing mark of 75. Confirm the school's grading policy before use; this app does not compute weighted written-work/performance-task assessment components. Reports export CSV, which Excel can open, rather than native XLSX. PDF uses browser Print → Save as PDF. Form builder supports optional text questions, not arbitrary drag-and-drop field types. No online payments, attendance, parent accounts, SMS/email automation or official DepEd SF9/SF10 layout is included.

Rows are fetched in 1,000-row pages. For large deployments, replace browser-wide dataset loading with server-side filtering/aggregations. Audit logs record actor/action/table/record/time, not complete before/after personal-data snapshots. Public submissions without LRN cannot be automatically identified as the same learner; review them manually. In rare interrupted uploads, orphaned private files may require storage cleanup. Production backups, retention, school privacy notices, and account recovery operations are configured by the Supabase project owner.

## Project layout

- `src/`: React interface and Supabase client.
- `supabase/migrations/001_school.sql`: schema, RLS policies, automation and transactional operations.
- `supabase/functions/public-enrollment/`: validated public enrollment and document upload.
- `supabase/functions/manage-users/`: administrator-only staff account lifecycle.
- `tests/`: database integration checks.
- `.github/workflows/check.yml`: CI.
- `vercel.json`: hosting and routing.

Official references: https://supabase.com/docs/guides/database/postgres/row-level-security · https://supabase.com/docs/guides/storage/security/access-control · https://vercel.com/docs/frameworks/frontend/vite
