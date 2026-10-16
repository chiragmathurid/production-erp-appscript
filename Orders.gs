/**
 * Orders.gs — order entry (sales), workflow actions (production / packing / dispatch),
 * dashboard data per role, and order history.
 */

const STATUS = {
  NEW: 'NEW',                     // submitted by sales, waiting for production
  IN_PRODUCTION: 'IN_PRODUCTION', // production accepted
  PRODUCED: 'PRODUCED',           // production finished, waiting for packing
  IN_PACKING: 'IN_PACKING',       // packing accepted
  PACKED: 'PACKED',               // packing finished, waiting for dispatch
  IN_DISPATCH: 'IN_DISPATCH',     // dispatch accepted (loading / vehicle assignment)
  DISPATCHED: 'DISPATCHED',       // left the factory
  DELIVERED: 'DELIVERED',
  CANCELLED: 'CANCELLED'
};

const STATUS_ORDER = ['NEW', 'IN_PRODUCTION', 'PRODUCED', 'IN_PACKING', 'PACKED', 'IN_DISPATCH', 'DISPATCHED', 'DELIVERED', 'CANCELLED'];

/** Which statuses each operational role can see. Earlier stages are view-only "upcoming" orders;
 *  the ACTIONS table below still decides what each role may actually do. */
const ROLE_QUEUE = {
  production: [STATUS.NEW, STATUS.IN_PRODUCTION],
  packing: [STATUS.NEW, STATUS.IN_PRODUCTION, STATUS.PRODUCED, STATUS.IN_PACKING],
  dispatch: [STATUS.NEW, STATUS.IN_PRODUCTION, STATUS.PRODUCED, STATUS.IN_PACKING, STATUS.PACKED, STATUS.IN_DISPATCH, STATUS.DISPATCHED]
};

/** Order fields each operational role may see (others see everything). */
const ROLE_FIELDS = (function () {
  const base = ['OrderID', 'Status', 'CreatedAt', 'CustomerName', 'DeliveryDate', 'DeliveryTime', 'TotalWeight', 'TotalBoxes', 'SalesRemarks', 'UpdatedAt'];
  const prod = ['ProductionStatus', 'ProdAcceptedBy', 'ProdAcceptedAt', 'ProdFinishedBy', 'ProdFinishedAt', 'ProductionRemarks'];
  const pack = ['PackingDetails', 'PackingImageURL', 'PackingImageID', 'PackingStatus', 'PackAcceptedBy', 'PackAcceptedAt', 'PackFinishedBy', 'PackFinishedAt', 'PackingRemarks'];
  const disp = ['Mobile', 'DeliveryAddress', 'DispAcceptedBy', 'DispAcceptedAt', 'VehicleNo', 'DriverName', 'DriverMobile', 'DispatchedBy', 'DispatchedAt', 'DispatchRemarks', 'DeliveredBy', 'DeliveredAt', 'ReceivedBy', 'DeliveryRemarks'];
  return {
    production: base.concat(prod),
    packing: base.concat(prod, pack),
    dispatch: base.concat(['PackingStatus', 'PackFinishedBy', 'PackFinishedAt', 'PackingRemarks'], disp)
  };
})();

/**
 * Workflow transitions. Each action may only run from the listed statuses by the listed roles
 * (admin can run every action).
 */
