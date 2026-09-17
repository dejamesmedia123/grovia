# Grovia

A pan-African affiliate/creator earning platform. Creators sell digital
products, affiliates earn commissions promoting them, everyone pays a
yearly platform subscription, and both plus a referral program can
withdraw their wallet balance via Flutterwave — to Nigeria and Ghana bank
accounts (name-verified), or to 10 more countries via mobile money
(unverified, self-typed account name).

> For the original product spec this was built from, see `BLUEPRINT.md`.
> This README documents what's actually implemented and how to run it —
> the two have drifted (the blueprint predates the multi-country payout
> system, for example).

---

## 1. What's in this repo

| File | What it is |
|---|---|
| `Code.gs` | The entire backend — one Apps Script file, deployed as a Web App. Single JSON-blob database in Script Properties. |
| `index.html` | The user-facing app: landing, auth, creator/affiliate/referral dashboards, product catalog/buy flow, wallets & withdrawals. |
| `admin.html` | The admin panel: dashboard, users, products, orders, withdrawals, payout countries, roles, settings. |
| `landing.html` | Public marketing/landing page. |
| `BLUEPRINT.md` | Original technical spec (partly superseded — see note above). |
| `sitemap.xml`, `robots.txt`, `favicon.*`, `og-image.*`, `apple-touch-icon.png` | Static/SEO assets. |

There's no build step. Every `.html` file is self-contained (inline CSS/JS)
and can be hosted anywhere static files are served (GitHub Pages, etc.).
`Code.gs` is the only piece that runs on Google's servers.

---

## 2. Architecture

- **Backend:** Google Apps Script, deployed as a Web App (`Execute as: Me`,
  `Access: Anyone`). `doGet` returns the database; `doPost` dispatches by
  an `action` field in the JSON body.
- **Database:** a single JSON blob in `PropertiesService`, chunked across
  multiple property keys to work around the ~9KB-per-value limit.
  Concurrency is handled with optimistic versioning: every write must
  include the `version` it read, or gets rejected with the current data
  so the client can merge and retry (`GroviaAPI.pushDb` does this
  automatically, up to 3 retries).
- **Frontend:** two main pages (`index.html` for users, `admin.html` for
  admins) with client-side hash routing — each "page" is really a JS
  function that renders into `#app`. No framework, no build tool.
- **Payments:** Flutterwave Standard Checkout for subscriptions/orders,
  verified server-side (`verifyPayment`) so the secret key never reaches
  the browser.
- **Payouts:** Flutterwave's Transfers API, automatic — admin approves,
  the platform sends the transfer itself, and a webhook confirms success
  or failure. See §5.
- **File storage:** Google Drive, via the Apps Script project's own
  account (uploaded product files aren't in each creator's personal
  Drive).

---

## 3. One-time setup

### 3.1 Script Properties (Apps Script → Project Settings → Script Properties)

| Property | Required? | What it's for |
|---|---|---|
| `FLW_SECRET_KEY` | Yes | Flutterwave secret key. Used for subscription/order verification *and* for every payout call (`getBanks`, `resolveAccount`, `initiateTransfer`). Use a `FLWSECK_TEST-...` key while testing, swap to the live key before real payouts. |
| `FLW_WEBHOOK_SECRET` | Recommended | Apps Script web apps can't read custom request headers, so Flutterwave's normal signature-header check isn't usable here. Instead, set this to a random string, then set your Flutterwave transfer webhook URL to `<your deployment URL>?whsec=<same string>`. Without this, anyone who finds your deployment URL could POST fake `transfer.completed` events. |
| `SITE_BASE_URL` | Yes | e.g. `https://yourname.github.io/grovia/`. Used for links in emails (password reset, etc.). |

### 3.2 Deploy the backend

1. Open the Apps Script project, **Deploy → New deployment → Web app**.
2. Execute as **Me**, Access **Anyone**.
3. Copy the resulting `/exec` URL.
4. In both `index.html` and `admin.html`, replace the placeholder
   `const API_URL = 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec';`
   with that URL.

### 3.3 Host the frontend

Any static host works. If using GitHub Pages, just push `index.html`,
`admin.html`, `landing.html`, and the static assets to the repo Pages is
serving.

### 3.4 First login

The very first read of an empty database seeds a `Super Admin` role and
your platform settings automatically (`defaultDb_()` in `Code.gs`) — sign
up a user, then manually set that user's `roleId` to `'super-admin'`
directly in Script Properties (or via the Apps Script editor) to get your
first admin in. From there, use `admin.html → Roles` to create/assign
roles normally.

