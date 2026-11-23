# Deployment status — 23 November 2026

## Prepared and verified

- Repository: [odndashboard/SmartConstruction](https://github.com/odndashboard/SmartConstruction).
- Application source commit: `71ecb4bf3145fdcce1f0e55d38aabab299366e71`.
- Vercel project: [smart-construction-crm](https://vercel.com/odnprints-6693s-projects/smart-construction-crm).
- Stable address: [smart-construction-crm.vercel.app](https://smart-construction-crm.vercel.app).
- Deployment: `dpl_AMfKodeMzr1pW5wXTpjVkGMSQQPb`, reported **READY**.
- Hosted build succeeded. An authenticated Vercel fetch returned HTTP 200 and the expected setup-pending page.
- Local checks: 60 passing tests, clean lint, successful Next.js 16.4.6 production build, and zero reported production dependency vulnerabilities.
- Production `APP_URL` has been set to the stable address above. Environment changes take effect on a subsequent deployment.

The first successful deployment was assigned to Vercel's production target. It currently displays a setup-pending screen. **Employee sign-in and shared business storage are not operational yet.** The project's existing Vercel deployment protection remains enabled while setup is incomplete.

## What is still needed

1. **Select the intended Supabase project.** No Supabase project URL or credentials have been supplied or connected to this application.
2. **Apply the schema** from [the SQL migration](../supabase/migrations/202611230001_crm.sql) in that project's SQL Editor.
3. **Configure authentication** and enter the Supabase URL, publishable key and server secret directly into Vercel's environment variables, then redeploy. Keep secret keys out of chat and GitHub.
4. **Create the owner's account** and explicitly designate its Auth UUID using the administrator bootstrap steps in [DEPLOYMENT.md](DEPLOYMENT.md).
5. **Grant Vercel's GitHub integration access** to `odndashboard/SmartConstruction`, then connect that repository under the existing Vercel project's Git settings. The source was deployed directly through the Vercel API; automatic deployment on GitHub pushes is not connected.
6. **Finish live verification**, including real account activation, login, logout, password changes, disabled-member access, concurrent edits, and mobile/desktop use. Before onboarding employees, configure deployment protection so the stable CRM URL reaches the application's own login without requiring a Vercel account.
7. **Add employees from Settings → Team**, generate their individual private setup links and share each link only with its intended employee. No invitation email is automatically sent.

No real employee accounts were created or invitations sent during preparation. No existing ChatGPT Site database records were copied. If the original Site contains records to retain, follow [MIGRATION.md](MIGRATION.md) before switching staff to the new system.

## Administrator's next step in Chrome

Open the Supabase project intended for Smart Construction and identify its dashboard URL or project name. With that project selected, the remaining database and account setup can be completed through Supabase and Vercel's browser dashboards using [DEPLOYMENT.md](DEPLOYMENT.md). The project dashboard URL is not a secret key.
