# Exam sync to Google Calendar

One-way: Schulmanager → Google. Node.js 24+ and `npm ci` are required for sync
(the original CLI still runs on Node 22). SQLite uses Node's built-in driver.

## Google authorization

Google's private iCal address is read-only. It identifies the target calendar,
but is not a write credential. This tool extracts the calendar ID without
fetching or logging that secret URL. Writes use the Calendar API.

For a headless Portainer/Docker deployment:

1. Create a Google Cloud project and enable the **Google Calendar API**.
2. Configure its OAuth consent screen for your account. If the app is in Testing,
  add yourself as a test user. Google commonly expires Calendar refresh tokens
  after seven days for external apps in Testing; move to Production for ongoing
  unattended use. Personal-use apps may still show an unverified-app warning.
3. Create an OAuth client of type **Web application**. Set its authorized redirect
  URI to the exact value of `GOOGLE_OAUTH_REDIRECT_URI`, including protocol,
  path, port (if any), and trailing slash. For example:
  `https://sync.example.net/oauth/google/callback`.
4. Configure a TLS reverse proxy to forward that path to the container's
  `GOOGLE_OAUTH_PORT` (default `8085`). The proxy terminates HTTPS; the callback
  server listens on HTTP inside the Docker network. Keep the callback port
  reachable only through the proxy/firewall.
5. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and the complete
  `GOOGLE_OAUTH_REDIRECT_URI` in the Portainer stack environment. The Compose
  file explicitly passes these and the Schulmanager credentials into the
  container; Portainer stack variables are not passed through automatically.
6. Start the stack. If no `GOOGLE_REFRESH_TOKEN` is supplied and no saved token
  exists, the container logs an authorization URL. Open it, approve access, and
  Google redirects to the configured callback. The container saves the refresh
  token to `/data/google-refresh-token.json` in the persistent `sync-data`
  volume. No token needs to be copied into Portainer.

The callback response completes authorization directly, so no polling is needed.
The Google account must have write access to the target calendar. The requested
scope is `calendar.events`. Existing deployments may keep using
`GOOGLE_REFRESH_TOKEN` as an override; otherwise the saved token is reused after
container restarts. To force authorization again, remove the saved token file
from the persistent volume and restart the stack.

For local use without a public reverse proxy, omit `GOOGLE_OAUTH_REDIRECT_URI`;
the default is `http://127.0.0.1:8085/`. Register that exact loopback URI in the
Google Web application client and run the sync on the same machine as the browser.
Google requires HTTPS for non-loopback redirect addresses. A redirect mismatch
usually means the configured URI differs from the URI registered in Google Cloud.

Alternatively use a service account: share the target calendar with its email
and give it permission to make changes to events. Supply credentials with
`GOOGLE_SERVICE_ACCOUNT_JSON` or mount its JSON key and set
`GOOGLE_APPLICATION_CREDENTIALS`. OAuth is preferred for your personal account.

## Environment and commands

Copy `.env.example` to `.env` and fill in the values. Docker Compose uses `.env`
for interpolation and maps configured values into the container; Portainer users
should set the same variables in the stack environment. Running Node directly
requires exporting variables or `node --env-file=.env`. Passwords and Google
credentials are never printed or saved in SQLite. The refresh token is stored
with mode `0600` in the persistent token file.

Required:

- `SCHULMANAGER_USERNAME`, `SCHULMANAGER_PASSWORD`
- `GOOGLE_CALENDAR_ICAL_URL` or `GOOGLE_CALENDAR_ID`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_URI` for remote Docker/Portainer deployments

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
- `GOOGLE_REFRESH_TOKEN`: optional legacy/manual OAuth token; normally obtained
  once through the callback and saved automatically.
- `GOOGLE_OAUTH_PORT=8085`: callback listener port; publish/proxy this port.
- `GOOGLE_TOKEN_PATH=./data/google-refresh-token.json`: saved refresh token path.
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
