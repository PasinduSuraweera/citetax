# Citetax — setup

Three things to do. Steps 1 and 2 need a browser; step 3 is one command.

---

## 1. Supabase (database) — required

1. Go to **https://supabase.com/dashboard** and sign in (GitHub login is fine).
2. **New project.** Name it `citetax`. Choose a strong database password and
   **save it** — you need it in a moment and Supabase will not show it again.
   Pick the region closest to you (Singapore / Mumbai for Sri Lanka).
   Wait ~2 minutes for it to provision.
3. **Create the schema.** Left sidebar → **SQL Editor** → **New query**.
   Open [db/migrations/001_init.sql](db/migrations/001_init.sql), copy the
   whole file, paste it in, and click **Run**. You should see "Success".
4. **Get the connection string.** Top bar → **Connect** → **Session pooler**
   → copy the URI. It looks like:

   ```
   postgresql://postgres.abcdefgh:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
   ```

5. **Two edits before pasting into `.env`:**
   - change `postgresql://` to **`postgresql+psycopg://`**
   - replace `[YOUR-PASSWORD]` with the password from step 2
     (if it contains `@ : / ? #`, URL-encode it — `@` becomes `%40`)

   Paste the result as `DATABASE_URL=` in [api/.env](api/.env).

---

## 2. Groq (LLM) — required for prose explanations

1. Go to **https://console.groq.com/keys** and sign in.
2. **Create API Key**, copy it (starts with `gsk_`).
3. Paste as `GROQ_API_KEY=` in [api/.env](api/.env).

Free tier is plenty. Without this key the API still returns verified figures
and citations — just no prose. That is the documented degradation in spec §13,
not a failure.

---

## 3. Google AI (embeddings)

**https://aistudio.google.com/apikey** → Create API key → paste as
`GOOGLE_API_KEY=` in [api/.env](api/.env), with `EMBEDDING_BACKEND=vertex`.

Note the model is `gemini-embedding-001` at 768 dimensions. It returns 3072 by
default, which is past pgvector's 2000-dimension ceiling for an HNSW index, so
the code asks for truncation to match the `vector(768)` column.

---

## 4. Google OAuth (sign in)

Sign in is needed for History, and for the admin panel.

1. **https://console.cloud.google.com/apis/credentials** → Create credentials →
   OAuth client ID.
2. Application type: **Web application**.
3. Authorised redirect URI, exactly:
   `http://localhost:3000/api/auth/callback/google`
4. Copy the client ID and secret into **[web/.env.local](web/.env.local)**
   as `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET`.

These belong to the web app, not the API. NextAuth runs in Next.js; the API only
verifies the token it signs.

`AUTH_SECRET` must be identical in `web/.env.local` and `api/.env`. It already is.

### Getting the first admin

`BOOTSTRAP_ADMINS` in [api/.env](api/.env) lists emails promoted to admin on
first sign-in. Without it nobody could reach the admin panel to grant the first
role. Once real reviewers exist, roles are managed from the Users screen.

### Roles

| Role | Can do |
|---|---|
| `individual` | Ask questions, see own history |
| `reviewer` | Review inbox, edit proposals, run impact preview, first signature |
| `approver` | Second signature on value bearing changes, publish snapshots |
| `admin` | Everything, plus roles, sources and rollback |
| `auditor` | Read only |

Dual control means a change to any rate, band, threshold, relief or deadline
needs **two distinct people**. The same account cannot sign twice.

---

---

## Running it

```powershell
# API, port 8000
cd api
.venv\Scripts\python.exe preflight.py           # checks every service
.venv\Scripts\python.exe migrate.py             # applies db/migrations in order
.venv\Scripts\python.exe seed\rules_seed.py     # loads the real tax rules, once
.venv\Scripts\python.exe -m uvicorn app.main:app --reload

# Web, port 3000, in a second terminal
cd web
npm run dev
```

`preflight.py` names exactly what is wrong with each service if anything fails.

The seed is safe to run again. It only loads rules into an empty database and
changes nothing once a corpus exists, so it never touches saved answers,
conversations, or rules published through the admin panel. Publish rule
changes through the admin **Review inbox**, not by editing the seed.

| Where | What |
|---|---|
| http://localhost:3000 | Ask a question |
| http://localhost:3000/admin | Review inbox, needs the reviewer role |
| http://127.0.0.1:8000/docs | API reference |

### Seeing the currency feature work

1. Sign in, then open **Admin → Sources**.
2. Press **Crawl now** on Tax Advisor LK notices. It records what it finds.
3. Press it again: everything reads as unchanged.
4. When a watched document's content changes at the same URL, the next crawl
   records it as revision 2 superseding revision 1, in one family, and puts it
   at the top of the review inbox as priority 1.

---

## What the keys are used for

| Key | Required | Used for | Cost |
|---|---|---|---|
| `DATABASE_URL` | **Yes** | Rules, versions, snapshots, audit. Everything. | Free tier |
| `GROQ_API_KEY` | **Yes** for prose | The Explain node only. Never sees your identity or a payslip. | Free tier |
| `GOOGLE_API_KEY` | No, later | Embedding chunks for explanation retrieval, and reading uploaded payslips. A payslip is sent to Gemini whole, identifiers included, only after the user agrees on the upload screen; it is never stored. | Free tier |

No key is needed for the computation itself. The compute engine is pure Python
with no network access — that is the point of spec §4.3, and it is what lets
Citetax claim every number is cited.

## Adding a year of assessment

A Sri Lankan year of assessment runs 1 April to 31 March. The supported years
live in one place, `supported_yas` in [api/app/core/config.py](api/app/core/config.py).
The router prompt, the clarify question, the golden set, `/v1/years` and every
year picker in the web app read it from there, and "this year" follows
today's date in Colombo time. To add 2027/2028:

1. **Rules first.** Get the 2027/2028 values reviewed and signed in the admin
   (every required rule, plus `deadline.return_filing` for the year), then
   publish. Publishing refuses a snapshot with a gap, so this step cannot be
   half done.
2. **Then the setting.** Set `SUPPORTED_YAS=["2025/2026","2026/2027","2027/2028"]`
   in `api/.env` (or change the default in `config.py`) and restart the API.
   The web app picks the years up from `/v1/years`; nothing is rebuilt.
3. **Check.** Corpus health shows the new column covered, and the impact
   preview runs the golden set for it.
4. **Optional.** Drop the oldest year the same way, by removing it from the
   setting. Past answers keep the snapshot and year they were computed with.

Until step 2, "this year" stays the newest supported year, so on 1 April the
app keeps answering for the last year it has rules for rather than guessing.
