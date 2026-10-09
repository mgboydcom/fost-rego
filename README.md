# CFP Hub: conference call for proposals

A small web app for running calls for proposals (CFPs) across one or more conferences.

- **Speakers** create an account, pick which conference to submit to, and edit or withdraw their proposals while the CFP is open. Once accepted, they confirm or decline their slot and can keep refining the title and abstract for the program.
- **The program review committee** scores each proposal from 1 to 5, recommends accept, maybe or reject, and leaves comments. Reviewers see colleagues' reviews only after submitting their own. Anonymous review can be switched on per conference.
- **Organisers (admins)** create conferences (dates, CFP window, tracks, session formats), choose the committee, make decisions one at a time or in bulk, write a message to each speaker, and choose when decisions become visible to speakers.
- **Everything exports to spreadsheets** (`.xlsx`, `.csv` and `.json`) with stable column names, so the data can feed mail merges, Google Sheets, Zapier, Make, Power Automate and similar tools.

## Quick start

Requires Node.js 22.13 or newer. Storage uses the built-in `node:sqlite`, so there is no database to install.

```bash
npm install
npm run seed    # optional demo data (see below)
npm start       # http://localhost:3000
```

On a fresh install with no seed data, **the first account you register becomes the organiser (admin)**. Everyone who registers after that is a speaker. Admins add reviewers on each conference's settings page, or change roles under **Organise → People**.

Demo accounts created by `npm run seed` (password `password123` for all):

| Email | Role |
| --- | --- |
| admin@example.com | Organiser |
| reviewer1@example.com, reviewer2@example.com | Reviewers |
| ada@example.com, grace@example.com, linus@example.com | Speakers |

### Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `BASE_URL` | `http://localhost:PORT` | Public URL, used in exported links (`proposal_url`, `review_url`) and on the exports page |
| `DATABASE_FILE` | `data/cfp.db` | SQLite file location |
| `SESSION_SECRET` | auto-generated and stored in the DB | Cookie signing secret |
| `NODE_ENV=production` | | Marks cookies `Secure` (serve over HTTPS) |

## Proposal lifecycle

```
submitted ──► accepted ──► speaker confirmed / declined
     │    └─► waitlisted
     │    └─► rejected
     └──────► withdrawn (by the speaker, at any time)
```

- Speakers can edit while the CFP is open. Each edit bumps `version` and is logged in the proposal history. Accepted speakers can keep editing after decisions are published (for example, to polish the program copy).
- Until an organiser clicks **Publish decisions to speakers** for a conference, speakers see "Under review". This lets the committee finalise everything before anyone is told.
- Decision dates (`decided_at`), confirmations (`confirmed_at`) and the last change (`updated_at`) are recorded and exported, so follow-up workflows can react to them.

## Spreadsheet exports

Go to **Organise → Spreadsheet exports**. Five datasets are available, one row per item:

| Dataset | Use it for |
| --- | --- |
| `submissions` | Everything about each proposal: talk details, speaker contact details, status, decision visibility, speaker confirmation, message to the speaker, internal notes, review count, average score and vote counts, timestamps, links |
| `program` | Accepted talks only, with speaker bio, photo and confirmation status: for the website, schedule and speaker comms |
| `speakers` | One row per speaker with counts of proposals by outcome |
| `reviews` | One row per review |
| `conferences` | Settings and headline numbers |
| `workbook` | All of the above as tabs in one `.xlsx` file |

Signed-in admins download from `/admin/export/<dataset>.<csv|xlsx|json>`.

For automation, each dataset is also served from a secret-token URL that needs no login:

```
/api/export/<token>/<dataset>.<csv|xlsx|json>?conference=<slug>&status=<status>&updated_since=<ISO time>
```

- **Google Sheets:** `=IMPORTDATA("https://your-host/api/export/<token>/program.csv")`
- **Zapier, Make, Power Automate or cron:** poll `submissions.json?updated_since=<last run>` and branch on `status`, `decisions_published` and `speaker_confirmation`. For example: send an acceptance email when a row has `accepted` and `yes`, send a reminder when confirmation is still empty after a week, or send logistics once a speaker is `confirmed`.
- **Mail merge:** download `program.xlsx` and merge on `speaker_name`, `speaker_email`, `title` and `feedback_to_speaker`.

The token is shown on the exports page and can be regenerated there, which immediately breaks the old links. Treat the token like a password, because exports contain speaker contact details. In CSV output, cells that start with `=`, `+`, `-` or `@` are prefixed with `'` so spreadsheets don't run user-entered text as a formula.

## Development

```bash
npm run dev     # restarts on file changes
npm test        # end-to-end tests (in-memory DB)
```

Code layout:

```
src/server.js        Express app setup
src/db.js            SQLite schema and helpers
src/auth.js          Password hashing, sessions, CSRF, role guards
src/model.js         Conference and proposal rules (CFP window, edit permissions, visibility)
src/export.js        Dataset queries and CSV/XLSX writers
src/routes/          public, speaker, review (committee), admin, export
views/               EJS templates
public/style.css     Styles (light and dark)
scripts/seed.js      Demo data
```
