/**
 * Idea to Expo — Google Form → Portal synchronisation.
 *
 * Install (in the Google Sheet that receives the Form responses):
 *   1. Extensions → Apps Script, paste this file.
 *   2. Project Settings → Script properties:
 *        PORTAL_URL        = https://<your-app>.vercel.app
 *        FORM_SYNC_SECRET  = <same value as the app's FORM_SYNC_SECRET>
 *        RESPONSE_SHEET    = Form Responses 1   (optional; tab name)
 *   3. Run `installTriggers` once and approve the permissions.
 *
 * What it does:
 *   - On every form submit, sends that response row to the portal.
 *   - Every 10 minutes, replays the whole sheet (catches edited responses,
 *     missed webhooks, portal downtime). The portal upserts by register
 *     number and ignores older data, so replays are always safe.
 *
 * Requests are signed: header x-signature = "sha256=" + HMAC_SHA256(secret, timestamp + "." + body).
 */

var CHUNK_SIZE = 400;

function config_() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('PORTAL_URL');
  var secret = props.getProperty('FORM_SYNC_SECRET');
  if (!url || !secret) throw new Error('Set PORTAL_URL and FORM_SYNC_SECRET in Script properties.');
  return {
    endpoint: url.replace(/\/+$/, '') + '/api/google/form-sync',
    secret: secret,
    sheetName: props.getProperty('RESPONSE_SHEET') || 'Form Responses 1',
  };
}

function sheet_(cfg) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(cfg.sheetName);
  if (!sheet) throw new Error('Response tab "' + cfg.sheetName + '" not found.');
  return sheet;
}

function serialise_(value) {
  if (value instanceof Date) return value.toISOString();
  return value;
}

function hex_(bytes) {
  return bytes
    .map(function (b) {
      var v = (b < 0 ? b + 256 : b).toString(16);
      return v.length === 1 ? '0' + v : v;
    })
    .join('');
}

function post_(cfg, headers, rows, firstRow) {
  var body = JSON.stringify({ headers: headers, rows: rows, firstRow: firstRow });
  var timestamp = String(Date.now());
  var signature = hex_(Utilities.computeHmacSha256Signature(timestamp + '.' + body, cfg.secret));

  var lastError;
  for (var attempt = 0; attempt < 3; attempt++) {
    try {
      var response = UrlFetchApp.fetch(cfg.endpoint, {
        method: 'post',
        contentType: 'application/json',
        payload: body,
        headers: { 'x-timestamp': timestamp, 'x-signature': 'sha256=' + signature },
        muteHttpExceptions: true,
      });
      var code = response.getResponseCode();
      if (code >= 200 && code < 300) return JSON.parse(response.getContentText());
      if (code === 401 || code === 400 || code === 422) {
        throw new Error('Portal rejected sync (' + code + '): ' + response.getContentText());
      }
      lastError = new Error('Portal returned ' + code + ': ' + response.getContentText());
    } catch (e) {
      lastError = e;
      if (String(e).indexOf('rejected') >= 0) throw e;
    }
    Utilities.sleep(1000 * Math.pow(2, attempt));
  }
  throw lastError;
}

/** Trigger: runs for every new form submission. */
function onFormSubmitSync(e) {
  var cfg = config_();
  var sheet = sheet_(cfg);
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  var rowIndex = e && e.range ? e.range.getRow() : sheet.getLastRow();
  var row = sheet.getRange(rowIndex, 1, 1, lastCol).getValues()[0].map(serialise_);
  try {
    post_(cfg, headers, [row], rowIndex);
  } catch (err) {
    // The periodic full sync will pick this row up; log for the script owner.
    console.error('Form sync failed for row ' + rowIndex + ': ' + err);
  }
}

/** Trigger: replays the full response sheet in chunks. Also safe to run manually. */
function syncAllResponses() {
  var cfg = config_();
  var sheet = sheet_(cfg);
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return;
  var headers = values[0].map(String);
  var totals = { received: 0, inserted: 0, updated: 0, skipped: 0 };
  for (var start = 1; start < values.length; start += CHUNK_SIZE) {
    var chunk = values.slice(start, start + CHUNK_SIZE).map(function (r) {
      return r.map(serialise_);
    });
    var result = post_(cfg, headers, chunk, start + 1);
    totals.received += result.received || 0;
    totals.inserted += result.inserted || 0;
    totals.updated += result.updated || 0;
    totals.skipped += result.skipped || 0;
  }
  console.log('Full form sync: ' + JSON.stringify(totals));
}

/** Run once to install both triggers (idempotent). */
function installTriggers() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'onFormSubmitSync' || fn === 'syncAllResponses') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onFormSubmitSync').forSpreadsheet(ss).onFormSubmit().create();
  ScriptApp.newTrigger('syncAllResponses').timeBased().everyMinutes(10).create();
  syncAllResponses();
}
