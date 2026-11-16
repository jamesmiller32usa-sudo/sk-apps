# Our Apps (sk-apps)

One site for the Sharanga team apps. Hosted free on Cloudflare Pages; every push to `main` deploys automatically.

| Path | App |
|---|---|
| `/` | Team gate (one shared password) and the app list |
| `/crm/` | Sharanga CRM (orders, Omnichannel Inbox, sales, manufacturing cost, SKU analytics) |
| `/books/` | Books (accounting for Sharanga and Mynflow, Google Sheet backend) |
| `/assets/` | Shared sign-in (`auth.js`) and the Supabase client |

## Sign-in
- Step 1, gate: one shared team password (Supabase user `team@skhq.app`) opens the site and shows every app.
- Step 2, each app has its own login:
  - CRM: personal Supabase accounts (`<username>@skhq.app`); access and role in the `app_users` table (`crm_role` admin / moderator).
  - Books: its own built-in sign-in (Apps Script).
- Gate and CRM sessions are kept apart (separate storage keys). No passwords are stored in this repository.
