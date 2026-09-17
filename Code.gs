/**
 * ============================================================================
 * GROVIA — Code.gs
 * ----------------------------------------------------------------------------
 * Single Google Apps Script backend file. Deploy as a Web App
 * (Execute as: Me, Access: Anyone) and paste the resulting URL into
 * GroviaAPI.API_URL in index.html / admin.html.
 *
 * ONE-TIME SETUP (Project Settings → Script Properties):
 *   FLW_SECRET_KEY    — your Flutterwave secret key (required for payments
 *                        and payouts)
 *   FLW_WEBHOOK_SECRET — optional. If set, the Flutterwave transfer webhook
 *                        URL must be configured (in the Flutterwave
 *                        dashboard) as this deployment's URL with
 *                        ?whsec=<same value> appended — e.g.
 *                        https://script.google.com/macros/s/XXX/exec?whsec=abc123
 *                        Apps Script web apps can't read custom request
 *                        headers, so this query-param check stands in for
 *                        Flutterwave's normal verif-hash header check. Skip
 *                        it only for local testing — never in production.
 *   SITE_BASE_URL     — e.g. "https://yourname.github.io/grovia/" (used to
 *                        build the password-reset email link). Optional —
 *                        falls back to "https://grovia.app/".
 *
 * Entry points: doGet (read the public db) and doPost (everything else,
 * dispatched by an `action` field in the JSON body).
 * ============================================================================
 */

/* ================================================================ CONFIG == */

var CHUNK_SIZE = 8000;
var DB_CHUNK_PREFIX = 'grovia_chunk_';
var DB_META_KEY = 'grovia_meta';
var UPLOAD_ROOT_FOLDER_NAME = 'Grovia Uploads (temp)';
var PRODUCTS_FOLDER_NAME = 'Grovia Product Files (private)';
var IMAGES_FOLDER_NAME = 'Grovia Product Images (public)';
var LOCK_TIMEOUT_MS = 30000;

/* ===================================================== PAYOUT COUNTRY SEED ==
 * All 30 African countries in Flutterwave's footprint. `payoutMethods` is the
 * source of truth for what actually works today:
 *   - non-empty  => Flutterwave transfers (payouts) work for this country now.
 *   - []         => country exists for future rollout, but Flutterwave has no
 *                   working payout rail for it yet (payoutStatus explains why).
 * `verified` means Flutterwave's POST /v3/accounts/resolve can confirm the
 * account holder's name before a withdrawal is submitted (bank-name check).
 * It is true ONLY for Nigeria and Ghana bank accounts, and Ghana mobile
 * money — everywhere else, a submitted name is self-reported and admin
 * should treat those withdrawal requests as unverified (see WITHDRAWAL
 * REVIEW in a later step).
 * fxRate / feePercent are seeded at 0 and are meant to be set by admin
 * before a country is switched `active: true` — a 0 rate should never be
 * allowed to reach a live transfer.
 * ============================================================================ */
function countrySeed_() {
  function c(country, currency, payoutMethods, verified, payoutStatus) {
    return {
      country: country,
      currency: currency,
      payoutMethods: payoutMethods,       // subset of ['bank', 'mobile_money']
      verified: verified,                 // true only where resolveAccount works
      payoutStatus: payoutStatus || (payoutMethods.length ? 'supported' : 'not_yet_supported_by_flutterwave'),
      fxRate: 0,
      feePercent: 0,
      active: false,                      // admin turns countries on one at a time
    };
  }
  return [
    // -- Payout-capable today (12) --------------------------------------
    c('Nigeria', 'NGN', ['bank'], true),
    c('Ghana', 'GHS', ['bank', 'mobile_money'], true),
    c('Kenya', 'KES', ['mobile_money'], false),
    c('Uganda', 'UGX', ['mobile_money'], false),
    c('Tanzania', 'TZS', ['mobile_money'], false),
    c('Rwanda', 'RWF', ['mobile_money'], false),
    c('Zambia', 'ZMW', ['mobile_money'], false),
    c('Malawi', 'MWK', ['bank', 'mobile_money'], false),
    c('Ethiopia', 'ETB', ['bank', 'mobile_money'], false),
    c('Cameroon', 'XAF', ['mobile_money'], false),
    c("Cote d'Ivoire", 'XOF', ['mobile_money'], false),
    c('Senegal', 'XOF', ['mobile_money'], false),
    // -- Listed for future rollout, no working payout rail yet (18) -----
    c('South Africa', 'ZAR', []),
    c('Egypt', 'EGP', []),
    c('Sierra Leone', 'SLL', []),
    c('Mali', 'XOF', []),
    c('Burkina Faso', 'XOF', []),
    c('Benin', 'XOF', []),
    c('Togo', 'XOF', []),
    c('Niger', 'XOF', []),
    c('Guinea', 'GNF', []),
    c('Guinea-Bissau', 'XOF', []),
    c('Chad', 'XAF', []),
    c('Central African Republic', 'XAF', []),
    c('Republic of Congo', 'XAF', []),
    c('Gabon', 'XAF', []),
    c('Equatorial Guinea', 'XAF', []),
    c('Democratic Republic of Congo', 'CDF', []),
    c('Mozambique', 'MZN', []),
    c('Zimbabwe', 'ZWL', []),
  ];
}

