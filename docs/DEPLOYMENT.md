# Deployment

The project runs fully on your own machine with Docker Compose (see README). This
page covers putting it online for a demo or review. I did not deploy it myself
(that needs your accounts), so there is no public URL yet.

## Free hosting options checked in October 2026

| Provider | What the free tier gives you | Catch for this project |
|---|---|---|
| **Render** (web service + static site) | 750 free instance hours per workspace per month; free web services have 512 MB RAM and 0.1 CPU | Spins down after 15 minutes idle and takes about a minute to wake. Free Postgres expires 30 days after creation (14-day grace, then deleted), 1 GB, and only one per workspace |
| **Neon** (Postgres) | 100 projects, 100 CU-hours and 0.5 GB storage per project per month | Compute suspends after 5 minutes idle (first query after that is slower). Plenty for two small databases |
| **Railway** | Trial: one-time $5 credit that expires in 30 days; Free plan: $1 of credit per month | Not enough to keep an API + two databases running. Hobby is $5/month |

Prices and limits change. Check the provider pages before you sign up:
render.com/docs/free, neon.com/docs/introduction/plans, docs.railway.com/pricing/plans.

## Recommended free setup: Neon + Render

ReconcileOps needs **two** PostgreSQL databases (metadata and demo). Render's free
tier allows only one free database and deletes it after 30 days, so use Neon for both:

1. **Neon**: create two projects, `reconcileops-meta` and `reconcileops-demo`. Copy
   both connection strings (they end in `?sslmode=require`).
2. **Apply the metadata schema** from your machine:
   ```bash
   docker run --rm -v "$PWD/backend/db/migrations:/flyway/sql:ro" flyway/flyway:10-alpine \
     -url="jdbc:postgresql://<meta-host>/<db>?sslmode=require" -user=<user> -password=<password> migrate
   ```
   Or, without Docker: `cd backend && META_DATABASE_URL=<meta url> npm run migrate`.
3. **Render, backend**: New Web Service, connect your GitHub repo, root directory
   `backend`, runtime Docker. Environment variables:
   * `META_DATABASE_URL`, `DEMO_DATABASE_URL`: the Neon URLs
   * `CORS_ORIGIN`: the frontend URL from step 4, e.g. `https://reconcileops-web.onrender.com`
   * `API_TOKEN`: a long random string. **Set this for any public deployment**, otherwise anyone can run migrations on your demo database.
   * `NODE_ENV=production`
4. **Render, frontend**: New Static Site, root directory `frontend`, build command
   `npm ci && npm run build`, publish directory `dist`. Environment variable
   `VITE_API_URL=https://<your-backend>.onrender.com/api`. Add a rewrite rule
   `/*` → `/index.html` so page refreshes work.
5. Open the site, go to **Settings → This browser**, paste the API token, then use
   **Demo scenarios → Reset demo data**.

Expect the first request after 15 idle minutes to take around a minute while the
backend wakes up, plus a short delay while Neon resumes.

## Any Docker host (VPS)

```bash
git clone <your repo> && cd reconcileops
cp .env.example .env    # set strong passwords and API_TOKEN
docker compose up -d --build
```

Put a reverse proxy with HTTPS (Caddy, nginx + certbot) in front of port 8080, and
don't publish port 4000 publicly. Remove the `ports` entry from the `backend`
service in that case.
