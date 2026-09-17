# Grovia — Technical Specification

**What this is:** A pan-African affiliate marketing platform for digital products (like Selar), where creators sell digital products, affiliates earn commissions promoting them, and both pay a yearly platform subscription. Payments run through Flutterwave. Files are delivered via Google Drive.

This document contains everything needed to build it — architecture, data model, every backend function, every page, and every business rule. No further product decisions should be needed; implementation choices (exact CSS, variable names, code style) are the developer's call.

---

## 1. Branding

- **Name:** Grovia
- **Tagline:** "grow together, earn together"
- **Color palette:**
  - Light green (backgrounds/badges): `#EAF3DE`
  - Mid-light green: `#97C459`
  - Primary accent (buttons/links/active states): `#639922`
  - Dark green (text on light-green surfaces): `#27500A`
- **Logo mark:** simple growth/branch symbol on a solid green circle (works as a favicon)
- **Typography:** Inter (single family, used throughout)
- **UI framework:** Tailwind CSS (via CDN, no build step) + Lucide icons (via CDN)

---

## 2. Architecture

- **Backend:** Google Apps Script, deployed as a Web App (Execute as: Me, Access: Anyone). Code is split across multiple `.gs` files within one Apps Script project (see §3.0) — Apps Script shares a single global namespace across all files in a project, so this split is purely organizational, not a routing mechanism.
- **Database:** a single JSON object ("the blob"), stored in **PropertiesService** (Script Properties), split across multiple property keys to work around the ~9KB-per-value limit (see §4)
- **Frontend:** true multi-page static site — one `.html` file per screen (see §7), hosted on GitHub Pages, sharing common logic via `shared/api.js` and `shared/nav.js`
- **Payments:** Flutterwave (Standard Checkout), verified server-side via Apps Script
- **File storage:** Google Drive, via the Apps Script service account (uploaded files live in the platform's Drive, not each creator's own)
- **Concurrency control:** optimistic versioning — every read includes a `version` number; every write must include the version it read, or is rejected with the current data so the client can retry

---

## 3. Backend — Apps Script functions

### 3.0 File organization

One Apps Script **project**, multiple `.gs` **files** inside it. All files share the same global scope and deploy together as a single Web App — splitting into files is only for readability/maintenance, not routing. Layout:

| File | Contains | Used by (pages) |
|---|---|---|
| `Main.gs` | `doGet`, `doPost` (the single entry point + action dispatcher) | every page, indirectly |
| `Storage.gs` | `readDb_`, `writeDb_`, chunking helpers, the `write` action handler | every page (via `shared/api.js`) |
| `Auth.gs` | `login`, `requestPasswordReset`, `resetPassword` | `login.html`, `signup.html`, `forgot-password.html`, `reset-password.html` |
| `Upload.gs` | `startUpload`, `uploadChunk`, `finalizeUpload`, `uploadImage` | `creator-product-edit.html` |
| `Payments.gs` | `verifyPayment`, Flutterwave API call helper | `order-status.html`, subscription checkout on `creator-dashboard.html` / `affiliate-dashboard.html` |
| `Downloads.gs` | `getDownloadLink` | `order-status.html` |
| `Admin.gs` | `checkPermission_` helper and any admin-only server-side checks | all `admin-*.html` pages |

`doGet` and the `write` action inside `doPost` are the only ones touching the full blob; everything else is a narrow, single-purpose function so that sensitive data (password hashes, file IDs) never has to enter the publicly-readable blob.

### 3.1 `doGet(e)`
Returns the current blob, **with these fields stripped out of every user record**: `passwordHash`, `salt`. Also strips `fileId` out of every product record. Everything else (products, stores, orders, referral codes, wallet balances) is public.

Response: the full db object as JSON, including `version`.

### 3.2 `doPost(e)` — dispatches by `e.parameter.action` (or a field in the JSON body called `action`)

Supported actions: `write`, `login`, `requestPasswordReset`, `resetPassword`, `startUpload`, `uploadChunk`, `finalizeUpload`, `uploadImage`, `getDownloadLink`, `verifyPayment`.

> **CORS note:** Apps Script doesn't handle CORS preflight (`OPTIONS`) requests. All POSTs from the frontend must be sent with `Content-Type: text/plain;charset=utf-8` (even though the body is JSON) to avoid triggering a preflight. `e.postData.contents` parses fine regardless of the declared content type.

