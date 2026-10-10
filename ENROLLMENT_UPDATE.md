RZM enrollment update — 10 October 2026

The changes are saved in the existing Desktop project:
`C:\Users\kasan\OneDrive\Desktop\RZM_Enrollment_System\enrollment-system`.
They have been tested locally. They have **not** been deployed to the live website or production database.

Completed changes

- Retained the existing React, Vite, Supabase, six-step workflow, colors, and compact layout.
- Required grade selection uses the database's real grade IDs. The migration enables Kindergarten through Grade 6 for your specified enrollment link. New management links default to all seven grades; other existing links keep their configured restrictions.
- Complete Address is a required textarea with the requested example as its placeholder. Email Address is optional and validated. Philippine mobile/landline numbers are validated and saved in +63 format.
- Mother, father, and guardian now have separate name, phone, and address fields. At least one available adult needs a name and valid contact number, preserving the existing requirement for a reachable adult. Family addresses remain optional; unavailable adults can be left unchecked.
- Each family address can follow the student's address and stays synchronized until its checkbox is cleared.
- Previous-school Yes requires school name and address; last completed grade is optional. No clears old school values and skips their validation. Back and Continue retain applicable entered information.
- Review, staff editing, student profiles, submission validation, database persistence, and application approval include the new information. Existing records are preserved by the migration.
- Fixed the missing IndexedDB draft store through a versioned upgrade that retains other local stores.
- Turnstile now loads through a shared script loader, handles widget cleanup, displays diagnostic codes, supports Retry, and clears expired/failed tokens. Backend verification also checks the returned hostname against the permitted request origin. Verification remains mandatory.

Files changed

| Area | Files |
| --- | --- |
| Public form and staff editor | `src/PublicEnrollment.tsx`, `src/EnrollmentDetails.tsx`, `src/RecordDetailsEditor.tsx`, `src/main.tsx` |
| Verification | `src/TurnstileVerification.tsx` |
| Labels and styling | `src/enrollment-labels.ts`, `src/enrollment-i18n.ts`, `src/enrollment-form.css` |
| Saved drafts | `src/local-db.ts` |
| Shared validation and API | `supabase/functions/_shared/enrollment-details.ts`, `supabase/functions/public-enrollment/validation.ts`, `supabase/functions/public-enrollment/index.ts` |
| Database and regression tests | `supabase/migrations/004_enrollment_details.sql`, `tests/enrollment-details.test.ts` |

The pre-existing edits in `src/enrollment-guide.css` and `supabase/.temp/cli-latest` were preserved and are excluded from the deployment commands below.

Cloudflare findings

The screenshot shows an error inside the Turnstile verification widget. During inspection, the permanent Vercel website, its JavaScript/CSS assets, the enrollment GET endpoint, and Cloudflare's widget script were reachable with HTTP 200. The API allowed the permanent domain. HTTPS certificate validation succeeded. DNS resolved the domain to Vercel. These checks did not reproduce an origin-server outage or show a reason to change DNS, proxy, tunnel, or SSL settings.

The original frontend discarded the widget's error code and repeatedly loaded/removed its script. Those code issues have been addressed. The exact cause of the user's live widget error remains **unconfirmed** because no actual error code, Cloudflare widget configuration, or provider logs were available. A successful script download alone does not prove the challenge iframe works on the user's browser/network.

