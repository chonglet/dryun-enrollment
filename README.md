# dryun-enrollment (Cloudflare Workers version)

The secure backend connecting the private household enrollment page
(`enroll.html`) to SignWell and Stripe — running on Cloudflare Workers'
**free tier**, which (unlike Vercel's free "Hobby" tier) explicitly
allows commercial use, so there's no monthly hosting cost for a
practice this size.

This is functionally identical to the Vercel version — same logic,
same three jobs (create the SignWell agreement, verify signing and
build the Stripe checkout, log webhooks) — just written for
Cloudflare's runtime instead of Vercel's.

## How it works (no database needed)

Same flow as before:

1. Patient fills out `enroll.html`.
2. Browser calls `POST /api/create-enrollment` → server re-validates
   ages/categories, creates the SignWell document, returns a signing URL.
3. Patient signs → SignWell redirects to `/api/pay?token=...` (a
   signed token that IS the enrollment record — nothing is stored in a
   database, and it expires in 24 hours).
4. `/api/pay` verifies the token, builds the Stripe Checkout Session
   with the correct price(s), redirects to Stripe.
5. Patient pays → redirected to `thank-you.html`; Stripe also fires a
   webhook to `/api/webhooks/stripe` for your records.
6. `/api/webhooks/signwell` is a secondary audit log, same as before.

## Before you deploy — same two open questions as the Vercel version

- **Duplicate templates for two same-category members** (e.g. two
  children) — untested against SignWell's actual behavior. Test with
  `SIGNWELL_TEST_MODE=true` before relying on it.
- **`placeholder_name` on each recipient** — needs to match your
  actual template placeholder names (check in the SignWell dashboard).

And confirm your three Stripe Prices are **recurring yearly** prices,
not one-time (see the comment in `src/index.js`'s `handlePay`).

## Deploying (recommended: connect your GitHub repo, like you do for dryun.org)

1. Push this folder to its **own new GitHub repo** — e.g.
   `dryun-enrollment` — separate from the `dryun` Pages repo. (Cloudflare
   needs it in its own repo, the same way you keep the Pages site in its own.)
2. Go to the [Cloudflare dashboard](https://dash.cloudflare.com) →
   **Workers & Pages** → **Create** → under "Ship something new," choose
   **Connect GitHub** / "Import a repository."
3. Authorize Cloudflare to access the new repo, select it, and follow
   the prompts. Cloudflare will detect `wrangler.jsonc` automatically.
4. Before the first deploy finishes, go to the Worker's **Settings →
   Variables and Secrets** and add every value from `.dev.vars.example`
   — mark `SIGNWELL_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
   and `TOKEN_SECRET` as **Secret** (encrypted), the rest as plain
   **Variables**.
5. Deploy. Your Worker will be live at something like
   `https://dryun-enrollment.<your-subdomain>.workers.dev`.
6. In `enroll.html`, set `window.DRYUN_BACKEND_URL` to that URL, then
   upload `enroll.html` to the `dryun` repo as usual.
7. In Stripe's dashboard: **Developers → Webhooks → Add endpoint** →
   `https://<your-worker-url>/api/webhooks/stripe`, listening for
   `checkout.session.completed`. Copy the signing secret into
   `STRIPE_WEBHOOK_SECRET` in step 4.
8. In SignWell's dashboard: **Settings → Webhooks → Add webhook** →
   `https://<your-worker-url>/api/webhooks/signwell`.

From then on, every push to this repo's main branch auto-deploys the
Worker — same experience as pushing to the `dryun` Pages repo.

## Local development (optional, only if you want to test before deploying)

```
npm install
cp .dev.vars.example .dev.vars   # then fill in real test-mode values
npm run dev
```

`wrangler dev` runs the Worker locally and reads `.dev.vars`
automatically. Never commit a real `.dev.vars` file.
