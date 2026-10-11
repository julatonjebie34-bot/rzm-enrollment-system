# RZM Enrollment and Student Management System

The existing React/TypeScript school website for Restituta Z. Medina Elementary School, with connected public enrollment, administrator and teacher portals. Vercel serves the frontend; one Supabase project provides PostgreSQL, staff authentication, private documents and Edge Functions.

## Existing website upgrade

Read [ACADEMIC_UPDATE_GUIDE.md](ACADEMIC_UPDATE_GUIDE.md) before deploying. It covers preserved features, changed files, database mapping, migration preflight, deployment order, offline behavior and acceptance tests.

The existing production project must already have migrations 001–004. Run the read-only `supabase/preflight_academic.sql`, review its results, then apply the complete `005_academic_portals.sql` once. Deploy both Edge Functions before publishing the updated frontend. Do not rerun migration 001 or recreate existing student tables.

## Local development

Use Node.js 22 or newer. From CMD in the project directory:

```cmd
npm ci
copy .env.example .env.local
npm run dev
```

If `.env.local` already exists, keep it rather than overwriting it. Fill the template only for a new installation. The browser receives the Supabase URL and publishable key, never the service-role key. Public enrollment also requires configured Cloudflare Turnstile keys in the server environment.

```cmd
npm test
npm run build
```

Tests cover database migrations/RLS, enrollment details, grade workflow, offline queue behavior and staff account authorization. GitHub Actions also runs the tests and production build. Local fixture tests use synthetic records and do not prove production Auth, email, Storage or Turnstile configuration.

## Fresh installation only

On an empty Supabase project, apply migrations 001, 002, 003, 004 and 005 in order. Disable public staff signup. Create the first administrator in Supabase Authentication, then insert that user's UUID into `profiles` through SQL Editor:

```sql
insert into public.profiles (id, full_name, role, can_grade)
values ('REPLACE-WITH-AUTH-USER-UUID', 'School Administrator', 'admin', true);
```

Complete the Edge Function, Auth redirect, SMTP, Cloudflare and Vercel setup described in the update guide. Configure the active year, grading periods, subject offerings, sections and assignments using the administrator portal. Real curriculum and staff information must come from the school.

## Workflow

Public enrollment link → pending application → administrator identity/document review → student and section assignment → authorized teacher grades → administrator review/finalization → academic records.

Teachers see their own assigned records and can save offline drafts on an explicitly trusted device. Submission and all approval/finalization decisions require online server verification. Four-quarter final averages are rounded to a whole number using the existing school passing mark. Legacy grades remain available and visibly unreviewed until finalized through the new workflow.

## Project structure

- `src/main.tsx`: existing administrator shell and enrollment management.
- `src/PublicEnrollment.tsx`: public multi-step form.
- `src/AcademicWorkspace.tsx`, `src/academic-api.ts`, `src/academic.css`: academic modules, teacher portal, grade workflow and staff settings.
- `src/IdentityReview.tsx`: learner identity resolution.
- `src/offline.ts`, `src/local-db.ts`, `src/SyncStatus.tsx`: IndexedDB, versioned queue and synchronization controls.
- `supabase/migrations/`: ordered schema, RLS and server-operation migrations.
- `supabase/functions/`: public enrollment and authenticated staff account endpoints.
- `tests/`: integration and regression checks.
- `.github/workflows/check.yml`: test/build checks.
- `public/sw.js`, `vercel.json`: app assets and deployment routing.

CSV exports open in Excel; PDF output uses browser printing. Official SF9/SF10 layouts and native XLSX are not supplied. The guide records these boundaries and remaining production configuration tasks.
