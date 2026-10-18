/**
 * Smart SHM System - Google Sheets receiver (Google Apps Script web app).
 *
 * Lets the SHM website add alert rows to THIS spreadsheet without any Google Cloud
 * project or service-account key.
 *
 * Setup (about 5 minutes):
 *  1. Create the script either inside the Google Sheet (Extensions > Apps Script) or from
 *     Google Drive (New > More > Google Apps Script). Delete the sample code, paste this file, Save.
 *  2. Project Settings (gear icon) > Script properties > Add script property:
 *       SHM_SECRET      = the GOOGLE_SHEETS_WEBHOOK_SECRET from backend/.env
 *       SPREADSHEET_ID  = the Google Sheet's link or ID (only needed if you created the script from Drive)
 *  3. Deploy > New deployment > type "Web app":
 *       Execute as: Me      Who has access: Anyone
 *     Deploy, allow the permissions, and copy the "Web app URL" (ends in /exec).
 *  4. Put that URL in backend/.env as GOOGLE_SHEETS_WEBHOOK_URL and restart the API.
 *
 * Security: every request must carry SHM_SECRET, so knowing the URL alone is not enough.
 * Updating from an older copy: paste this code over it, Save, then Deploy > Manage deployments >
 * Edit (pencil) > Version: New version > Deploy. The /exec URL stays the same.
 */

var VERSION = 2 // 2: rows are updated in place when an alert is acknowledged, escalated or resolved
var HEADER = ['Alert ID', 'Timestamp', 'Parameter', 'Peak Value', 'Unit', 'Threshold', 'Node ID', 'Location',
  'Severity', 'Anomaly Score', 'Status', 'Notification Status', 'Acknowledged By', 'Acknowledged At',
  'Resolved At'];

function doPost(e) {
  var body
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}')
  } catch (err) {
    return reply({ ok: false, error: 'Request is not valid JSON' })
  }
  var secret = PropertiesService.getScriptProperties().getProperty('SHM_SECRET')
  if (!secret) return reply({ ok: false, error: 'SHM_SECRET is not set in the Apps Script project properties' })
  if (body.secret !== secret) return reply({ ok: false, error: 'Wrong secret - check SHM_SECRET and GOOGLE_SHEETS_WEBHOOK_SECRET' })

  var lock = LockService.getScriptLock() // one write at a time, so retries never duplicate rows
  lock.waitLock(20000)
  try {
    var sheet = getSheet(String(body.worksheet || 'SHM Alerts'))
    switch (body.action) {
      case 'ping':
        return reply({ ok: true, spreadsheet: book().getName(), url: book().getUrl(), worksheet: sheet.getName(),
          rows: Math.max(0, sheet.getLastRow() - 1) })
      case 'setup':
        return reply({ ok: true, spreadsheet: book().getName(), url: book().getUrl() })
      case 'ids':
        return reply({ ok: true, ids: alertIds(sheet) })
      case 'append':
        return reply({ ok: true, appended: append(sheet, body.rows || []) })
      case 'upsert':
        var result = upsert(sheet, body.rows || [])
        result.url = book().getUrl()
        return reply(result)
      default:
        return reply({ ok: false, error: 'Unknown action' })
    }
  } catch (err) {
    return reply({ ok: false, error: String(err) })
  } finally {
    lock.releaseLock()
  }
}

// Opening the URL in a browser only confirms the script is running; it never shows data.
function doGet() {
  return reply({ ok: true, service: 'Smart SHM Google Sheets receiver' })
}

// The spreadsheet to write to: SPREADSHEET_ID from the script properties (needed when the script
// was created from Google Drive), otherwise the sheet this script is attached to.
function book() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID')
  if (id) {
    var m = String(id).match(/\/d\/([A-Za-z0-9_-]{20,})/)
    return SpreadsheetApp.openById(m ? m[1] : String(id).trim())
  }
  var active = SpreadsheetApp.getActiveSpreadsheet()
  if (!active) throw new Error('This script is not attached to a spreadsheet - add the script property SPREADSHEET_ID (the sheet link or ID)')
  return active
}

function getSheet(name) {
  var sheet = book().getSheetByName(name) || book().insertSheet(name)
  var first = sheet.getRange(1, 1, 1, HEADER.length).getValues()[0]
  if (first.join('|') !== HEADER.join('|')) {
    sheet.getRange(1, 1, 1, HEADER.length).setValues([HEADER]).setFontWeight('bold')
    sheet.setFrozenRows(1)
  }
  return sheet
}

function alertIds(sheet) {
  var n = sheet.getLastRow() - 1
  if (n <= 0) return []
  return sheet.getRange(2, 1, n, 1).getValues().map(function (r) { return String(r[0]) }).filter(String)
}

// Text starting with = + - @ would run as a formula in a spreadsheet; store it as plain text.
function safe(v) {
  return (typeof v === 'string' && /^[=+\-@]/.test(v)) ? "'" + v : v
}

function append(sheet, rows) {
  var present = {}
  alertIds(sheet).forEach(function (id) { present[id] = true })
  var fresh = []
  rows.forEach(function (r) {
    if (Array.isArray(r) && r.length === HEADER.length && !present[String(r[0])]) {
      present[String(r[0])] = true
      fresh.push(r.map(safe))
    }
  })
  if (fresh.length) sheet.getRange(sheet.getLastRow() + 1, 1, fresh.length, HEADER.length).setValues(fresh)
  return fresh.length
}

// Rows whose Alert ID is already in the sheet are rewritten in place; the others are added at the end.
function upsert(sheet, rows) {
  var where = {}
  var n = sheet.getLastRow() - 1
  if (n > 0) {
    sheet.getRange(2, 1, n, 1).getValues().forEach(function (r, i) {
      var id = String(r[0])
      if (id && !where[id]) where[id] = i + 2
    })
  }
  var fresh = [], freshAt = {}, updated = 0
  rows.forEach(function (r) {
    if (!Array.isArray(r) || r.length !== HEADER.length) return
    var id = String(r[0]), values = r.map(safe)
    if (where[id]) {
      sheet.getRange(where[id], 1, 1, HEADER.length).setValues([values])
      updated++
    } else if (freshAt[id] !== undefined) {
      fresh[freshAt[id]] = values // the same alert twice in one request: keep the newest
    } else {
      freshAt[id] = fresh.length
      fresh.push(values)
    }
  })
  if (fresh.length) sheet.getRange(sheet.getLastRow() + 1, 1, fresh.length, HEADER.length).setValues(fresh)
  return { ok: true, appended: fresh.length, updated: updated }
}

function reply(obj) {
  obj.version = VERSION
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON)
}
