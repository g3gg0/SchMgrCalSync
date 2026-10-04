# Schulmanager Calendar Sync

Unofficial one-way sync from Schulmanager to Google Calendar. The Docker image
is intended to run continuously from Portainer; the command-line tools below are
optional utilities for setup and troubleshooting.

The sync manages:

- Exams, with class-hour number in the title, lesson start/end times in Google
    Calendar, and source creation/update timestamps in the description.
- One-time and daily/weekly recurring entries from the Schulmanager calendar.
- The selected student's sick notes and non-internal exemption requests; changed
    exemption approval status updates the existing calendar entry.
- Optional exam popup reminders (`SYNC_REMIND_DAYS`) and Telegram notifications
    when entries are added, changed, or removed.

Calendar, sick-note, and exemption events do not receive reminders. See
[SYNC.md](SYNC.md) for Portainer setup, local OAuth authorization, configuration,
recurrence limits, and troubleshooting.

## Quick Start

1. Create a Google Cloud project, enable the Google Calendar API, configure the
    consent screen, and create an OAuth client of type **Web application** with
    the localhost redirect URI described in [the setup guide](doc/Install.md).
2. On your private computer, clone this repository, install Node.js 24+, run
   `npm ci`, then run `npm run google-oauth`. Enter the OAuth client ID and
   secret when prompted, approve the link in a browser on that computer, and
   copy the resulting refresh token.
3. Deploy `compose.yaml` as a Portainer stack. Set the Schulmanager credentials,
   Google calendar ID (or private iCal URL), OAuth client ID/secret, and the
   generated `GOOGLE_REFRESH_TOKEN` in the stack environment.

The GHCR image is `ghcr.io/g3gg0/schmgrcalsync:latest`. OAuth runs locally
during setup; the sync container needs no public callback, reverse proxy, or
inbound port. See [doc/Install.md](doc/Install.md) for illustrated Google Cloud
setup steps.

## Use and Responsibility

This project uses private, undocumented Schulmanager API endpoints. They may
change or be restricted, and automated access may be subject to Schulmanager,
school, Google, or other applicable terms and policies. Before using it, you
must verify that you are authorized to access and synchronize this data and
comply with all applicable rules. Use is at your own risk. The authors provide
the software as-is, without warranty, and accept no responsibility for account
restrictions, data loss, or other consequences, to the extent permitted by law.

## Additional CLI Tools

The original information-fetching CLI requires Node.js 22+. Calendar sync and
the Google authorization helper require Node.js 24+ and `npm ci`.

Commands:

    node cli.js login
    node cli.js students
    node cli.js fetch
    node cli.js fetch --student 2 --days 30
    node cli.js fetch --student-id 2407028 --json
    node cli.js logout

Login prompts for username and hidden password. Alternatively supply --username
and --password, or SCHULMANAGER_USERNAME and SCHULMANAGER_PASSWORD. Prompts or
environment avoid putting passwords in command history.

Login lists students and caches the session. Fetch defaults to the first student.
--student N selects a one-based list number; --student-id ID selects an ID.
Current class IDs come from login; --class-id overrides them. Parent accounts
use user.associatedParents[].student; direct student accounts use
user.associatedStudent. Unknown selections fail. students --json prints records.

.session.json beside the CLI stores JWT, username, institution selection, and
user/student metadata, never passwords. Tokens are sensitive. Cache and HAR files
are excluded by .gitignore. POSIX creation uses mode 0600; Windows uses directory
ACLs. --cache-file PATH supports separate accounts; --no-cache disables caching.
logout deletes the selected cache. Without a username, the cached account is
reused. A different explicit username/institution prevents reuse. Expired or
malformed JWTs cause login. Server-side HTTP/batch 401/403 causes one login/retry.
Renewal uses flags/environment or interactive prompts; unattended renewal needs
credentials in the environment. login always logs in afresh.
SCHULMANAGER_TOKEN overrides cache tokens; missing student metadata still needs
login for discovery.

The HAR confirms plain-password /api/login with emailOrUsername, password,
hash: null, mobileApp: false, institutionId: null. The browser calls get-salt
first but submits no hash; the CLI directly submits that captured login body.
--institution-id supplies an optional school ID. Automatic school-selection
and MFA flows are not implemented.

