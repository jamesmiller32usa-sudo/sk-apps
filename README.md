# sk-apps

One site for the Sharanga team apps. Hosted free on Cloudflare Pages; every push to `main` deploys automatically.

| Path | App |
|---|---|
| `/` | Sign-in portal and app list |
| `/crm/` | Sharanga CRM (orders, Omnichannel Inbox, sales, manufacturing cost, SKU analytics) |
| `/books/` | Books (accounting for Sharanga and Mynflow, Google Sheet backend) |
| `/assets/` | Shared sign-in (`auth.js`) and the Supabase client |

## Sign-in
- Supabase Auth (project `dkwlsfzysjdubcwuemvx`). Usernames map to `<username>@skhq.app`.
- Who may open which app lives in the `app_users` table (`crm_role`: admin / moderator / null, `books`: true / false, `active`).
- No passwords are stored in this repository.
