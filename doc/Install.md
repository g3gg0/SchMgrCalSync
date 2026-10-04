# Google Calendar Authorization

The sync container does not host an OAuth callback. Generate a refresh token
once on your private computer, then add it to the Portainer stack environment.

## 1. Create or Select a Google Cloud Project

Open the [Google Cloud Console](https://console.cloud.google.com/) and select
the project that will own the OAuth client.

## 2. Enable Google Calendar API

Open **APIs & Services**. If the API is not enabled yet, choose **Enable APIs and
Services**, search for **Google Calendar API**, open it, and enable it.

![APIs and Services overview](04%20-%20add%20API.png)

![Google Calendar API in the API library](05%20-%20add%20calendar%20API.png)

## 3. Configure the OAuth Consent Screen

Open **Google Auth Platform** and configure the app's branding and audience.
For an external app in **Testing**, add the Google account that will authorize
the calendar as a test user. Testing-mode refresh tokens may expire after seven
days; review Google's publishing requirements before unattended long-term use.

![OAuth audience and test users](06%20-%20add%20your%20user%20as%20test%20user.png)

## 4. Create the OAuth Client

Under **APIs & Services → Credentials**, create an **OAuth client ID**. Choose
**Web application** and register this exact authorized redirect URI:

```text
http://127.0.0.1:8085/
```

The callback listens only on localhost on the computer running the helper. If
you set `GOOGLE_OAUTH_PORT` to another port, register
`http://127.0.0.1:<port>/` instead. Do not use a public server or configure
Portainer as the callback host.

![Credentials page](01%20-%20add%20oauth.png)

![Create an OAuth client ID](02%20-%20add%20oauth%20client%20id.png)

![OAuth web client settings and localhost redirect URI](03%20-%20client%20config.png)

## 5. Generate the Refresh Token Locally

On your private computer, clone this repository and run these commands from its
root directory:

```bash
npm ci
npm run google-oauth
```

The helper prompts for the OAuth client ID and client secret; secret input is
hidden. It prints an authorization link. Open it in a browser on the same
computer, sign in with the authorized Google account, and grant access. The
helper receives the redirect through `127.0.0.1` and prints
`GOOGLE_REFRESH_TOKEN=...` in the terminal.

Keep the client secret and refresh token private. Never commit them or include
them in screenshots, issue reports, or public logs.

## 6. Configure Portainer

Enter these values in the Portainer stack environment and redeploy:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`

The redirect URI in Google Cloud must exactly match the helper's localhost URI.
The running container does not need port `8085`, a public domain, HTTPS, or a
reverse proxy. If Google authorization is missing, the container stays idle and
prints the local command to run.