/* ============================================================= ENTRY POINTS */

function doGet(e) {
  try {
    var db = readDb_();
    return jsonResponse_(stripPrivate_(db));
  } catch (err) {
    return jsonResponse_({ error: 'server_error', message: String(err) });
  }
}

function doPost(e) {
  var input;
  try {
    input = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse_({ error: 'invalid_request' });
  }

  // Flutterwave transfer webhooks look like { event: 'transfer.completed', data: {...} }
  // and never carry our own `action` field — route them separately.
  if (input && input.event && !input.action) {
    return jsonResponse_(handleFlutterwaveWebhook_(input, e));
  }

  try {
    switch (input.action) {
      case 'write':
        return jsonResponse_(handleWrite_(input));
      case 'login':
        return jsonResponse_(handleLogin_(input));
      case 'requestPasswordReset':
        return jsonResponse_(handleRequestPasswordReset_(input));
      case 'resetPassword':
        return jsonResponse_(handleResetPassword_(input));
      case 'startUpload':
        return jsonResponse_(handleStartUpload_(input));
      case 'uploadChunk':
        return jsonResponse_(handleUploadChunk_(input));
      case 'finalizeUpload':
        return jsonResponse_(handleFinalizeUpload_(input));
      case 'uploadImage':
        return jsonResponse_(handleUploadImage_(input));
      case 'getDownloadLink':
        return jsonResponse_(handleGetDownloadLink_(input));
      case 'verifyPayment':
        return jsonResponse_(handleVerifyPayment_(input));
      case 'getBanks':
        return jsonResponse_(handleGetBanks_(input));
      case 'resolveAccount':
        return jsonResponse_(handleResolveAccount_(input));
      case 'getPayoutConfig':
        return jsonResponse_(handleGetPayoutConfig_(input));
      case 'initiateTransfer':
        return jsonResponse_(handleInitiateTransfer_(input));
      default:
        return jsonResponse_({ error: 'unknown_action' });
    }
  } catch (err) {
    return jsonResponse_({ error: 'server_error', message: String(err) });
  }
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ============================================================= STORAGE ==== */
/* PropertiesService-backed JSON blob, chunked to stay under the ~9KB/value
 * limit, versioned for optimistic-concurrency writes. */

function defaultDb_() {
  var now = new Date().toISOString();
  return {
    version: 1,
    users: [],
    stores: [],
    products: [],
    orders: [],
    subscriptions: [],
    withdrawals: [],
    roles: [superAdminRole_(now)],
    passwordResets: [],
    referralEarnings: [],
    supportedCountries: countrySeed_(),
    platformSettings: {
      platformCutPercent: 5,
      creatorYearlyFee: 15000,
      affiliateYearlyFee: 5000,
      commissionRateMin: 5,
      commissionRateMax: 50,
      withdrawalMinimum: 5000,
      graceDays: 3,
      publicCatalogEnabled: true,
      referralSignupBonus: 1000,
      referralRenewalPercent: 10,
      referralProgramEnabled: true,
    },
  };
}

function superAdminRole_(now) {
  return {
    id: 'super-admin',
    name: 'Super Admin',
    permissions: [
      'manage_withdrawals', 'manage_countries', 'manage_users', 'manage_products',
      'manage_roles', 'manage_disputes', 'view_analytics', 'override_subscriptions',
    ],
    createdBy: 'system',
    createdAt: now,
  };
}

function readDb_() {
  var props = PropertiesService.getScriptProperties();
  var metaRaw = props.getProperty(DB_META_KEY);
  if (!metaRaw) {
    var fresh = defaultDb_();
    writeDb_(fresh);
    return fresh;
  }
  var meta = JSON.parse(metaRaw);
  var json = '';
  for (var i = 0; i < meta.chunkCount; i++) {
    json += props.getProperty(DB_CHUNK_PREFIX + i) || '';
  }
  var db = JSON.parse(json);

  if (applySchemaMigrations_(db)) {
    writeDb_(db); // does not bump db.version — this is a backfill, not a data change clients need to react to
  }
  return db;
}

/* Backfills fields added after a deployment already had live data, since
 * defaultDb_() only ever runs once (on the very first read). Each check is
 * additive and idempotent — safe to run on every readDb_() call. Returns
 * true if anything changed (so the caller knows to persist it). */
function applySchemaMigrations_(db) {
  var changed = false;

  if (!db.supportedCountries) {
    db.supportedCountries = countrySeed_();
    changed = true;
  }

  (db.users || []).forEach(function (u) {
    if (!Object.prototype.hasOwnProperty.call(u, 'country')) {
      u.country = null; // flagged for the "which country are you in?" prompt at next withdrawal
      changed = true;
    }
  });

  return changed;
}

function writeDb_(db) {
  var props = PropertiesService.getScriptProperties();
  var json = JSON.stringify(db);
  var chunkCount = Math.max(1, Math.ceil(json.length / CHUNK_SIZE));

  var prevMetaRaw = props.getProperty(DB_META_KEY);
  var prevChunkCount = prevMetaRaw ? JSON.parse(prevMetaRaw).chunkCount : 0;

  var batch = {};
  for (var i = 0; i < chunkCount; i++) {
    batch[DB_CHUNK_PREFIX + i] = json.substr(i * CHUNK_SIZE, CHUNK_SIZE);
  }
  props.setProperties(batch, false);

  for (var j = chunkCount; j < prevChunkCount; j++) {
    props.deleteProperty(DB_CHUNK_PREFIX + j);
  }

  props.setProperty(DB_META_KEY, JSON.stringify({
    version: db.version,
    chunkCount: chunkCount,
    updatedAt: new Date().toISOString(),
  }));
}

function stripPrivateUser_(user) {
  var copy = shallowCopy_(user);
  delete copy.salt;
  delete copy.passwordHash;
  return copy;
}

function stripPrivateProduct_(product) {
  var copy = shallowCopy_(product);
  delete copy.fileId;
  return copy;
}

function stripPrivate_(db) {
  var copy = shallowCopy_(db);
  copy.users = (db.users || []).map(stripPrivateUser_);
  copy.products = (db.products || []).map(stripPrivateProduct_);
  delete copy.passwordResets;
  return copy;
}

function shallowCopy_(obj) {
  var copy = {};
  for (var key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) copy[key] = obj[key];
  }
  return copy;
}