The new error/retry UI was tested using a local simulated error. **The simulated 110200 code is not evidence that the live site has that error.** If the real code is 110200, add `rzm-enrollment-system.vercel.app` under the correct Turnstile widget's Hostname Management. If it is 110100/110110/400020/400070, check the widget/site-key configuration; 200500 points to a challenge iframe loading problem. These mappings follow [Cloudflare's official error-code documentation](https://developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/error-codes/).

Test results

| Check | Result |
| --- | --- |
| Frontend TypeScript and Edge Function TypeScript | Passed |
| Automated suites | 5 tests passed, 0 failed |
| Database migration | Applied 001–004 to a local PostgreSQL-compatible PGlite database; existing records retained |
| Grade and family persistence | All seven grade IDs accepted; separate family/email/school fields saved and copied during approval |
| Existing behavior | Enrollment, grading, promotion, audit, roles, private-record access, duplicate/replay protections passed |
| Browser form validation | Invalid phone/email blocked; grade retained; address synchronization and both previous-school paths passed |
| Local browser submission | Application received; database contained the selected grade, email, mother details, and two document rows |
| Mobile layout | Checked at 390px: no horizontal overflow; readable stacked fields and controls |
| Turnstile lifecycle | Simulated error displayed with code; Retry recovered; Back/Continue required fresh verification and retained one widget |
| Browser console | No errors or warnings in the successful local submission flow; the separate simulated failure emitted the expected diagnostic warning |
| Standard `npm run build` in this session | Blocked by Windows process restriction: esbuild `spawn EPERM`. An in-process TypeScript/Rollup fixture build succeeded for browser testing. Run the normal production build outside this restricted session before publishing. |
| Real Turnstile and production submission after this update | Not tested; deployment and live verification remain |

Local submission testing used synthetic data, a local database, local upload fixtures, and a mock verification widget. It did not submit a real learner application or prove production storage/Cloudflare behavior.

Deployment instructions

Apply the database, Edge Function, and frontend as one coordinated release. Publishing only the frontend can cause new fields to be rejected or lost. Existing open form tabs should be refreshed after rollout.

1. In CMD, run the normal checks:

   ```cmd
   cd /d "C:\Users\kasan\OneDrive\Desktop\RZM_Enrollment_System\enrollment-system"
   npm run build
   npm test
   ```

   Stop if either check fails. The process restriction described above is specific to the agent session; the normal CMD environment still needs verification.

2. In the Supabase dashboard, open project `yiazkffyceujhtsxvgds` → SQL Editor. Confirm migrations 001–003 are already applied, then run the **entire** `supabase/migrations/004_enrollment_details.sql` file once. A copy is provided next to this report. Do not rerun migrations 001–003 on the existing database. Migration 004 adds columns and replaces the relevant submission/approval/sync functions; it does not remove enrollment records.

3. From the same project directory, deploy the updated function:

   ```cmd
   npx supabase functions deploy public-enrollment --project-ref yiazkffyceujhtsxvgds --use-api
   ```

   If the CLI requests sign-in, run `npx supabase login`, sign in locally, then repeat the deployment command. Do not paste access tokens or secret keys into chat. `--use-api` bundles through Supabase without requiring Docker, as documented in the [Supabase CLI reference](https://supabase.com/docs/reference/cli/global-flags#supabase-functions-deploy).

4. Verify the existing Supabase Edge Function secrets: `ALLOWED_ORIGINS` includes `https://rzm-enrollment-system.vercel.app`; `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` belong to the same enabled Cloudflare widget. Keep the secret key server-side. In Cloudflare → Turnstile → that widget → Hostname Management, verify the permanent hostname is allowed. Correct a value only if inspection shows it is wrong.

5. Commit the prepared files and push to GitHub from CMD. Git index writes were blocked in the agent environment, so no commit or push was performed here.

   ```cmd
   git add src/PublicEnrollment.tsx src/EnrollmentDetails.tsx src/RecordDetailsEditor.tsx src/TurnstileVerification.tsx src/enrollment-labels.ts src/enrollment-i18n.ts src/enrollment-form.css src/local-db.ts src/main.tsx supabase/functions/_shared/enrollment-details.ts supabase/functions/public-enrollment/index.ts supabase/functions/public-enrollment/validation.ts supabase/migrations/004_enrollment_details.sql tests/enrollment-details.test.ts ENROLLMENT_UPDATE.md
   git diff --cached --name-only
   git commit -m "Improve enrollment details, validation and verification recovery"
   git push origin main
   ```

   Check the staged file list before committing. Existing unrelated edits are intentionally not included by this command. If other files were already staged, review them separately. Check that Vercel successfully builds this commit and assigns it to the production domain.

6. Open the permanent enrollment link, refresh, and verify all seven grade options. Complete the real verification widget manually. Then perform an authorized production test and confirm its saved application/documents in management. If the widget still fails, capture the displayed code or click the underlined **Troubleshoot** link inside the Cloudflare box and send the diagnostic screen.

Remaining access-dependent work is the production SQL/function/frontend rollout, inspection of the real widget settings/error code, and a real production submission check. The live Cloudflare issue should not be marked resolved until those checks pass.
