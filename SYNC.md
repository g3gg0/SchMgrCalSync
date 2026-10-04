# Exam sync to Google Calendar

One-way: Schulmanager → Google. Node.js 24+ and `npm ci` are required for sync
(the original CLI still runs on Node 22). SQLite uses Node's built-in driver.

## Google authorization

Google's private iCal address is read-only. It identifies the target calendar,
but is not a write credential. This tool extracts the calendar ID without
fetching or logging that secret URL. Writes use the Calendar API.

For Portainer, generate the Google token once on your own computer. The sync
container does not host an OAuth callback and needs no public callback URL,
HTTPS endpoint, reverse proxy, or inbound port.

1. Create a Google Cloud project and enable the **Google Calendar API**.
2. Configure its OAuth consent screen for your account. If the app is in Testing,
  add yourself as a test user. Google commonly expires Calendar refresh tokens
  after seven days for external apps in Testing; move to Production for ongoing
  unattended use. Personal-use apps may still show an unverified-app warning.
3. Create an OAuth client of type **Desktop app**. No public domain or HTTPS
   redirect URI is required; the helper uses `http://127.0.0.1:8085/` locally.
4. On your computer, install Node.js 24+, clone this repository, then run
  `npm ci` in the repository root. Run `npm run google-oauth`; it asks for the
  OAuth Client ID and Client Secret (the secret input is hidden).
5. Open the printed Google authorization link in a browser on the same computer
   and approve access. The helper listens only on `127.0.0.1`, uses state and
   PKCE, and times out after five minutes. On success, it prints a
   `GOOGLE_REFRESH_TOKEN=...` line in the terminal.
6. Copy that token into the Portainer stack's `GOOGLE_REFRESH_TOKEN` environment
   variable and deploy/restart the stack. Keep the token private; do not commit it
   or put it in a public log. The token is not automatically transferred from
   your computer to Portainer.

The sync container uses that refresh token to renew Google access tokens. The
Google account must have write access to the target calendar. The requested
scope is `calendar.events`. If the token expires or access is revoked, run the
local helper again and replace `GOOGLE_REFRESH_TOKEN` in Portainer. If Google
auth values are missing, the daemon prints the local command and stays idle
without repeated failures until the stack is redeployed with credentials.

The sync also imports the selected student's sick notes and non-internal
exemption requests when their dates overlap the sync horizon. Sick notes become
all-day `Krankmeldung` events. Exemptions become all-day `Beurlaubung` events;
`granted=true` is shown as `Genehmigt`, otherwise as `Nicht genehmigt`. A later
approval-state change updates the existing event. These absence events never
receive the `SYNC_REMIND_DAYS` popup reminder.

Alternatively use a service account: share the target calendar with its email
and give it permission to make changes to events. Supply credentials with
`GOOGLE_SERVICE_ACCOUNT_JSON` or mount its JSON key and set
`GOOGLE_APPLICATION_CREDENTIALS`. OAuth is preferred for your personal account.

## Environment and commands

The local helper prompts for Google Client ID and Client Secret if they are not
already set in the environment. Portainer stack variables must be entered in
Portainer and are explicitly passed through the Compose `environment` section.
The helper prints the refresh token once so you can paste it into Portainer; it
does not save it to the repository. Never commit credentials or share the token.

Required:

- `SCHULMANAGER_USERNAME`, `SCHULMANAGER_PASSWORD`
- `GOOGLE_CALENDAR_ICAL_URL` or `GOOGLE_CALENDAR_ID`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`: enter these
  in Portainer after generating the token locally. They may all be unset on the
  first deployment; the daemon will then stay idle and print the setup command.

Optional:

- `SYNC_WEEKS=26`: exams from today through N weeks ahead, inclusive.
- `SYNC_HOURS=4`: local hours divisible by this number (0,4,8,12,16,20).
- `SYNC_TIMEZONE=Europe/Berlin`: dates and daemon scheduling timezone.
- `SYNC_REMIND_DAYS=3`: optional Google Calendar popup reminder before each
  synced exam; valid range is 1 to 28 days. If unset, the calendar's default
  reminders apply to exams. Changing this value updates existing upcoming exam
  events on the next sync. Sick notes and exemptions have no reminders.
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`: optional pair. The bot sends one
  message after a successful sync only when events were created, updated, or
  deleted. Added and deleted entries are listed with date and title; updates are
  shown as a count. No message is sent for unchanged cycles or dry runs. Start a
  chat with the bot and ensure it can message the configured chat. Telegram
  failures are logged but do not roll back calendar changes.
- `SYNC_PREFIX_STUDENT_NAME=true`: prefix exam titles with the selected student's
  first name even when the account has only one associated student. If the
  Schulmanager account has multiple associated students, the selected student's
  first name is prefixed automatically; no option is needed. For example,
  `Werken – Kurztest` becomes `Raphael - Werken - Kurztest`. Existing managed
  events are updated to match the current title on the next sync.
- `SCHULMANAGER_STUDENT_ID`: explicit student; otherwise
  `SCHULMANAGER_STUDENT=1` chooses the first associated student.