function findById_(list, id) {
  for (var i = 0; i < (list || []).length; i++) {
    if (list[i].id === id) return list[i];
  }
  return null;
}

/* ================================================================ WRITE === */

function handleWrite_(input) {
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    var current = readDb_();
    if (input.version !== current.version) {
      return { error: 'version_conflict', current: stripPrivate_(current) };
    }

    var merged = input.data;

    // Re-attach private fields the client never sees. A record with no
    // existing match is brand-new (e.g. a just-signed-up user, who supplies
    // their own salt/passwordHash), so it's kept as sent.
    merged.users = (merged.users || []).map(function (u) {
      var existing = findById_(current.users, u.id);
      if (existing) {
        var withPrivate = shallowCopy_(u);
        withPrivate.salt = existing.salt;
        withPrivate.passwordHash = existing.passwordHash;
        return withPrivate;
      }
      return u;
    });

    merged.products = (merged.products || []).map(function (p) {
      var existing = findById_(current.products, p.id);
      if (existing) {
        var withPrivate = shallowCopy_(p);
        withPrivate.fileId = existing.fileId;
        return withPrivate;
      }
      return p;
    });

    // Never sent by the client — always carried forward from the server's copy.
    merged.passwordResets = current.passwordResets || [];

    merged.version = current.version + 1;

    writeDb_(merged);
    return { success: true, version: merged.version, data: stripPrivate_(merged) };
  } finally {
    lock.releaseLock();
  }
}

/* ================================================================= AUTH === */

function sha256Hex_(str) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var v = bytes[i];
    if (v < 0) v += 256;
    var h = v.toString(16);
    hex += h.length === 1 ? '0' + h : h;
  }
  return hex;
}

function handleLogin_(input) {
  var db = readDb_();
  var email = String(input.email || '').toLowerCase();
  var user = null;
  for (var i = 0; i < db.users.length; i++) {
    if (db.users[i].email.toLowerCase() === email) { user = db.users[i]; break; }
  }
  if (!user) return { error: 'invalid_credentials' };

  var expected = sha256Hex_(String(input.password || '') + user.salt);
  if (expected !== user.passwordHash) return { error: 'invalid_credentials' };

  return stripPrivateUser_(user);
}

