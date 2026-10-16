/**
 * Sweets Factory ERP — Google Apps Script + Google Sheets
 * Flow: Sales -> Production -> Packing -> Dispatch -> Delivered
 * Roles: sales, production, packing, dispatch, accounts, admin
 *
 * Code.gs: configuration, setup, web-app entry point and sheet helpers.
 */

const APP_NAME = 'Sweets Factory ERP';

const ROLES = ['sales', 'production', 'packing', 'dispatch', 'accounts', 'admin'];

const SHEETS = {
  ORDERS: 'Orders',
  ITEMS: 'OrderItems',
  USERS: 'Users',
  SWEETS: 'Sweets',
  SETTINGS: 'Settings',
  LOG: 'ActivityLog'
};

const HEADERS = {
  Orders: [
    'OrderID', 'Status', 'CreatedAt', 'CreatedBy',
    'CustomerName', 'Mobile', 'DeliveryDate', 'DeliveryTime', 'DeliveryAddress',
    'GSTIN', 'GSTBusinessName', 'GSTAddress',
    'PackingDetails', 'PackingImageURL', 'PackingImageID',
    'TotalWeight', 'TotalBoxes', 'SalesRemarks',
    'ProductionStatus', 'ProdAcceptedBy', 'ProdAcceptedAt', 'ProdFinishedBy', 'ProdFinishedAt', 'ProductionRemarks',
    'PackingStatus', 'PackAcceptedBy', 'PackAcceptedAt', 'PackFinishedBy', 'PackFinishedAt', 'PackingRemarks',
    'DispAcceptedBy', 'DispAcceptedAt', 'VehicleNo', 'DriverName', 'DriverMobile', 'DispatchedBy', 'DispatchedAt', 'DispatchRemarks',
    'DeliveredBy', 'DeliveredAt', 'ReceivedBy', 'DeliveryRemarks',
    'UpdatedAt',
    'Subtotal', 'DiscountPercent', 'DiscountAmount', 'GrandTotal'
  ],
  OrderItems: ['OrderID', 'ItemNo', 'SweetName', 'Weight', 'Boxes', 'BoxWeight', 'ProducedWeight', 'PackedBoxes', 'ItemNotes', 'Rate', 'Amount'],
  Users: ['Username', 'FullName', 'Role', 'PasswordHash', 'Salt', 'Active', 'CreatedAt', 'LastLogin'],
  Sweets: ['SweetName', 'Active'],
  Settings: ['Key', 'Value', 'Description'],
  ActivityLog: ['Timestamp', 'OrderID', 'Action', 'Username', 'Role', 'FromStatus', 'ToStatus', 'Details']
};

const DEFAULT_SETTINGS = [
  ['COMPANY_NAME', 'My Sweets Factory', 'Shown in the app header'],
  ['ORDER_PREFIX', 'ORD', 'Prefix for order numbers, e.g. ORD-1001'],
  ['ALLOW_PARTIAL_PRODUCTION_FINISH', true, 'TRUE = production may Finish even if produced weight < ordered weight'],
  ['ALLOW_PARTIAL_PACKING_FINISH', true, 'TRUE = packing may Finish even if packed boxes < ordered boxes'],
  ['DRIVE_FOLDER_ID', '', 'Drive folder for packing images (auto-created by setup)'],
  ['SHARE_IMAGES_BY_LINK', true, 'TRUE = make uploaded images viewable by link so thumbnails show in the app']
];

const DEFAULT_SWEETS = ['Kaju Katli', 'Rasgulla', 'Gulab Jamun', 'Soan Papdi', 'Motichoor Laddu', 'Besan Laddu', 'Milk Cake', 'Barfi', 'Peda', 'Jalebi'];

/* ------------------------------------------------------------------ */
/* Menu + setup                                                        */
/* ------------------------------------------------------------------ */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Factory ERP')
    .addItem('1. Setup / Repair sheets', 'setup')
    .addItem('Show web app link', 'showAppLink')
    .addItem('Reset admin password', 'resetAdminPassword')
    .addToUi();
}

