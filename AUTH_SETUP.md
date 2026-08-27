# VIGO authentication setup

This patch adds login + admin user management. Existing calculator/HUD/settings files are not replaced.

## Vercel Environment Variables

Add these variables to **Production** (Preview/Development are optional):

- `UPSTASH_REDIS_REST_URL` — REST URL from your free Upstash Redis database.
- `UPSTASH_REDIS_REST_TOKEN` — REST token from Upstash. Keep it secret.
- `AUTH_SECRET` — random secret, at least 32 characters. Keep it secret.
- `ADMIN_LOGIN` — administrator login, for example `admin`.
- `ADMIN_PASSWORD` — administrator password, at least 8 characters. Keep it secret.

Do **not** add these secrets to GitHub or frontend source files.

## First login

After saving the variables, redeploy the project. Open the production URL and sign in with `ADMIN_LOGIN` and `ADMIN_PASSWORD`.

The administrator sees a shield button in the header. It opens the admin panel, where ordinary users can be created and deleted.

## Important

The administrator account is defined by Vercel Environment Variables, not Redis. Ordinary users are stored in Redis with scrypt password hashes. Deleting an ordinary user immediately invalidates that user's next authenticated request/session check.