function handleRequestPasswordReset_(input) {
  var email = String(input.email || '').trim();
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    var db = readDb_();
    var user = null;
    for (var i = 0; i < db.users.length; i++) {
      if (db.users[i].email.toLowerCase() === email.toLowerCase()) { user = db.users[i]; break; }
    }

    if (user) {
      var token = Utilities.getUuid();
      db.passwordResets = db.passwordResets || [];
      db.passwordResets.push({
        id: Utilities.getUuid(),
        userId: user.id,
        token: token,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        used: false,
      });
      db.version += 1;
      writeDb_(db);

      var link = getSiteBaseUrl_() + '#/reset-password?token=' + encodeURIComponent(token);
      MailApp.sendEmail({
        to: user.email,
        subject: 'Reset your Grovia password',
        htmlBody:
          'Hi ' + escapeHtmlForEmail_(user.name) + ',<br><br>' +
          'Someone requested a password reset for your Grovia account. If this was you, click below:<br><br>' +
          '<a href="' + link + '">Reset your password</a><br><br>' +
          'This link expires in 1 hour. If you didn\u2019t request this, you can safely ignore this email.<br><br>' +
          '— Grovia',
      });
    }
    // Fall through silently if no user matched — never reveal which emails exist.
  } finally {
    lock.releaseLock();
  }
  return { success: true };
}

function handleResetPassword_(input) {
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    var db = readDb_();
    var reset = null;
    for (var i = 0; i < (db.passwordResets || []).length; i++) {
      if (db.passwordResets[i].token === input.token) { reset = db.passwordResets[i]; break; }
    }
    if (!reset || reset.used || new Date(reset.expiresAt).getTime() < Date.now()) {
      return { error: 'invalid_or_expired_token' };
    }

    var user = findById_(db.users, reset.userId);
    if (!user) return { error: 'invalid_or_expired_token' };

    var salt = Utilities.getUuid();
    user.salt = salt;
    user.passwordHash = sha256Hex_(String(input.newPassword || '') + salt);
    reset.used = true;

    db.version += 1;
    writeDb_(db);
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

function getSiteBaseUrl_() {
  return PropertiesService.getScriptProperties().getProperty('SITE_BASE_URL') || 'https://grovia.app/';
}

function escapeHtmlForEmail_(str) {
  var map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(str || '').replace(/[&<>"']/g, function (c) { return map[c]; });
}

/* =============================================================== UPLOADS == */

function getOrCreateFolder_(name) {
  var it = DriveApp.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(name);
}

function findUploadFolder_(uploadId) {
  var root = getOrCreateFolder_(UPLOAD_ROOT_FOLDER_NAME);
  var it = root.getFoldersByName(uploadId);
  if (!it.hasNext()) throw new Error('upload_not_found');
  return it.next();
}

function pad_(n, width) {
  var s = String(n);
  while (s.length < width) s = '0' + s;
  return s;
}

function handleStartUpload_(input) {
  var root = getOrCreateFolder_(UPLOAD_ROOT_FOLDER_NAME);
  var uploadId = Utilities.getUuid();
  var folder = root.createFolder(uploadId);
  folder.setDescription(JSON.stringify({
    filename: input.filename,
    mimeType: input.mimeType,
    totalChunks: input.totalChunks,
  }));
  return { uploadId: uploadId };
}

function handleUploadChunk_(input) {
  var folder = findUploadFolder_(input.uploadId);
  var bytes = Utilities.base64Decode(input.base64Piece);
  var blob = Utilities.newBlob(bytes, 'application/octet-stream', 'chunk_' + pad_(input.chunkIndex, 6));
  folder.createFile(blob);
  return { success: true };
}

function joinBytes_(byteArrays) {
  var total = 0;
  for (var i = 0; i < byteArrays.length; i++) total += byteArrays[i].length;
  var out = new Array(total);
  var offset = 0;
  for (var j = 0; j < byteArrays.length; j++) {
    var arr = byteArrays[j];
    for (var k = 0; k < arr.length; k++) out[offset + k] = arr[k];
    offset += arr.length;
  }
  return out;
}

function handleFinalizeUpload_(input) {
  var folder = findUploadFolder_(input.uploadId);
  var meta = JSON.parse(folder.getDescription() || '{}');

  var files = [];
  var it = folder.getFiles();
  while (it.hasNext()) files.push(it.next());
  files.sort(function (a, b) { return a.getName() < b.getName() ? -1 : (a.getName() > b.getName() ? 1 : 0); });

  var byteArrays = files.map(function (f) { return f.getBlob().getBytes(); });
  var combined = Utilities.newBlob(
    joinBytes_(byteArrays),
    meta.mimeType || 'application/octet-stream',
    meta.filename || 'file'
  );

  var productsFolder = getOrCreateFolder_(PRODUCTS_FOLDER_NAME);
  var finalFile = productsFolder.createFile(combined);
  // Left private (no setSharing call) — only accessible via DriveApp.getFileById
  // from within this script, i.e. only through the gated getDownloadLink action.

  files.forEach(function (f) { f.setTrashed(true); });
  folder.setTrashed(true);

  return { fileId: finalFile.getId() };
}

function handleUploadImage_(input) {
  var bytes = Utilities.base64Decode(input.base64);
  var blob = Utilities.newBlob(bytes, input.mimeType || 'image/jpeg', input.filename || 'image');
  var folder = getOrCreateFolder_(IMAGES_FOLDER_NAME);
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { url: 'https://drive.google.com/uc?export=view&id=' + file.getId() };
}

/* =========================================================== DOWNLOADS ==== */

function handleGetDownloadLink_(input) {
  var db = readDb_();
  var order = findById_(db.orders, input.orderId);
  if (!order || order.status !== 'paid' || order.buyerEmail !== input.buyerEmail) {
    return { error: 'not_authorized' };
  }
  var product = findById_(db.products, order.productId);
  if (!product || !product.fileId) return { error: 'not_authorized' };

  var url = DriveApp.getFileById(product.fileId).getUrl();
  return { url: url };
}

/* ============================================================= PAYMENTS == */

function round2_(n) {
  return Math.round(n * 100) / 100;
}

function verifyWithFlutterwave_(txRef) {
  var secretKey = PropertiesService.getScriptProperties().getProperty('FLW_SECRET_KEY');
  if (!secretKey) return null;

  var url = 'https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=' + encodeURIComponent(txRef);
  var response;
  try {
    response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + secretKey },
      muteHttpExceptions: true,
    });
  } catch (err) {
    return null;
  }

  var result;
  try {
    result = JSON.parse(response.getContentText());
  } catch (err) {
    return null;
  }

  if (!result || result.status !== 'success' || !result.data || result.data.status !== 'successful') {
    return null;
  }
  return result.data; // { amount, currency, ... }
}