Bundle version defaults to the HAR value a2bbc79000; --bundle-version overrides
it. The HAR confirms exams; homework remains based on firmware since the captures contain no homework call;
exam-blocking events are confirmed in the latest capture. This private API may change.

Default exam/event range: today in Europe/Berlin through 14 days ahead.
Use --days or --start YYYY-MM-DD --end YYYY-MM-DD. Homework preserves all API
records sorted by date; that date is not confirmed to be a due date. JSON
preserves all fields. Attachments are not downloaded. Events are exam-blocking
entries, not the full calendar. Partial failures stay visible and yield exit 1.
Requests time out after 20 seconds.

npm test runs mocked login, student selection, cache expiry/account isolation,
calendar overlap, renewal, and partial-failure checks. Live authenticated fetching
has not been verified; HAR credentials were not used for live requests.

## Modules and response tests

    node cli.js modules
    node cli.js modules --json
    node cli.js test-modules
    node cli.js test-modules --module classbook
    node cli.js test-modules --json
    node cli.js fetch-module --module letters
    node cli.js fetch-module --module calendar --endpoint get-events-for-user
    node cli.js fetch-module --module learning --endpoint get-course-units --course-id COURSE_ID

modules lists all 17 captured active module names, including modules with no
captured read endpoint. Its JSON output lists exact endpoint IDs. test-modules
probes each captured read endpoint and reports status and response shape/count;
--json includes full data. fetch-module prints full JSON for the selected module.
--module all fetches every captured read endpoint. Failed endpoints do not stop
other probes, and produce exit code 1. Object, scalar and null responses are
preserved, rather than requiring every endpoint to return an array. A successful
status reports transport/API success, not a guarantee about the data's meaning.
These commands fetch information; no write actions are replayed.

Student and range flags also apply to module requests. Current term IDs are
resolved from get-current-term. Course-unit fetching resolves learning courses
and uses the first unless --course-id is supplied. It does not fetch every
course automatically. Some APIs return account-wide data (letters, messages,
sick notes); selecting a student does not add unsupported filters to them.
Recurring calendar events are returned in their original API structure.

The latest HAR contains get-topics, not get-homework. The school settings in
the earlier HAR disable homeworkIsVisibleForStudents. Default fetch now checks
live settings and, when disabled, reports homework unavailable and fetches lesson
topics instead. Topics are not presented as homework. When homework visibility
is enabled, the firmware endpoint is attempted with a minimal student ID.
Duplicate exams are preserved: separate server records can share date/subject.

To refresh the request catalog after more browser captures:

    node import-har.js capture1.har capture2.har

The importer stores sanitized request templates and module labels in modules.json,
not headers, tokens, passwords or response bodies. Only captured get/count
endpoints and POQA findAll/findOne/getClass actions are admitted. Requests for
support tokens, authentication settings and websocket access are excluded.
Modules with no captured request are reported as UNSUPPORTED; capture their
pages to add verified read endpoints. Some board/conference data is already
available through main account widget endpoints rather than module endpoints.

`npm test` runs the automated test suite. It uses mocked API responses and does
not validate current live Schulmanager responses; the private API may change.

## GitHub Container Registry

The GitHub Actions workflow runs the tests on pushes and pull requests. It builds
and publishes a multi-platform image (`linux/amd64` and `linux/arm64`) to GHCR
when code is pushed to the repository's default branch. Pushing a version tag
such as `v1.2.3` also publishes versioned tags. The default-branch image is
tagged `latest`.

After the first publish, the image is available at
`ghcr.io/OWNER/REPOSITORY:latest`. Set `SCHULMANAGER_IMAGE` in `.env` to that
image, then run `docker compose pull` and `docker compose up -d`. The repository
package may be private by default; make it public in GitHub Packages settings,
or authenticate Docker with a GitHub token that has `read:packages` permission.

For local development, leave `SCHULMANAGER_IMAGE` unset. Compose builds the
local Dockerfile as `schulmanager-sync:local`. Never commit `.env`, session
files, HAR captures, or service-account credentials.
