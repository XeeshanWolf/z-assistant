# Z Assistant

Personal task, idea and reminder app. Installable on any phone, works offline, and saves to your account in the cloud.

Live: https://xeeshanwolf.github.io/z-assistant/

## What it does
- Sign in on any phone and see the same list. Works offline and syncs when back online.
- Smart capture: type "Call Ali tomorrow 5pm #clients !" and it sets the date, a reminder, the list and the priority.
- Reminders that buzz your phone, even when the app is closed, with snooze.
- Repeating tasks, lists, checklist steps, search, a daily "plan your day" nudge, a 25 minute focus timer.
- Backup and restore.

## How it is built
- `index.html` the whole app. `sw.js` offline cache and notifications. `lib/supabase.js` Supabase client 2.118.0.
- `supabase/schema.sql` tables and privacy rules (each account sees only its own rows).
- `supabase/functions/remind` sends reminders and the daily nudge; run every minute by pg_cron.
- `.github/workflows/deploy.yml` on every push: sets up Supabase from the `SUPABASE_ACCESS_TOKEN` secret, writes `config.js`, publishes to GitHub Pages. Result: `/deploy-status.json` on the live site.
- `.github/workflows/keep-awake.yml` daily ping so the free database is not paused.

Everything runs on free plans: GitHub Pages and Supabase Free.
