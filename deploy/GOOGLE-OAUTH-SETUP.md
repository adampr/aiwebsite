# Google OAuth setup for ai.xl.net (manual, one-time)

Google offers no API/CLI for creating standard OAuth 2.0 web clients, so this
is a Console-only step (~5 minutes). The Microsoft side is already done
(Entra app `e66a2e8f-c1c1-4b63-9ffe-245db7d5363c`, created via `az ad app create`).

Do this while signed in as **adam@xl.net** (the account gcloud on the dev box
uses). Any Google Cloud project works; the existing `xl-website-1682362315172`
project is fine, or create a dedicated one.

## 1. Configure the consent screen (if not already done in this project)

1. Open https://console.cloud.google.com/auth/branding
2. Pick the project (top bar).
3. If prompted to configure: App name **XL.net AI**, support email
   **adam@xl.net** (or ai@xl.net), audience **External**, developer contact
   **adam@xl.net**. Save.
4. No extra scopes needed — the app only uses `openid email profile`
   (non-sensitive, no verification review required).
5. Under **Audience**, click **Publish app** (leaving it in Testing would
   limit sign-in to allow-listed test users).

## 2. Create the OAuth client

1. Open https://console.cloud.google.com/auth/clients
2. **Create client** → Application type **Web application**.
3. Name: `ai.xl.net`
4. Authorized redirect URIs — add both:
   - `https://ai.xl.net/auth/google/callback`
   - `http://localhost:3000/auth/google/callback`
5. Create, then copy the **Client ID** and **Client secret**.

## 3. Wire it into the app

In `/home/linuxuser/aiwebsite/.env` fill in the two empty values:

```
GOOGLE_CLIENT_ID=<client id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<client secret>
```

(`GOOGLE_REDIRECT_URI` is already set to `https://ai.xl.net/auth/google/callback`.)

Then deploy (`bash deploy/deploy.sh`) — the deploy copies `.env` to the VM and
restarts the app. Until these values are set, the "Continue with Google"
button shows a friendly "provider isn't available yet" message; Microsoft
sign-in works regardless.