function handleVerifyPayment_(input) {
  var flwData = verifyWithFlutterwave_(input.txRef);
  if (!flwData) return { error: 'verification_failed' };

  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    var db = readDb_();

    if (input.targetType === 'order') {
      return finalizeOrderPayment_(db, input, flwData);
    }
    if (input.targetType === 'subscription') {
      return finalizeSubscriptionPayment_(db, input, flwData);
    }
    return { error: 'verification_failed' };
  } finally {
    lock.releaseLock();
  }
}

function finalizeOrderPayment_(db, input, flwData) {
  var order = findById_(db.orders, input.targetId);
  if (!order) return { error: 'verification_failed' };
  // Currency is hardcoded to NGN for v1 — see the same assumption in the
  // frontend's FlutterwaveCheckout call. Revisit for multi-currency pricing.
  if (Number(flwData.amount) < Number(order.basePrice) || flwData.currency !== 'NGN') {
    return { error: 'verification_failed' };
  }

  var product = findById_(db.products, order.productId);
  var platformCutPercent = db.platformSettings.platformCutPercent;
  var platformCut = round2_(order.basePrice * (platformCutPercent / 100));

  var affiliateRef = order.affiliateRef;
  var affiliate = null;
  if (affiliateRef) {
    for (var i = 0; i < db.users.length; i++) {
      if (db.users[i].referralCode === affiliateRef) { affiliate = db.users[i]; break; }
    }
  }

  // Self-referral rule: buying through your own affiliate link doesn't pay a commission.
  if (affiliate && affiliate.email === order.buyerEmail) {
    affiliate = null;
    affiliateRef = null;
  }

  var affiliateCommission = (affiliate && product) ? round2_(order.basePrice * (product.commissionRate / 100)) : 0;
  var creatorEarning = round2_(order.basePrice - platformCut - affiliateCommission);

  order.status = 'paid';
  order.paidAt = new Date().toISOString();
  order.flutterwaveTxRef = input.txRef;
  order.affiliateRef = affiliateRef;
  order.platformCut = platformCut;
  order.affiliateCommission = affiliateCommission;
  order.creatorEarning = creatorEarning;

  if (product) {
    var store = findById_(db.stores, product.storeId);
    var creator = store ? findById_(db.users, store.ownerId) : null;
    if (creator) creator.creatorWallet = round2_((creator.creatorWallet || 0) + creatorEarning);
  }
  if (affiliate) {
    affiliate.affiliateWallet = round2_((affiliate.affiliateWallet || 0) + affiliateCommission);
  }

  db.version += 1;
  writeDb_(db);
  return { success: true };
}

