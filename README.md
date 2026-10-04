# Schulmanager Calendar Sync

Unofficial one-way sync from Schulmanager to Google Calendar. The Docker image
is intended to run continuously from Portainer.

The sync manages:

- Exams, with class-hour number in the title, lesson start/end times in Google
    Calendar, and source creation/update timestamps in the description.
- One-time and daily/weekly recurring entries from the Schulmanager calendar.
- The selected student's sick notes and non-internal exemption requests; changed
    exemption approval status updates the existing calendar entry.
- Optional exam popup reminders (`SYNC_REMIND_DAYS`) and Telegram notifications
    when entries are added, changed, or removed.

Calendar, sick-note, and exemption events do not receive exam reminders. See
[SYNC.md](SYNC.md) for configuration options and troubleshooting.

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

The image is `ghcr.io/g3gg0/schmgrcalsync:latest`. OAuth runs locally during
setup; the sync container needs no public callback, reverse proxy, or inbound
port. See [doc/Install.md](doc/Install.md) for illustrated Google Cloud setup.

## Use and Responsibility

This project uses private, undocumented Schulmanager API endpoints. They may
change or be restricted, and automated access may be subject to Schulmanager,
school, Google, or other applicable terms and policies. Before using it, you
must verify that you are authorized to access and synchronize this data and
comply with all applicable rules. Use is at your own risk. The authors provide
the software as-is, without warranty, and accept no responsibility for account
restrictions, data loss, or other consequences, to the extent permitted by law.

## Configuration

The sync runs every four hours by default and covers exams up to 26 weeks ahead.
You can change the schedule, date range, timezone, optional exam reminders, and
student selection in the Portainer stack environment. Optional Telegram change
notifications are also available. See [SYNC.md](SYNC.md) for the full list of
settings and troubleshooting guidance.

Keep Schulmanager credentials, Google OAuth values, private calendar links, and
any service-account keys confidential. Do not commit or share them.