/**
 * Creates all sheets, headers, default settings, default sweets and
 * a default admin user (admin / admin123). Safe to run again.
 */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('This script is not attached to a Google Sheet. Open your sheet, go to Extensions > Apps Script, and paste the code there.');
  ensureSetup_(ss);
  const msg = 'Setup complete.\n\nDefault login: admin / admin123 (change it after first login).\n\n' +
    'Next: Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).';
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); } // getUi() fails when run from the editor
}

/** Creates / repairs all sheets and defaults without any UI. Also called automatically by the web app. */
function ensureSetup_(ss) {
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());

  Object.keys(HEADERS).forEach(function (name) {
    let sh = ss.getSheetByName(name);
    if (!sh) {
      try { sh = ss.insertSheet(name); } catch (e) { sh = ss.getSheetByName(name); } // created by a parallel request
    }
    const headers = HEADERS[name];
    const existing = sh.getLastColumn() > 0
      ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].filter(String)
      : [];
    // add any missing headers at the end (never reorders existing data)
    const missing = headers.filter(function (h) { return existing.indexOf(h) < 0; });
    if (existing.length === 0) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    } else if (missing.length) {
      sh.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
    }
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, sh.getLastColumn()).setFontWeight('bold').setBackground('#cce6e7');
  });

  // default settings
  const settingsSh = ss.getSheetByName(SHEETS.SETTINGS);
  const keys = readAll_(SHEETS.SETTINGS).map(function (r) { return r.Key; });
  DEFAULT_SETTINGS.forEach(function (row) {
    if (keys.indexOf(row[0]) < 0) settingsSh.appendRow(row);
  });

  // default sweets
  if (readAll_(SHEETS.SWEETS).length === 0) {
    DEFAULT_SWEETS.forEach(function (s) { appendObj_(SHEETS.SWEETS, { SweetName: s, Active: true }); });
  }

  // drive folder for images
  if (!getSetting_('DRIVE_FOLDER_ID')) {
    const folder = DriveApp.createFolder(APP_NAME + ' - Packing Images');
    setSetting_('DRIVE_FOLDER_ID', folder.getId());
  }

  // default admin
  if (!findUser_('admin')) {
    createUserRecord_('admin', 'Administrator', 'admin', 'admin123');
  }

  // remove the blank default sheet if present
  const blank = ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1 && blank.getLastRow() === 0) ss.deleteSheet(blank);

  PropertiesService.getScriptProperties().setProperty('SCHEMA_VERSION', String(SCHEMA_VERSION));
}

/** Bump when HEADERS gain columns: existing sheets get the new columns on the next request. */
const SCHEMA_VERSION = 2;

function ensureSchema_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('SCHEMA_VERSION') === String(SCHEMA_VERSION)) return;
  withLock_(function () {
    if (props.getProperty('SCHEMA_VERSION') !== String(SCHEMA_VERSION)) ensureSetup_(ss_());
  });
}

function showAppLink() {
  const url = ScriptApp.getService().getUrl();
  SpreadsheetApp.getUi().alert(url ? 'Web app URL:\n\n' + url : 'Not deployed yet. Use Deploy > New deployment > Web app.');
}

function resetAdminPassword() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('Reset admin password', 'Enter a new password for user "admin" (min 6 chars):', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const pwd = res.getResponseText();
  if (!pwd || pwd.length < 6) { ui.alert('Password too short.'); return; }
  const u = findUser_('admin');
  if (!u) { createUserRecord_('admin', 'Administrator', 'admin', pwd); }
  else {
    const salt = Utilities.getUuid();
    updateRow_(SHEETS.USERS, u._row, { PasswordHash: hashPassword_(pwd, salt), Salt: salt, Active: true, Role: 'admin' });
  }
  ui.alert('Admin password updated.');
}

/* ------------------------------------------------------------------ */
/* Web app                                                             */
/* ------------------------------------------------------------------ */

function doGet() {
  const t = HtmlService.createTemplateFromFile('Index');
  t.appName = APP_NAME;
  return t.evaluate()
    .setTitle(APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/* ------------------------------------------------------------------ */
/* Sheet helpers                                                       */
/* ------------------------------------------------------------------ */

function ss_() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('App not set up. Open the sheet, then Extensions > Apps Script, choose "setup" in the toolbar and click Run.');
  return SpreadsheetApp.openById(id);
}

function sheet_(name) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    ensureSetup_(ss); // first use, or a tab was deleted — rebuild missing sheets
    sh = ss.getSheetByName(name);
  }
  if (!sh) throw new Error('Missing sheet "' + name + '". Run setup from the Apps Script editor.');
  return sh;
}