function finalizeSubscriptionPayment_(db, input, flwData) {
  var sub = findById_(db.subscriptions, input.targetId);
  if (!sub) return { error: 'verification_failed' };
  if (Number(flwData.amount) < Number(sub.amount) || flwData.currency !== 'NGN') {
    return { error: 'verification_failed' };
  }

  var now = new Date();
  var expiresAt = new Date(now.getTime());
  expiresAt.setFullYear(expiresAt.getFullYear() + 1);
  var graceDays = db.platformSettings.graceDays || 3;
  var graceUntil = new Date(expiresAt.getTime() + graceDays * 24 * 60 * 60 * 1000);

  sub.status = 'paid';
  sub.paidAt = now.toISOString();
  sub.flutterwaveTxRef = input.txRef;
  sub.expiresAt = expiresAt.toISOString();

  var user = findById_(db.users, sub.userId);
  if (user) {
    var field = sub.role === 'creator' ? 'creatorSub' : 'affiliateSub';
    user[field] = {
      active: true,
      expiresAt: expiresAt.toISOString(),
      graceUntil: graceUntil.toISOString(),
    };
  }

  if (user) {
    creditReferralIfEligible_(db, user, sub);
  }

  db.version += 1;
  writeDb_(db);
  return { success: true };
}

/* ============================================================ REFERRALS == */
/* Separate from the affiliate-commission system above: this rewards users
 * for referring *new people* to the platform (via referralCode /
 * referredBy), triggered on every subscription payment (creator or
 * affiliate), not on product sales. */

function isSubActive_(sub) {
  if (!sub) return false;
  if (sub.active) return true;
  if (sub.graceUntil && Date.now() < new Date(sub.graceUntil).getTime()) return true;
  return false;
}

function creditReferralIfEligible_(db, payer, sub) {
  var settings = db.platformSettings || {};
  if (!settings.referralProgramEnabled) return;
  if (!payer.referredBy) return;

  var referrer = null;
  for (var i = 0; i < db.users.length; i++) {
    if (db.users[i].referralCode === payer.referredBy) { referrer = db.users[i]; break; }
  }
  if (!referrer) return;

  // Self-referral guard — mirrors the rule in finalizeOrderPayment_.
  if (referrer.email === payer.email) return;

  // Eligibility is checked at payout time, not link-creation time: the
  // referrer must currently hold an active creator OR affiliate
  // subscription, or this cycle's reward is simply forfeited (not queued).
  if (!isSubActive_(referrer.creatorSub) && !isSubActive_(referrer.affiliateSub)) return;

  // "First payment for this role" = no other PAID subscription with the
  // same userId + role already exists (excluding the one just paid).
  var hasPriorPaid = db.subscriptions.some(function (s) {
    return s.id !== sub.id && s.userId === payer.id && s.role === sub.role && s.status === 'paid';
  });

  var type, amount;
  if (!hasPriorPaid) {
    type = 'signup';
    amount = round2_(Number(settings.referralSignupBonus) || 0);
  } else {
    type = 'renewal';
    amount = round2_(sub.amount * ((Number(settings.referralRenewalPercent) || 0) / 100));
  }

  referrer.referralWallet = round2_((referrer.referralWallet || 0) + amount);

  db.referralEarnings = db.referralEarnings || [];
  db.referralEarnings.push({
    id: Utilities.getUuid(),
    referrerId: referrer.id,
    referredUserId: payer.id,
    role: sub.role,
    type: type,
    amount: amount,
    subscriptionId: sub.id,
    createdAt: new Date().toISOString(),
  });
}

/* =============================================================== PAYOUTS ==
 * Multi-country withdrawal support, built on top of the `supportedCountries`
 * config seeded in countrySeed_() (see the CONFIG block up top). Four
 * client-facing actions (getBanks, resolveAccount, getPayoutConfig,
 * initiateTransfer) plus a Flutterwave webhook handler for transfer status.
 * None of this is wired into index.html / admin.html yet — that's the next
 * two steps. */

function findCountryConfig_(db, countryName) {
  return (db.supportedCountries || []).filter(function (c) { return c.country === countryName; })[0] || null;
}