const ACTIONS = {
  PROD_ACCEPT: { roles: ['production'], from: [STATUS.NEW], to: STATUS.IN_PRODUCTION, by: 'ProdAcceptedBy', at: 'ProdAcceptedAt' },
  PROD_SAVE: { roles: ['production'], from: [STATUS.IN_PRODUCTION], to: null },
  PROD_FINISH: { roles: ['production'], from: [STATUS.IN_PRODUCTION], to: STATUS.PRODUCED, by: 'ProdFinishedBy', at: 'ProdFinishedAt' },
  PACK_ACCEPT: { roles: ['packing'], from: [STATUS.PRODUCED], to: STATUS.IN_PACKING, by: 'PackAcceptedBy', at: 'PackAcceptedAt' },
  PACK_SAVE: { roles: ['packing'], from: [STATUS.IN_PACKING], to: null },
  PACK_FINISH: { roles: ['packing'], from: [STATUS.IN_PACKING], to: STATUS.PACKED, by: 'PackFinishedBy', at: 'PackFinishedAt' },
  DISP_ACCEPT: { roles: ['dispatch'], from: [STATUS.PACKED], to: STATUS.IN_DISPATCH, by: 'DispAcceptedBy', at: 'DispAcceptedAt' },
  DISP_SEND: { roles: ['dispatch'], from: [STATUS.IN_DISPATCH], to: STATUS.DISPATCHED, by: 'DispatchedBy', at: 'DispatchedAt' },
  DELIVERED: { roles: ['dispatch'], from: [STATUS.DISPATCHED], to: STATUS.DELIVERED, by: 'DeliveredBy', at: 'DeliveredAt' }
};

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