- `SCHULMANAGER_INSTITUTION_ID`, `SCHULMANAGER_BUNDLE_VERSION`.
- `GOOGLE_OAUTH_PORT=8085`: optional local loopback port used by the helper.
- `SYNC_DB_PATH=./data/sync.sqlite` and
  `SYNC_SESSION_PATH=./data/schulmanager-session.json` outside Docker.
- `SCHULMANAGER_IMAGE`: optional GHCR image override; unset uses a local build.

```bash
npm ci
npm run google-oauth
node --env-file=.env sync.js --weeks 26 --dry-run
node --env-file=.env sync.js --weeks 26
node --env-file=.env sync.js --daemon --hours 4 --weeks 26
docker compose up --build -d
docker compose logs -f
```

## GitHub Container Registry

The workflow in `.github/workflows/docker-publish.yml` runs tests for pushes and
pull requests. It publishes `ghcr.io/OWNER/REPOSITORY:latest` from the default
branch and version tags (for example `v1.2.3`) as multi-platform images for
`linux/amd64` and `linux/arm64`. GitHub Actions uses its built-in
`GITHUB_TOKEN`; no package secret needs to be added to the repository.

After the first publish, set the image in `.env`:

```env
SCHULMANAGER_IMAGE=ghcr.io/OWNER/REPOSITORY:latest
```

Then pull and start it with the existing Compose configuration:

```bash
docker compose pull
docker compose up -d
docker compose logs -f schulmanager-sync
```

GHCR packages are private by default. Either make the package public in its
GitHub Packages settings or run `docker login ghcr.io` with a GitHub token that
has `read:packages` before pulling. Keep `.env` local; it contains credentials.

To publish this checkout, create an empty GitHub repository (without an
auto-generated README or license), then make the initial commit and push the
default branch. Review `git status` first; local secrets and captures are
excluded by `.gitignore`:

```bash
git add .
git status --short
git commit -m "Initial Schulmanager sync"
git remote add origin https://github.com/OWNER/REPOSITORY.git
git push -u origin main
```

Create and push a version tag to publish a versioned image:

```bash
git tag v1.2.3
git push origin v1.2.3
```

To run the container attached in the foreground, use
`docker compose up --build`. The process itself always stays in the foreground.
One-shot dry run using the same persisted volume:

```bash
docker compose run --rm schulmanager-sync --dry-run
```

CLI flags override weeks/hours environment values. Runs immediately on startup,
then at matching hour boundaries rather than measuring four hours from startup.
For intervals not dividing 24, the schedule resets at midnight (e.g. 5 means
0,5,10,15,20). DST follows local wall time: skipped hours are skipped and repeated
hours can run twice. Cycles never overlap in one process. A SQLite transaction
also prevents simultaneous writers sharing the same DB; run one container per
target/student configuration. SIGINT/SIGTERM stops after the current cycle.
Daemon failures are logged and retried at the next scheduled boundary.

## Reconciliation and persistence

Exams become all-day events on the API's supplied date (no inferred lesson time).
Titles include subject and exam type; descriptions include comments and source ID.
Distinct exams with equal date/subject remain distinct. References are scoped to
school, student and calendar. Google IDs use a stable hash; private event
properties retain the Schulmanager exam ID, student ID and scope.

Every cycle reads all managed Google events with pagination, compares them to
the successful Schulmanager snapshot, creates missing events, corrects changed
events and deletes managed entries absent from that snapshot **within the current
date horizon only**. Past entries and entries beyond the horizon remain untouched.
No unrelated Google events are changed and nothing is written to Schulmanager.
This also restores Google-side edits/deletions when the exam still exists in the
source. Deleted Google IDs can require a replacement ID; the stable source
reference allows discovering that replacement after a restart or DB recovery.

SQLite records source JSON, exam ID/date, Google ID and last successful sync time.
The Docker named volume persists it across restarts. The full cycle uses a DB
transaction. If a Google operation fails midway, the DB rolls back; already
successful Google changes are reconciled on the next cycle using their IDs and
private properties. Only a valid successful exam response can trigger removals.
If the API silently returns an incomplete successful array, it cannot be
distinguished from real deletion; API errors/malformed entries abort the cycle.
An empty successful array removes managed upcoming exams in the horizon.

Dry run reads both systems and reports planned counts without calendar writes
or DB record changes. It can create an empty DB and save a Schulmanager session.
Each cycle logs in afresh to refresh student/class metadata; the session cache
supports reuse by other tools and login renewal during the cycle.

Tests cover identity, idempotency, updates, deletion boundaries, unrelated events,
dry run, malformed source protection, partial failure recovery, pagination and DST.
Live Google writes require your authorization and have not been exercised here.
Docker is not installed in the agent session, so the image build is unverified.

References:

- [Google iCal synchronization](https://support.google.com/calendar/answer/37648)
- [Google offline OAuth](https://developers.google.com/identity/protocols/oauth2/web-server#offline)
- [Google Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Events and private properties](https://developers.google.com/workspace/calendar/api/v3/reference/events)
- [Calendar sharing](https://developers.google.com/workspace/calendar/api/concepts/sharing)
