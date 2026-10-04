# Exam sync to Google Calendar

One-way: Schulmanager → Google. Node.js 24+ and `npm ci` are required for sync
(the original CLI still runs on Node 22). SQLite uses Node's built-in driver.

## Google authorization

Google's private iCal address is read-only. It identifies the target calendar,
but is not a write credential. This tool extracts the calendar ID without
fetching or logging that secret URL. Writes use the Calendar API.

For a headless Docker container, authorize once on your workstation:

1. Create a Google Cloud project and enable the **Google Calendar API**.
2. Configure its OAuth consent screen for your account. If the app is in Testing,
   add yourself as a test user. Google commonly expires Calendar refresh tokens
   after seven days for external apps in Testing; move to Production for ongoing
   unattended use. Personal-use apps may still show an unverified-app warning.
3. Create an OAuth client of type **Desktop app**. Take its client ID and secret.
4. On your workstation, set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then
   run `node google-oauth.js`. Open the printed URL in the browser on that same
   workstation and grant Calendar access. The helper listens only on loopback
   port 8085, uses state and PKCE, and times out after five minutes.
5. Save the printed `GOOGLE_REFRESH_TOKEN` in the container's environment.

The container never needs a browser or interactive prompts. The official Google
auth library renews access tokens using the refresh token. The account must have
write access to the target calendar. The requested scope is `calendar.events`.
You can change the helper port with `GOOGLE_OAUTH_PORT`. It is not an OOB/paste-code
flow. Run the helper outside Docker to avoid forwarding loopback callbacks.

For `redirect_uri_mismatch`, check that the client ID belongs to a Desktop app.
The helper uses `http://127.0.0.1:8085/` (or the configured port) and prints that
URI before the login link. With a Web application client, register this exact
value as an authorized redirect URI; `localhost` and `127.0.0.1` differ, and the
port and trailing slash must match. Restart the helper and open its new link.

Alternatively use a service account: share the target calendar with its email
and give it permission to make changes to events. Supply credentials with
`GOOGLE_SERVICE_ACCOUNT_JSON` or mount its JSON key and set
`GOOGLE_APPLICATION_CREDENTIALS`. OAuth is preferred for your personal account.

## Environment and commands

Copy `.env.example` to `.env` and fill in the values. Compose loads that file;
running Node directly requires exporting variables or `node --env-file=.env`.
Passwords and Google credentials are never printed by sync or saved in SQLite.
The OAuth helper deliberately prints the refresh token for initial setup.

Required:

- `SCHULMANAGER_USERNAME`, `SCHULMANAGER_PASSWORD`
- `GOOGLE_CALENDAR_ICAL_URL` or `GOOGLE_CALENDAR_ID`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`

Optional:

- `SYNC_WEEKS=26`: exams from today through N weeks ahead, inclusive.
- `SYNC_HOURS=4`: local hours divisible by this number (0,4,8,12,16,20).
- `SYNC_TIMEZONE=Europe/Berlin`: dates and daemon scheduling timezone.
- `SYNC_PREFIX_STUDENT_NAME=true`: prefix exam titles with the selected student's
  first name even when the account has only one associated student. If the
  Schulmanager account has multiple associated students, the selected student's
  first name is prefixed automatically; no option is needed. For example,
  `Werken – Kurztest` becomes `Raphael - Werken - Kurztest`. Existing managed
  events are updated to match the current title on the next sync.
- `SCHULMANAGER_STUDENT_ID`: explicit student; otherwise
  `SCHULMANAGER_STUDENT=1` chooses the first associated student.
- `SCHULMANAGER_INSTITUTION_ID`, `SCHULMANAGER_BUNDLE_VERSION`.
- `SYNC_DB_PATH=./data/sync.sqlite` and
  `SYNC_SESSION_PATH=./data/schulmanager-session.json` outside Docker.
- `SCHULMANAGER_IMAGE`: optional GHCR image override; unset uses a local build.

```bash
npm ci
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