---

## 4. Core features

- **Creator subscriptions** — yearly fee, grace period, gates store/product
  creation.
- **Affiliate subscriptions** — yearly fee, gates affiliate link generation.
- **Product purchases** — Flutterwave checkout, server-verified, splits
  the price into platform cut / affiliate commission / creator earning
  (self-referral is detected and zeroed out — see `BLUEPRINT.md §5.3` for
  the original rule, still in effect).
- **Referral program** — referral codes, a referral wallet, first-deposit
  bonus + recurring commission on referred users' subscription payments.
- **Admin panel** — users, products, orders, roles/permissions,
  platform settings, and the withdrawal/payout system below.

---

## 5. Multi-country withdrawal system

All wallets (creator, affiliate, referral) are NGN-denominated. A user can
withdraw to any country admin has switched on.

### 5.1 How a country goes live

`admin.html → Countries` lists all 30 of Flutterwave's African countries,
seeded by `countrySeed_()` in `Code.gs`. For each:

- **Payout methods** — bank, mobile money, both, or neither (18 of the 30
  currently have no working Flutterwave payout rail — they're listed for
  future rollout, not usable yet).
- **Verification** — only Nigeria, Ghana (bank), and Ghana (mobile money)
  support Flutterwave's account-name resolve check. Everywhere else, the
  withdrawal form collects a self-typed account holder name instead, and
  flags the request as unverified for admin.
- **FX rate & fee %** — admin sets both per country. A country can't be
  activated with `fxRate: 0` — the UI blocks it, since that would mean
  paying someone nothing.
- **Active** — the on/off switch. Turn countries on one at a time rather
  than all at once, so a bad rate or a broken corridor only affects the
  one country while you catch it.

### 5.2 The withdrawal form (`index.html`)

If a user has no country on file yet, they're prompted to pick one
(inactive countries show as disabled "coming soon" options). Once set,
the form adapts to that country's config:

- Bank countries get a bank dropdown (fetched live via `getBanks`) and an
  account number field.
- Mobile-money countries get a provider dropdown (`MOBILE_MONEY_NETWORKS`
  in `index.html` — a best-effort map of network codes; double-check
  against Flutterwave's current docs before relying on it for a country
  you haven't tested) and a phone number field.
- Verified countries resolve the account name live (`resolveAccount`) and
  gate submit on a successful match. Unverified countries show a plain
  name field with a visible warning instead.
- A live conversion preview shows the NGN amount converted at that
  country's rate, minus its fee, before the user submits.

### 5.3 Admin review & payout (`admin.html → Withdrawals`)

- Unverified requests are flagged with a badge so admin gives them extra
  scrutiny.
- **Approve & send** calls `initiateTransfer`, which checks the wallet
  balance, calls Flutterwave's Transfers API, and — only once Flutterwave
  accepts the request — deducts the wallet balance and marks the request
  `processing`.
- A **webhook** (`transfer.completed`, handled by
  `handleFlutterwaveWebhook_` in `Code.gs`) flips `processing` to `paid`
  on success, or to `failed` (and restores the held balance) on failure.
- Withdrawal requests created before this system existed (no `country` /
  `payoutType`) fall back to the old manual Approve → Mark paid flow,
  since there's nothing to hand Flutterwave for those.

### 5.4 Testing before going live

1. Deploy with a Flutterwave **test** secret key and set up the webhook
   (§3.1).
2. Activate Nigeria with `fxRate: 1`, `fee: 0` — this exercises the
   bank-verification path.
3. Run a full withdrawal end to end: request → Approve & send →
   `processing` → `paid` via webhook.
4. Activate one mobile-money country (Kenya is simplest — one network)
   and repeat, checking the unverified-name flow.
5. Force a failure (bad test account, or reject it in Flutterwave's test
   dashboard) and confirm the wallet balance is restored and the request
   shows `failed` with a reason.
6. Switch to the live secret key, then activate remaining countries one
   at a time from the Countries page.

---

## 6. Known gaps / things to double-check before relying on them

- `MOBILE_MONEY_NETWORKS` (in `index.html`) is a best-effort list of
  provider codes, not pulled from a live Flutterwave endpoint — verify it
  against current docs for any country before activating it.
- The 18 "not yet supported" countries in `countrySeed_()` reflect
  Flutterwave's payout coverage as researched during this build — that
  coverage does change over time, so it's worth re-checking before
  assuming a country is permanently unsupported.
- There's no automated test suite. The checklist in §5.4 is manual.