/** Everything the UI needs after login / on refresh, filtered for the user's role. */
function getDashboard(token) {
  ensureSchema_();
  const s = auth_(token);
  const settings = getSettings_();
  const showPrices = !ROLE_FIELDS[s.role];
  const itemsByOrder = {};
  readAll_(SHEETS.ITEMS).forEach(function (it) {
    const id = String(it.OrderID);
    (itemsByOrder[id] = itemsByOrder[id] || []).push(cleanItem_(it, showPrices));
  });
  Object.keys(itemsByOrder).forEach(function (k) { itemsByOrder[k].sort(function (a, b) { return a.ItemNo - b.ItemNo; }); });

  let orders = readAll_(SHEETS.ORDERS);
  const queue = ROLE_QUEUE[s.role];
  if (queue) orders = orders.filter(function (o) { return queue.indexOf(o.Status) >= 0; });

  const fields = ROLE_FIELDS[s.role];
  orders = orders.map(function (o) {
    const out = {};
    Object.keys(o).forEach(function (k) {
      if (k === '_row') return;
      if (!fields || fields.indexOf(k) >= 0) out[k] = o[k];
    });
    out.OrderID = String(o.OrderID);
    out.items = itemsByOrder[out.OrderID] || [];
    return out;
  });

  orders.sort(function (a, b) {
    const da = (a.DeliveryDate || '') + ' ' + (a.DeliveryTime || '');
    const db = (b.DeliveryDate || '') + ' ' + (b.DeliveryTime || '');
    return da < db ? -1 : da > db ? 1 : 0;
  });

  return {
    user: s,
    companyName: settings.COMPANY_NAME || APP_NAME,
    allowPartialProduction: isTrue_(settings.ALLOW_PARTIAL_PRODUCTION_FINISH),
    allowPartialPacking: isTrue_(settings.ALLOW_PARTIAL_PACKING_FINISH),
    sweets: readAll_(SHEETS.SWEETS).filter(function (r) { return isTrue_(r.Active); }).map(function (r) { return String(r.SweetName); }),
    statuses: STATUS_ORDER,
    sheetUrl: (s.role === 'admin' || s.role === 'accounts') ? ss_().getUrl() : '',
    orders: orders,
    serverTime: Utilities.formatDate(now_(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')
  };
}

function cleanItem_(it, showPrices) {
  const out = {
    ItemNo: num_(it.ItemNo), SweetName: String(it.SweetName), Weight: num_(it.Weight),
    Boxes: num_(it.Boxes), BoxWeight: num_(it.BoxWeight),
    ProducedWeight: num_(it.ProducedWeight), PackedBoxes: num_(it.PackedBoxes),
    ItemNotes: String(it.ItemNotes || '')
  };
  if (showPrices) { out.Rate = money_(it.Rate); out.Amount = money_(it.Amount); }
  return out;
}

/** Subtotal = Σ weight × rate; discount is a percentage of the subtotal. */
function orderTotals_(items, discountPercent) {
  const subtotal = money_(items.reduce(function (t, it) { return t + money_(it.weight * it.rate); }, 0));
  const discount = money_(subtotal * discountPercent / 100);
  return { subtotal: subtotal, discount: discount, grandTotal: money_(subtotal - discount) };
}

/** Activity history of one order (for the detail view). */
function getOrderHistory(token, orderId) {
  const s = auth_(token);
  const id = String(orderId);
  return readAll_(SHEETS.LOG)
    .filter(function (r) { return String(r.OrderID) === id; })
    .map(function (r) {
      return { Timestamp: r.Timestamp, Action: r.Action, Username: r.Username, Role: r.Role, FromStatus: r.FromStatus, ToStatus: r.ToStatus, Details: s.role === 'admin' || s.role === 'accounts' ? r.Details : '' };
    });
}

/* ------------------------------------------------------------------ */
/* Sales: create / edit order                                          */
/* ------------------------------------------------------------------ */

/**
 * payload = {
 *   orderId?, customerName, mobile, deliveryDate (yyyy-MM-dd), deliveryTime (HH:mm), deliveryAddress,
 *   gstin?, gstBusinessName?, gstAddress?, packingDetails?, salesRemarks?, discountPercent?,
 *   items: [{ sweetName, weight, boxes, boxWeight, rate, notes }],
 *   image?: { name, mimeType, data (base64) }, removeImage?: boolean
 * }
 */
function saveOrder(token, payload) {
  ensureSchema_();
  const s = auth_(token, ['sales']);
  const p = validateOrder_(payload);

  // upload image outside the lock (Drive can be slow)
  let image = null;
  if (payload.image && payload.image.data) image = saveImage_(payload.image, p.customerName);

  return withLock_(function () {
    const totals = p.items.reduce(function (t, it) { t.w += it.weight; t.b += it.boxes; return t; }, { w: 0, b: 0 });
    const money = orderTotals_(p.items, p.discountPercent);
    const record = {
      CustomerName: p.customerName, Mobile: p.mobile,
      DeliveryDate: p.deliveryDate, DeliveryTime: p.deliveryTime, DeliveryAddress: p.deliveryAddress,
      GSTIN: p.gstin, GSTBusinessName: p.gstBusinessName, GSTAddress: p.gstAddress,
      PackingDetails: p.packingDetails, SalesRemarks: p.salesRemarks,
      TotalWeight: Math.round(totals.w * 1000) / 1000, TotalBoxes: totals.b,
      Subtotal: money.subtotal, DiscountPercent: p.discountPercent, DiscountAmount: money.discount, GrandTotal: money.grandTotal,
      UpdatedAt: now_()
    };
    if (image) { record.PackingImageURL = image.url; record.PackingImageID = image.id; }

    let orderId;
    if (p.orderId) {
      // edit — only while still NEW (admin can edit any time before delivery)
      const o = findOrder_(p.orderId);
      if (!o) throw new Error('Order not found.');
      if (s.role !== 'admin') {
        if (o.Status !== STATUS.NEW) throw new Error('Order is already with production and can no longer be edited by sales.');
      } else if (o.Status === STATUS.DELIVERED || o.Status === STATUS.CANCELLED) {
        throw new Error('Delivered / cancelled orders cannot be edited.');
      }
      if (payload.removeImage && !image) { record.PackingImageURL = ''; record.PackingImageID = ''; }
      orderId = String(o.OrderID);
      updateRow_(SHEETS.ORDERS, o._row, record);

      // replace items, but keep production / packing progress for matching item numbers
      const oldItems = readAll_(SHEETS.ITEMS).filter(function (it) { return String(it.OrderID) === orderId; });
      const progress = {};
      oldItems.forEach(function (it) { progress[it.ItemNo] = it; });
      deleteRows_(SHEETS.ITEMS, oldItems.map(function (it) { return it._row; }));
      appendObjs_(SHEETS.ITEMS, p.items.map(function (it, i) {
        const prev = progress[i + 1] || {};
        return itemRecord_(orderId, i + 1, it, num_(prev.ProducedWeight), num_(prev.PackedBoxes));
      }));
      log_(orderId, 'ORDER_EDITED', s, o.Status, o.Status, JSON.stringify(record));
    } else {
      orderId = nextOrderId_();
      record.OrderID = orderId;
      record.Status = STATUS.NEW;
      record.CreatedAt = now_();
      record.CreatedBy = s.username;
      record.ProductionStatus = 'Pending';
      record.PackingStatus = 'Pending';
      appendObj_(SHEETS.ORDERS, record);
      appendObjs_(SHEETS.ITEMS, p.items.map(function (it, i) { return itemRecord_(orderId, i + 1, it, 0, 0); }));
      log_(orderId, 'ORDER_CREATED', s, '', STATUS.NEW, p.items.length + ' item(s), ' + record.TotalWeight + ' kg, ' + record.TotalBoxes + ' box(es), total ' + record.GrandTotal);
    }
    return { orderId: orderId };
  });
}

function itemRecord_(orderId, no, it, produced, packed) {
  return {
    OrderID: orderId, ItemNo: no, SweetName: it.sweetName, Weight: it.weight,
    Boxes: it.boxes, BoxWeight: it.boxWeight, ProducedWeight: produced || 0, PackedBoxes: packed || 0,
    ItemNotes: it.notes, Rate: it.rate, Amount: money_(it.weight * it.rate)
  };
}

function validateOrder_(payload) {
  if (!payload) throw new Error('No data received.');
  const p = {
    orderId: str_(payload.orderId),
    customerName: str_(payload.customerName),
    mobile: str_(payload.mobile).replace(/[\s-]/g, ''),
    deliveryDate: str_(payload.deliveryDate),
    deliveryTime: str_(payload.deliveryTime),
    deliveryAddress: str_(payload.deliveryAddress),
    gstin: str_(payload.gstin).toUpperCase(),
    gstBusinessName: str_(payload.gstBusinessName),
    gstAddress: str_(payload.gstAddress),
    packingDetails: str_(payload.packingDetails),
    salesRemarks: str_(payload.salesRemarks),
    discountPercent: money_(payload.discountPercent),
    items: []
  };
  const errors = [];
  if (!p.customerName) errors.push('Customer name is required.');
  if (!/^(\+?91)?[6-9]\d{9}$/.test(p.mobile)) errors.push('Enter a valid 10 digit mobile number.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.deliveryDate)) errors.push('Delivery date is required.');
  if (!/^\d{2}:\d{2}$/.test(p.deliveryTime)) errors.push('Delivery time is required.');
  if (!p.deliveryAddress) errors.push('Delivery address is required.');
  if (p.gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(p.gstin)) errors.push('GSTIN format looks wrong (15 characters, e.g. 27ABCDE1234F1Z5).');
  if (p.discountPercent < 0 || p.discountPercent > 100) errors.push('Discount must be between 0 and 100 %.');

  (payload.items || []).forEach(function (it, i) {
    const item = {
      sweetName: str_(it.sweetName), weight: num_(it.weight), boxes: Math.round(num_(it.boxes)),
      boxWeight: num_(it.boxWeight), rate: money_(it.rate), notes: str_(it.notes)
    };
    if (item.rate < 0) errors.push('Item ' + (i + 1) + ': rate cannot be negative.');
    if (!item.sweetName && !item.weight && !item.boxes) return; // blank row
    if (!item.sweetName) errors.push('Item ' + (i + 1) + ': sweet name is required.');
    if (item.weight <= 0 && item.boxes > 0 && item.boxWeight > 0) item.weight = Math.round(item.boxes * item.boxWeight * 1000) / 1000;
    if (item.weight <= 0) errors.push('Item ' + (i + 1) + ': weight must be more than 0.');
    if (item.boxes < 0 || item.boxWeight < 0) errors.push('Item ' + (i + 1) + ': boxes / box weight cannot be negative.');
    p.items.push(item);
  });
  if (!p.items.length) errors.push('Add at least one sweet item.');
  if (errors.length) throw new Error(errors.join('\n'));
  return p;
}

function nextOrderId_() {
  const props = PropertiesService.getScriptProperties();
  let seq = parseInt(props.getProperty('ORDER_SEQ') || '1000', 10);
  // guard against a reset property: never reuse an existing id
  const existing = {};
  readAll_(SHEETS.ORDERS).forEach(function (o) { existing[String(o.OrderID)] = true; });
  const prefix = str_(getSetting_('ORDER_PREFIX')) || 'ORD';
  let id;
  do { seq++; id = prefix + '-' + seq; } while (existing[id]);
  props.setProperty('ORDER_SEQ', String(seq));
  return id;
}

function findOrder_(orderId) {
  const id = String(orderId);
  return readAll_(SHEETS.ORDERS).filter(function (o) { return String(o.OrderID) === id; })[0] || null;
}

/** Saves a base64 image to the Drive folder from Settings and returns { id, url }. */
function saveImage_(img, customerName) {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
  if (allowed.indexOf(img.mimeType) < 0) throw new Error('Only JPG / PNG / WEBP / HEIC images are allowed.');
  const bytes = Utilities.base64Decode(img.data);
  if (bytes.length > 8 * 1024 * 1024) throw new Error('Image is too large (max 8 MB).');

  let folder;
  const folderId = str_(getSetting_('DRIVE_FOLDER_ID'));
  try { folder = folderId ? DriveApp.getFolderById(folderId) : null; } catch (e) { folder = null; }
  if (!folder) {
    folder = DriveApp.createFolder(APP_NAME + ' - Packing Images');
    setSetting_('DRIVE_FOLDER_ID', folder.getId());
  }
  const stamp = Utilities.formatDate(now_(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
  const safe = String(customerName || 'order').replace(/[^\w\- ]+/g, '').slice(0, 40);
  const file = folder.createFile(Utilities.newBlob(bytes, img.mimeType, stamp + ' ' + safe + ' - ' + (img.name || 'packing.jpg')));
  if (isTrue_(getSetting_('SHARE_IMAGES_BY_LINK'))) {
    try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) { /* blocked by domain policy */ }
  }
  return { id: file.getId(), url: file.getUrl() };
}

/* ------------------------------------------------------------------ */
/* Workflow actions                                                    */
/* ------------------------------------------------------------------ */

/**
 * data depends on the action:
 *  PROD_SAVE / PROD_FINISH : { items: [{ itemNo, producedWeight }], remarks }
 *  PACK_SAVE / PACK_FINISH : { items: [{ itemNo, packedBoxes }], remarks }
 *  DISP_SEND               : { vehicleNo, driverName, driverMobile, remarks }
 *  DELIVERED               : { receivedBy, remarks }
 */
function performAction(token, orderId, action, data) {
  const def = ACTIONS[action];
  if (!def) throw new Error('Unknown action: ' + action);
  const s = auth_(token, def.roles);
  data = data || {};

  return withLock_(function () {
    const o = findOrder_(orderId);
    if (!o) throw new Error('Order not found.');
    if (def.from.indexOf(o.Status) < 0) {
      throw new Error('Order ' + o.OrderID + ' is now "' + o.Status + '" — someone may have already updated it. Refresh and try again.');
    }
    const id = String(o.OrderID);
    const patch = { UpdatedAt: now_() };
    let details = '';

    if (action.indexOf('PROD_') === 0 && action !== 'PROD_ACCEPT') {
      const r = updateItemProgress_(id, data.items, 'ProducedWeight', 'Weight');
      patch.ProductionStatus = r.complete ? 'Full' : (r.anyDone ? 'Partial' : 'Pending');
      if (data.remarks !== undefined) patch.ProductionRemarks = str_(data.remarks);
      details = r.summary;
      if (action === 'PROD_FINISH') {
        if (!r.anyDone) throw new Error('Enter the produced weight before finishing.');
        if (!r.complete && !isTrue_(getSetting_('ALLOW_PARTIAL_PRODUCTION_FINISH')) && s.role !== 'admin') {
          throw new Error('Production is partial. Produce the full weight before finishing (partial finish is disabled by admin).');
        }
      }
    }

    if (action.indexOf('PACK_') === 0 && action !== 'PACK_ACCEPT') {
      const r = updateItemProgress_(id, data.items, 'PackedBoxes', 'Boxes');
      patch.PackingStatus = r.complete ? 'Full' : (r.anyDone ? 'Partial' : 'Pending');
      if (data.remarks !== undefined) patch.PackingRemarks = str_(data.remarks);
      details = r.summary;
      if (action === 'PACK_FINISH') {
        if (!r.complete && !isTrue_(getSetting_('ALLOW_PARTIAL_PACKING_FINISH')) && s.role !== 'admin') {
          throw new Error('Packing is partial. Pack all boxes before finishing (partial finish is disabled by admin).');
        }
      }
    }

    if (action === 'DISP_SEND') {
      const vehicle = str_(data.vehicleNo).toUpperCase();
      const driver = str_(data.driverName);
      const dmob = str_(data.driverMobile).replace(/[\s-]/g, '');
      if (!vehicle) throw new Error('Vehicle number is required.');
      if (!driver) throw new Error('Driver name is required.');
      if (dmob && !/^(\+?91)?[6-9]\d{9}$/.test(dmob)) throw new Error('Driver mobile looks invalid.');
      patch.VehicleNo = vehicle; patch.DriverName = driver; patch.DriverMobile = dmob;
      patch.DispatchRemarks = str_(data.remarks);
      details = vehicle + ' / ' + driver + (dmob ? ' / ' + dmob : '');
    }

    if (action === 'DELIVERED') {
      patch.ReceivedBy = str_(data.receivedBy);
      patch.DeliveryRemarks = str_(data.remarks);
      details = patch.ReceivedBy ? 'Received by ' + patch.ReceivedBy : '';
    }

    if (def.to) patch.Status = def.to;
    if (def.by) { patch[def.by] = s.username; patch[def.at] = now_(); }
    updateRow_(SHEETS.ORDERS, o._row, patch);
    log_(id, action, s, o.Status, def.to || o.Status, details);
    return { orderId: id, status: def.to || o.Status };
  });
}

/**
 * Updates ProducedWeight or PackedBoxes on the order's item rows.
 * Returns { complete, anyDone, summary }.
 */
function updateItemProgress_(orderId, inputs, field, targetField) {
  const byNo = {};
  (inputs || []).forEach(function (x) {
    const v = field === 'ProducedWeight' ? x.producedWeight : x.packedBoxes;
    if (v === '' || v === null || v === undefined) return;
    const n = num_(v);
    if (n < 0) throw new Error('Values cannot be negative.');
    byNo[num_(x.itemNo)] = n;
  });
  const items = readAll_(SHEETS.ITEMS).filter(function (it) { return String(it.OrderID) === orderId; });
  let complete = items.length > 0, anyDone = false;
  const parts = [];
  items.forEach(function (it) {
    const no = num_(it.ItemNo);
    let val = num_(it[field]);
    if (byNo.hasOwnProperty(no)) {
      val = byNo[no];
      const p = {}; p[field] = val;
      updateRow_(SHEETS.ITEMS, it._row, p);
    }
    const target = num_(it[targetField]);
    if (val > 0) anyDone = true;
    if (val + 1e-9 < target) complete = false;
    parts.push(it.SweetName + ': ' + val + '/' + target);
  });
  return { complete: complete, anyDone: anyDone, summary: parts.join(', ') };
}
