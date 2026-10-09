# Deploying Citetax

The API runs on **Google Cloud Run** and the web app on **Vercel**, both in Mumbai (`asia-south1` and `bom1`), next to the Supabase database in `ap-south-1`. Keeping all three in one region is what keeps answers fast.

```
Browser ──> Vercel (web, bom1) ──> Cloud Run (API, asia-south1) ──> Supabase (ap-south-1)
                                          ^
                    Cloud Scheduler ──────┘  every 30 minutes: one corpus agent cycle
```

## 1. API on Cloud Run

Install the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install), then sign in and choose the project. The project needs billing enabled.

```powershell
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com
```

Store the secrets once. Each command reads the value you paste, so nothing lands in your shell history.

```powershell
foreach ($name in "DATABASE_URL", "GROQ_API_KEY", "GOOGLE_API_KEY", "AUTH_SECRET", "CRON_TOKEN") {
  $value = Read-Host "Value for $name"
  $value | gcloud secrets create $name --data-file=- --replication-policy=automatic
}
```

- `DATABASE_URL`, `GROQ_API_KEY`, `GOOGLE_API_KEY` and `AUTH_SECRET`: the same values as in `api/.env`. `AUTH_SECRET` must match the web app's.
- `CRON_TOKEN`: a new long random string, for example from `[guid]::NewGuid().ToString() + [guid]::NewGuid().ToString()`.

Let Cloud Run read them:

```powershell
$sa = "$(gcloud projects describe YOUR_PROJECT_ID --format='value(projectNumber)')-compute@developer.gserviceaccount.com"
foreach ($name in "DATABASE_URL", "GROQ_API_KEY", "GOOGLE_API_KEY", "AUTH_SECRET", "CRON_TOKEN") {
  gcloud secrets add-iam-policy-binding $name --member="serviceAccount:$sa" --role="roles/secretmanager.secretAccessor"
}
```

Deploy from source. Cloud Build builds `api/Dockerfile`, so Docker is not needed locally.

```powershell
gcloud run deploy citetax-api --source api --region asia-south1 --allow-unauthenticated `
  --memory 1Gi --cpu 1 --min-instances 1 --max-instances 4 --timeout 900 `
  --set-secrets "DATABASE_URL=DATABASE_URL:latest,GROQ_API_KEY=GROQ_API_KEY:latest,GOOGLE_API_KEY=GOOGLE_API_KEY:latest,AUTH_SECRET=AUTH_SECRET:latest,CRON_TOKEN=CRON_TOKEN:latest" `
  --set-env-vars "WATCH_INTERVAL_MINUTES=0,BOOTSTRAP_ADMINS=you@example.com,CORS_ORIGINS=https://YOUR-APP.vercel.app"
```

- `--min-instances 1` keeps one instance warm, so the first question of the day has no cold start. With request-based billing, an idle instance costs only a few dollars a month.
- `WATCH_INTERVAL_MINUTES=0` turns off the in-process timer, because Cloud Run gives no CPU between requests. Cloud Scheduler runs the agent instead (below).
- The command prints the service URL, for example `https://citetax-api-xxxxx.a.run.app`. Check it with `/health`.

Run the corpus agent every 30 minutes:

```powershell
$token = gcloud secrets versions access latest --secret CRON_TOKEN
gcloud scheduler jobs create http citetax-agent --location asia-south1 --schedule "*/30 * * * *" `
  --uri "https://citetax-api-xxxxx.a.run.app/internal/agent/run" --http-method POST `
  --headers "X-Cron-Token=$token" --attempt-deadline 900s
```

## 2. Web app on Vercel

1. In Vercel, choose **Add New, Project**, and import `PasinduSuraweera/citetax` from GitHub.
2. Set **Root Directory** to `web`. The framework is detected as Next.js. `web/vercel.json` pins the functions to Mumbai (`bom1`).
3. Add the environment variables:

| Name | Value |
|---|---|
| `NEXT_PUBLIC_API_BASE` | The Cloud Run URL from step 1 |
| `AUTH_SECRET` | The same value as the API's |
| `AUTH_GOOGLE_ID` | From `web/.env.local` |
| `AUTH_GOOGLE_SECRET` | From `web/.env.local` |
| `AUTH_URL` | `https://YOUR-APP.vercel.app` |

4. Deploy. Every push to `main` then redeploys automatically.

## 3. Connect the two

- **CORS:** if the Vercel address differs from what you used in step 1, update it on the API:
  `gcloud run services update citetax-api --region asia-south1 --update-env-vars "CORS_ORIGINS=https://YOUR-APP.vercel.app"`
- **Google sign-in:** in the Google Cloud console, under **APIs and Services, Credentials**, open the OAuth client and add the authorised redirect URI `https://YOUR-APP.vercel.app/api/auth/callback/google`.
- **Migrations:** the database is the existing Supabase one, so no migration is needed. For a new database, run `python migrate.py` and `python seed/rules_seed.py` from `api/` against it first.

## Updating

- **Web:** push to `main`, and Vercel deploys.
- **API:** run the same `gcloud run deploy` command again. Secrets and settings are kept.

## Free setup: the API on your laptop through ngrok

This costs nothing, but the site works only while the laptop is on, awake and running both commands below.

```
Browser ──> Vercel (web) ──> ngrok ──> your laptop (API, port 8000) ──> Supabase
```

1. Install ngrok and sign in once. The authtoken is on the ngrok dashboard under **Your Authtoken**.
   ```powershell
   winget install ngrok.ngrok
   ngrok config add-authtoken YOUR_TOKEN
   ```
2. On the ngrok dashboard, under **Domains**, claim the free static domain, for example `citetax-xyz.ngrok-free.app`. It must be static, because Vercel bakes `NEXT_PUBLIC_API_BASE` into the build.
3. In `api/.env`, add the Vercel address to the allowed origins:
   `CORS_ORIGINS=http://localhost:3000,https://YOUR-APP.vercel.app`
4. Start the API, without `--reload`. The corpus agent runs on its own timer here, so no scheduler is needed.
   ```powershell
   cd api
   .venv\Scripts\python -m uvicorn app.main:app --port 8000
   ```
5. In a second terminal, open the tunnel:
   ```powershell
   ngrok http --domain=citetax-xyz.ngrok-free.app 8000
   ```
6. Set up Vercel as in section 2, with `NEXT_PUBLIC_API_BASE=https://citetax-xyz.ngrok-free.app`, and add the Google redirect URI as in section 3.

The web app sends an `ngrok-skip-browser-warning` header with every API call, so ngrok's warning page never gets in the way. The free ngrok plan has monthly request and data limits, which is plenty for testing but not for real traffic.