---

#### `write` — the versioned blob write
**Input:** `{ action: "write", version: <number>, data: <full db object, minus stripped private fields> }`

**Behavior:**
1. Acquire `LockService.getScriptLock()`.
2. Read current db.
3. If `incoming.version !== current.version` → return `{ error: "version_conflict", current: <full current db> }`.
4. Otherwise merge `incoming.data` into the stored db (see note below), bump version, write, release lock.
5. Return `{ success: true, version, data }`.

**Important:** because `doGet` and `write` never see `passwordHash`/`salt`/`fileId`, the backend must **preserve those fields internally** when merging an incoming `write` — the frontend never sends them, so a naive overwrite would delete them. Merge per-record: for any user object in `incoming.data.users`, look up the existing stored user by `id` and re-attach `passwordHash`, `salt` (unchanged) before saving. Same pattern for `fileId` on products.

---

#### `login`
**Input:** `{ action: "login", email, password }`
**Behavior:** find user by email, hash the given password with that user's stored salt, compare to stored hash. On match, return the user object (minus `passwordHash`/`salt`). On failure, return `{ error: "invalid_credentials" }`.

---

#### `requestPasswordReset`
**Input:** `{ action: "requestPasswordReset", email }`
**Behavior:** find user; generate a random token; store `{ token, userId, expiresAt: now+1hr, used: false }` in a `passwordResets` array in the blob; send an email via `MailApp.sendEmail()` containing a link like `https://yoursite.com/reset-password.html?token=...`. Always return `{ success: true }` regardless of whether the email existed (don't leak which emails are registered).

---

#### `resetPassword`
**Input:** `{ action: "resetPassword", token, newPassword }`
**Behavior:** find the reset record by token; reject if missing, expired, or already used; hash the new password with a fresh salt; update the user's `passwordHash`/`salt`; mark the reset record `used: true`. Return `{ success: true }` or `{ error: "invalid_or_expired_token" }`.

---

#### `startUpload` / `uploadChunk` / `finalizeUpload` — chunked file upload for product deliverables
Frontend splits any file into ~5MB base64 chunks before sending (no hard size ceiling on the overall file).

- **`startUpload`**: `{ action: "startUpload", filename, mimeType, totalChunks }` → creates a temp folder in the platform's Drive, returns `{ uploadId }`.
- **`uploadChunk`**: `{ action: "uploadChunk", uploadId, chunkIndex, base64Piece }` → saves the piece as a small temp file inside that upload's folder. Called once per chunk.
- **`finalizeUpload`**: `{ action: "finalizeUpload", uploadId }` → reads all temp chunk files back in order, concatenates them, saves as the final file (private — no public sharing), deletes the temp chunk files and folder, returns `{ fileId }`. The frontend attaches this `fileId` to the product in the next `write` call.

---

#### `uploadImage` — single-shot upload for product photos
**Input:** `{ action: "uploadImage", base64, filename, mimeType }`
**Behavior:** decode and save directly to Drive (no chunking — images are small), set that file's sharing to "anyone with the link can view," return `{ url: <direct viewable URL> }`. This URL is safe to store in the product's public fields since the image is meant to be public.
**Limit:** max 3 images per product (enforced on the frontend; the array is capped at length 3 before the `write` call).

---

#### `getDownloadLink` — gated deliverable access
**Input:** `{ action: "getDownloadLink", orderId, buyerEmail }`
**Behavior:** look up the order by `orderId`. If `order.status !== "paid"` or `order.buyerEmail !== buyerEmail` → return `{ error: "not_authorized" }`. Otherwise, look up the product's private `fileId`, generate/resolve the file's URL via `DriveApp.getFileById(fileId).getUrl()`, return `{ url }`.

---

#### `verifyPayment` — Flutterwave confirmation
**Input:** `{ action: "verifyPayment", txRef, targetType: "order"|"subscription", targetId }`
**Behavior:**
1. Call Flutterwave's transaction verify endpoint (`GET https://api.flutterwave.com/v3/transactions/{id}/verify` or by `tx_ref`) using the secret key stored in **Script Properties** (never in client code).
2. Confirm `status === "successful"` and the verified amount/currency matches what was expected for that order/subscription.
3. **If `targetType === "order"`:**
   - Set `order.status = "paid"`, `order.paidAt = now`, `order.flutterwaveTxRef = txRef`.
   - Compute the split (see §5.2) and credit `creatorWallet` / `affiliateWallet` accordingly.
   - Apply the self-referral rule (§5.3) before crediting any affiliate commission.
4. **If `targetType === "subscription"`:**
   - Set `subscription.status = "paid"`, `paidAt = now`, `expiresAt = now + 1 year`.
   - Set the corresponding `user.creatorSub` or `user.affiliateSub` to `{ active: true, expiresAt, graceUntil: expiresAt + platformSettings.graceDays }`.
5. Write the updated db (internally — this function does its own locked read-modify-write, not through the client-facing `write` action, since it must be atomic with the verification step).
6. Return `{ success: true }` or `{ error: "verification_failed" }`.

---

## 4. Storage mechanics (PropertiesService chunking)

- `CHUNK_SIZE = 8000` characters (safely under the ~9KB/value limit).
- Blob is JSON-stringified, split into chunks, stored under keys `jty_chunk_0`, `jty_chunk_1`, etc.
- A `jty_meta` property stores `{ version, chunkCount, updatedAt }`.
- Total Script Properties storage caps at ~500KB — comfortably several thousand user records. If the platform outgrows this, migrate to a Drive-file-backed blob (same read/write interface, different storage backend).

---

## 5. Data model

All of this lives inside the one JSON blob (except where noted as "private" — those fields are stripped from `doGet` per §3.1, but still stored in the same underlying blob for simplicity).

```
db = {
  version: number,

  users: [{
    id, name, email,
    salt, passwordHash,              // PRIVATE — stripped from doGet
    referralCode, referredBy,
    creatorSub:   { active, expiresAt, graceUntil },
    affiliateSub: { active, expiresAt, graceUntil },
    creatorWallet: number,           // balance available to withdraw
    affiliateWallet: number,
    roleId: string | null,           // for admins — references roles[]
    createdAt
  }],

  stores: [{ id, ownerId, name, description, createdAt }],

  products: [{
    id, storeId, name, price, commissionRate, description,
    images: [url1, url2, url3],      // public, max 3
    fileId,                          // PRIVATE — stripped from doGet
    createdAt, updatedAt
  }],

  orders: [{
    id, productId,
    buyerName, buyerEmail,
    basePrice,                       // snapshotted at creation — price edits don't affect pending orders
    affiliateRef,                    // referralCode of the credited affiliate, or null
    platformCut, affiliateCommission, creatorEarning,  // computed at verifyPayment time
    status: "pending" | "paid",
    flutterwaveTxRef,
    createdAt, paidAt
  }],

  subscriptions: [{
    id, userId, role: "creator" | "affiliate",
    amount, status: "pending" | "paid",
    flutterwaveTxRef,
    createdAt, paidAt, expiresAt
  }],

  withdrawals: [{
    id, userId, walletType: "creator" | "affiliate",
    amount, status: "requested" | "approved" | "paid" | "rejected",
    createdAt, resolvedAt
  }],

  roles: [{
    id, name, permissions: [ ... ],  // e.g. manage_withdrawals, manage_users, manage_products,
                                      // manage_roles, manage_disputes, view_analytics, override_subscriptions
    createdBy, createdAt
    // "Super Admin" is a hardcoded, protected role — always exists, always has every
    // permission, cannot be edited or deleted through the UI.
  }],

  passwordResets: [{                 // PRIVATE — stripped from doGet
    id, userId, token, expiresAt, used
  }],

  platformSettings: {
    platformCutPercent,              // e.g. 5
    creatorYearlyFee, affiliateYearlyFee,
    commissionRateMin, commissionRateMax,
    withdrawalMinimum,
    graceDays,                       // default 3
    publicCatalogEnabled: boolean    // Super Admin toggle
  }
}
```

---

## 5.2 Order money split (computed in `verifyPayment`)

```
platformCut        = order.basePrice * (platformSettings.platformCutPercent / 100)
affiliateCommission = validReferral ? order.basePrice * (product.commissionRate / 100) : 0
creatorEarning      = order.basePrice - platformCut - affiliateCommission
```
`creatorWallet` of the product's store owner += `creatorEarning`.
`affiliateWallet` of the referring affiliate (if any) += `affiliateCommission`.

## 5.3 Self-referral rule
Before crediting a commission, check: if `order.buyerEmail === referringAffiliate.email`, treat the referral as invalid — set `affiliateRef = null`, `affiliateCommission = 0`, and let the full non-platform amount go to `creatorEarning`. The purchase itself still completes normally.

## 5.4 Subscription gating
- Creating a store or a product requires `user.creatorSub.active === true` OR `now < user.creatorSub.graceUntil`.
- Generating/using an affiliate link requires the same check on `affiliateSub`.
- Once `now > graceUntil`, the frontend disables the relevant actions (store/product creation, or affiliate link generation) until the user renews. No data is deleted.

## 5.5 Product price edits
Editing `product.price` only affects *future* orders. Existing orders already have their own `basePrice` snapshotted at creation — never re-read from the live product.

---

## 6. Payment flow (Flutterwave)

**Subscription:**
1. User selects "become a creator" or "become an affiliate" → frontend creates a `subscriptions` record (`status: "pending"`) via `write`.
2. Redirect to Flutterwave checkout for `platformSettings.creatorYearlyFee` or `affiliateYearlyFee`.
3. On return, frontend calls `verifyPayment` with the `txRef` and `targetType: "subscription"`.
4. Backend verifies, activates the subscription.

**Product purchase:**
1. Buyer lands on a product buy page (optionally via `?ref=<affiliateCode>`), fills name/email, clicks buy.
2. Frontend creates an `orders` record (`status: "pending"`, `affiliateRef` set from the URL param if present) via `write`.
3. Redirect to Flutterwave checkout for `product.price`.
4. On return, frontend calls `verifyPayment` with `txRef` and `targetType: "order"`.
5. Backend verifies, applies the money split (§5.2–5.3), credits wallets.
6. Buyer is shown a "payment confirmed" state with a download button, which calls `getDownloadLink`.

**Withdrawals:**
1. Creator/affiliate requests a withdrawal from a specific wallet (must be ≥ `platformSettings.withdrawalMinimum`) → `withdrawals` record created (`status: "requested"`) via `write`.
2. An admin with `manage_withdrawals` permission approves/rejects. On approval, admin pays out manually (bank transfer or Flutterwave Transfer, outside this system) and marks it `paid`.
3. On `paid`, the corresponding wallet balance is decremented by the withdrawal amount.

---

## 7. Frontend — pages

Every page is a standalone `.html` file that includes `shared/api.js` (backend calls, session handling, `pushDb`-with-retry logic) and `shared/nav.js` (renders header/nav based on login state + role).

**Public / auth (6):** `index.html` (landing), `login.html`, `signup.html`, `forgot-password.html`, `reset-password.html`, `catalog.html` (public discovery — hidden if `platformSettings.publicCatalogEnabled === false`).

**Buyer flow (3):** `store.html` (per creator, `?id=`), `product.html` (buy page, `?id=&ref=`), `order-status.html` (also serves as the Flutterwave return URL — reads `?orderId=&txRef=` from the query string, calls `verifyPayment`, then shows status + download button).

**Creator dashboard (5):** `creator-dashboard.html`, `creator-store-settings.html`, `creator-products.html`, `creator-product-edit.html` (add/edit, includes chunked upload + image upload UI), `creator-wallet.html`.

**Affiliate dashboard (3):** `affiliate-dashboard.html`, `affiliate-browse.html` (reuses catalog data, adds a "get link" button per product), `affiliate-wallet.html`.

**Shared (1):** `account-settings.html`.

**Admin panel (7):** `admin-dashboard.html`, `admin-users.html`, `admin-products.html`, `admin-orders.html`, `admin-withdrawals.html`, `admin-roles.html`, `admin-settings.html`.

**Shared frontend files (not pages):** `shared/api.js`, `shared/nav.js`.

---

## 8. Security notes

- Password hashes and file IDs never leave the backend except through `login`'s success response (hash itself never returned) and `getDownloadLink`'s gated check.
- Passwords are hashed client-side before being sent (SHA-256 + salt) *and* re-verified server-side in `login` — belt and suspenders, not a substitute for HTTPS (which GitHub Pages + Apps Script both provide by default).
- The Flutterwave **secret key** lives only in Apps Script's Script Properties, never in any frontend file.
- `Super Admin` role is hardcoded and un-deletable so the platform can never end up with zero working admins.