// Flutterwave's bank-list and account-resolve endpoints are keyed by ISO
// 3166-1 alpha-2 code, not full country name — only needed for the
// `verified: true` countries (currently NG, GH), but kept complete so it
// doesn't need revisiting as more countries go live.
function isoCountryCode_(countryName) {
  var map = {
    'Nigeria': 'NG', 'Ghana': 'GH', 'Kenya': 'KE', 'Uganda': 'UG', 'Tanzania': 'TZ',
    'Rwanda': 'RW', 'Zambia': 'ZM', 'Malawi': 'MW', 'Ethiopia': 'ET', 'Cameroon': 'CM',
    "Cote d'Ivoire": 'CI', 'Senegal': 'SN', 'South Africa': 'ZA', 'Egypt': 'EG',
    'Sierra Leone': 'SL', 'Mali': 'ML', 'Burkina Faso': 'BF', 'Benin': 'BJ', 'Togo': 'TG',
    'Niger': 'NE', 'Guinea': 'GN', 'Guinea-Bissau': 'GW', 'Chad': 'TD',
    'Central African Republic': 'CF', 'Republic of Congo': 'CG', 'Gabon': 'GA',
    'Equatorial Guinea': 'GQ', 'Democratic Republic of Congo': 'CD', 'Mozambique': 'MZ',
    'Zimbabwe': 'ZW',
  };
  return map[countryName] || null;
}

function flwSecretKey_() {
  return PropertiesService.getScriptProperties().getProperty('FLW_SECRET_KEY');
}

function flwGet_(path) {
  var secretKey = flwSecretKey_();
  if (!secretKey) return null;
  var response;
  try {
    response = UrlFetchApp.fetch('https://api.flutterwave.com/v3/' + path, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + secretKey },
      muteHttpExceptions: true,
    });
  } catch (err) {
    return null;
  }
  try {
    return JSON.parse(response.getContentText());
  } catch (err) {
    return null;
  }
}

function flwPost_(path, payload) {
  var secretKey = flwSecretKey_();
  if (!secretKey) return null;
  var response;
  try {
    response = UrlFetchApp.fetch('https://api.flutterwave.com/v3/' + path, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + secretKey },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
  } catch (err) {
    return null;
  }
  try {
    return JSON.parse(response.getContentText());
  } catch (err) {
    return null;
  }
}

/* ---- getBanks: populates the bank dropdown wherever 'bank' payout exists -
 * Deliberately broader than resolveAccount below: a bank code list is just
 * reference data, available for Malawi/Ethiopia too even though Flutterwave
 * can't verify the account holder's name there. */
function handleGetBanks_(input) {
  var db = readDb_();
  var cfg = findCountryConfig_(db, input.country);
  if (!cfg || cfg.payoutMethods.indexOf('bank') === -1) return { error: 'not_supported' };

  var iso = isoCountryCode_(input.country);
  if (!iso) return { error: 'not_supported' };

  var cache = CacheService.getScriptCache();
  var cacheKey = 'banks_' + iso;
  var cached = cache.get(cacheKey);
  if (cached) return { banks: JSON.parse(cached) };

  if (!flwSecretKey_()) return { error: 'server_not_configured' };
  var result = flwGet_('banks/' + iso);
  if (!result || result.status !== 'success' || !result.data) return { error: 'banks_fetch_failed' };

  var banks = result.data.map(function (b) { return { code: b.code, name: b.name }; });
  cache.put(cacheKey, JSON.stringify(banks), 21600); // CacheService max TTL is 6 hours
  return { banks: banks };
}

/* ---- resolveAccount: the "confirm this is your account" check ----------- */
function handleResolveAccount_(input) {
  var db = readDb_();
  var cfg = findCountryConfig_(db, input.country);
  if (!cfg || !cfg.verified) return { error: 'not_verifiable_for_country' };
  if (!flwSecretKey_()) return { error: 'server_not_configured' };

  var result = flwPost_('accounts/resolve', {
    account_number: String(input.accountNumber || ''),
    account_bank: String(input.accountBank || ''),
  });
  if (!result || result.status !== 'success' || !result.data || !result.data.account_name) {
    return { error: 'resolve_failed' };
  }
  return { accountName: result.data.account_name };
}

/* ---- getPayoutConfig: tells the withdrawal form what to render ---------- */
function handleGetPayoutConfig_(input) {
  var db = readDb_();
  var cfg = findCountryConfig_(db, input.country);
  if (!cfg || !cfg.active) return { error: 'country_not_available' };
  return {
    country: cfg.country,
    currency: cfg.currency,
    payoutMethods: cfg.payoutMethods,
    verified: cfg.verified,
    fxRate: cfg.fxRate,
    feePercent: cfg.feePercent,
  };
}