function headerMap_(sh) {
  const h = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const map = {};
  h.forEach(function (k, i) { if (k) map[k] = i; });
  return { list: h, map: map };
}

/** Reads a sheet into an array of objects. Dates become strings (safe for google.script.run). */
function readAll_(name) {
  const sh = sheet_(name);
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values.shift();
  const tz = Session.getScriptTimeZone();
  return values.map(function (r, i) {
    const o = { _row: i + 2 };
    headers.forEach(function (k, j) {
      if (!k) return;
      let v = r[j];
      if (v instanceof Date) {
        v = (v.getHours() === 0 && v.getMinutes() === 0 && v.getSeconds() === 0)
          ? Utilities.formatDate(v, tz, 'yyyy-MM-dd')
          : Utilities.formatDate(v, tz, 'yyyy-MM-dd HH:mm');
      }
      o[k] = v;
    });
    return o;
  }).filter(function (o) { return o[headers[0]] !== '' && o[headers[0]] !== null; });
}

/** Strings are written as plain text (leading apostrophe) so phone numbers, GSTIN, dates
 *  and times are not auto-converted, and user input can never become a formula. */
function cellValue_(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v === '' ? '' : "'" + v;
  return v;
}

function appendObj_(name, obj) {
  const sh = sheet_(name);
  const h = headerMap_(sh).list;
  sh.appendRow(h.map(function (k) { return cellValue_(obj[k]); }));
}

function appendObjs_(name, objs) {
  if (!objs.length) return;
  const sh = sheet_(name);
  const h = headerMap_(sh).list;
  const rows = objs.map(function (obj) { return h.map(function (k) { return cellValue_(obj[k]); }); });
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, h.length).setValues(rows);
}

function updateRow_(name, row, patch) {
  const sh = sheet_(name);
  const hm = headerMap_(sh);
  const range = sh.getRange(row, 1, 1, hm.list.length);
  const current = range.getValues()[0];
  Object.keys(patch).forEach(function (k) {
    if (hm.map[k] === undefined) return;
    current[hm.map[k]] = cellValue_(patch[k]);
  });
  // keep untouched string cells as they are (getValues returns raw values, so re-writing is safe
  // except for strings that look like numbers/dates — re-mark them as text)
  const out = current.map(function (v, i) {
    const key = hm.list[i];
    if (patch.hasOwnProperty(key)) return v;
    return (typeof v === 'string' && v !== '') ? "'" + v : v;
  });
  range.setValues([out]);
}

function deleteRows_(name, rows) {
  const sh = sheet_(name);
  rows.sort(function (a, b) { return b - a; }).forEach(function (r) { sh.deleteRow(r); });
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function getSettings_() {
  const out = {};
  readAll_(SHEETS.SETTINGS).forEach(function (r) { out[r.Key] = r.Value; });
  return out;
}

function getSetting_(key) {
  return getSettings_()[key];
}

function setSetting_(key, value) {
  const row = readAll_(SHEETS.SETTINGS).filter(function (r) { return r.Key === key; })[0];
  if (row) updateRow_(SHEETS.SETTINGS, row._row, { Value: value });
  else appendObj_(SHEETS.SETTINGS, { Key: key, Value: value, Description: '' });
}

function isTrue_(v) {
  return v === true || String(v).toUpperCase() === 'TRUE' || v === 1 || v === '1';
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function num_(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : Math.round(n * 1000) / 1000;
}

function money_(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

function str_(v) {
  return (v === undefined || v === null) ? '' : String(v).trim();
}

function now_() { return new Date(); }

function log_(orderId, action, session, fromStatus, toStatus, details) {
  appendObj_(SHEETS.LOG, {
    Timestamp: now_(), OrderID: orderId || '', Action: action,
    Username: session ? session.username : '', Role: session ? session.role : '',
    FromStatus: fromStatus || '', ToStatus: toStatus || '', Details: details || ''
  });
}