/* ---- permission check, mirrors hasPermission() in admin.html ------------ */
function userHasPermission_(db, user, permission) {
  if (!user || !user.roleId) return false;
  var role = findById_(db.roles, user.roleId);
  if (!role) return false;
  if (role.name === 'Super Admin') return true;
  return (role.permissions || []).indexOf(permission) !== -1;
}

/* ---- initiateTransfer: admin clicks Approve, this fires the payout ------
 * Holds the wallet balance (deduct now, restore on failure) so the same
 * request can't be double-submitted while a transfer is in flight. Only
 * moves status to 'processing' here — 'paid' / 'failed' is decided by the
 * webhook once Flutterwave actually completes the transfer. */
function handleInitiateTransfer_(input) {
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    var db = readDb_();

    var admin = findById_(db.users, input.adminUserId);
    if (!userHasPermission_(db, admin, 'manage_withdrawals')) return { error: 'not_authorized' };

    var wd = findById_(db.withdrawals, input.withdrawalId);
    if (!wd) return { error: 'not_found' };
    if (wd.status !== 'requested') return { error: 'invalid_status' };

    var cfg = findCountryConfig_(db, wd.country);
    if (!cfg || !cfg.active || !cfg.fxRate) return { error: 'country_not_ready' };
    if (!flwSecretKey_()) return { error: 'server_not_configured' };

    var user = findById_(db.users, wd.userId);
    var walletField = wd.walletType === 'creator' ? 'creatorWallet'
      : wd.walletType === 'affiliate' ? 'affiliateWallet'
      : wd.walletType === 'referral' ? 'referralWallet' : null;
    if (!user || !walletField || (user[walletField] || 0) < wd.amount) {
      return { error: 'insufficient_balance' };
    }

    var reference = 'grovia_wd_' + wd.id + '_' + Date.now();
    var payload = {
      account_bank: wd.payoutType === 'mobile_money' ? wd.network : wd.bankCode,
      account_number: wd.payoutType === 'mobile_money' ? wd.phoneNumber : wd.accountNumber,
      amount: wd.convertedAmount,
      currency: cfg.currency,
      narration: 'Grovia withdrawal',
      reference: reference,
      beneficiary_name: wd.resolvedName || wd.accountName || '',
    };

    var result = flwPost_('transfers', payload);
    if (!result || result.status !== 'success' || !result.data) {
      wd.lastError = (result && result.message) || 'transfer_request_failed';
      db.version += 1;
      writeDb_(db);
      return { error: 'transfer_request_failed' };
    }

    // Hold the funds now that Flutterwave has accepted the transfer request.
    user[walletField] = round2_(user[walletField] - wd.amount);
    wd.status = 'processing';
    wd.flwTransferId = result.data.id;
    wd.flwTransferReference = reference;
    wd.processedAt = new Date().toISOString();
    wd.processedByAdminId = admin.id;

    db.version += 1;
    writeDb_(db);
    return { success: true, transferId: result.data.id };
  } finally {
    lock.releaseLock();
  }
}

/* ---- Flutterwave transfer webhook: flips 'processing' to 'paid'/'failed' */
function handleFlutterwaveWebhook_(input, e) {
  var configuredSecret = PropertiesService.getScriptProperties().getProperty('FLW_WEBHOOK_SECRET');
  if (configuredSecret) {
    var provided = e && e.parameter ? e.parameter.whsec : null;
    if (provided !== configuredSecret) return { error: 'not_authorized' };
  }

  if (input.event !== 'transfer.completed') return { success: true }; // ignore events we don't handle

  var data = input.data || {};
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    var db = readDb_();
    var wd = null;
    for (var i = 0; i < (db.withdrawals || []).length; i++) {
      if (db.withdrawals[i].flwTransferReference === data.reference) { wd = db.withdrawals[i]; break; }
    }
    if (!wd || wd.status !== 'processing') return { success: true }; // unknown or already-settled — ack and move on

    if (data.status === 'SUCCESSFUL') {
      wd.status = 'paid';
      wd.resolvedAt = new Date().toISOString();
    } else {
      // Failed transfer: restore the held balance so the user isn't out the money.
      var user = findById_(db.users, wd.userId);
      var walletField = wd.walletType === 'creator' ? 'creatorWallet'
        : wd.walletType === 'affiliate' ? 'affiliateWallet'
        : wd.walletType === 'referral' ? 'referralWallet' : null;
      if (user && walletField) user[walletField] = round2_((user[walletField] || 0) + wd.amount);

      wd.status = 'failed';
      wd.failureReason = data.complete_message || data.status || 'transfer_failed';
      wd.resolvedAt = new Date().toISOString();
    }

    db.version += 1;
    writeDb_(db);
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}
