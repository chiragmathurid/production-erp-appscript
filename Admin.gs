/**
 * Admin.gs — user management, sweets master, settings and order overrides (admin only).
 */

function adminGetData(token) {
  auth_(token, ['admin']);
  return {
    users: readAll_(SHEETS.USERS).map(function (u) {
      return { Username: String(u.Username), FullName: String(u.FullName), Role: String(u.Role), Active: isTrue_(u.Active), CreatedAt: u.CreatedAt, LastLogin: u.LastLogin };
    }),
    sweets: readAll_(SHEETS.SWEETS).map(function (r) {
      return { SweetName: String(r.SweetName), Rate: money_(r.Rate) || '', Active: isTrue_(r.Active) };
    }),
    settings: readAll_(SHEETS.SETTINGS).map(function (r) { return { Key: r.Key, Value: r.Value, Description: r.Description }; }),
    roles: ROLES,
    statuses: STATUS_ORDER
  };
}

/** Create or update a user. Password is only changed when one is supplied. */
function adminSaveUser(token, u) {
  const s = auth_(token, ['admin']);
  const username = str_(u.Username).toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new Error('Username: 3-30 characters, letters / numbers / . _ - only.');
  if (ROLES.indexOf(u.Role) < 0) throw new Error('Invalid role.');
  const pwd = String(u.Password || '');
  if (pwd && pwd.length < 6) throw new Error('Password must be at least 6 characters.');

  return withLock_(function () {
    const existing = findUser_(username);
    if (!existing) {
      if (!pwd) throw new Error('Password is required for a new user.');
      createUserRecord_(username, str_(u.FullName) || username, u.Role, pwd);
      if (u.Active === false) updateRow_(SHEETS.USERS, findUser_(username)._row, { Active: false });
      log_('', 'USER_CREATED', s, '', '', username + ' (' + u.Role + ')');
    } else {
      if (username === s.username && (u.Role !== 'admin' || u.Active === false)) {
        throw new Error('You cannot remove your own admin access.');
      }
      const patch = { FullName: str_(u.FullName) || username, Role: u.Role, Active: u.Active !== false };
      if (pwd) { const salt = Utilities.getUuid(); patch.Salt = salt; patch.PasswordHash = hashPassword_(pwd, salt); }
      updateRow_(SHEETS.USERS, existing._row, patch);
      log_('', 'USER_UPDATED', s, '', '', username + ' (' + u.Role + ', ' + (patch.Active ? 'active' : 'disabled') + (pwd ? ', password reset' : '') + ')');
    }
    return adminGetData(token);
  });
}

/**
 * Replaces the sweets master. Each sweet: { SweetName, Rate (per kg, optional), Active }.
 * If the client does not send Rate for a sweet (older screen), the rate already in the sheet is kept.
 */
function adminSaveSweets(token, sweets) {
  const s = auth_(token, ['admin']);
  return withLock_(function () {
    // remember current rates so a missing Rate never wipes one
    const oldRates = {};
    readAll_(SHEETS.SWEETS).forEach(function (r) { oldRates[String(r.SweetName).toLowerCase()] = r.Rate; });

    const seen = {};
    const errors = [];
    const clean = (sweets || []).map(function (x) {
      const name = str_(x.SweetName);
      let rate;
      if (x.Rate === undefined || x.Rate === null) rate = oldRates[name.toLowerCase()];
      else if (String(x.Rate).trim() === '') rate = '';
      else {
        rate = money_(x.Rate);
        if (rate < 0) errors.push(name + ': rate cannot be negative.');
      }
      return { SweetName: name, Rate: (rate === undefined || rate === '' || rate === 0) ? '' : money_(rate), Active: x.Active !== false };
    }).filter(function (x) {
      const k = x.SweetName.toLowerCase();
      if (!k || seen[k]) return false;
      seen[k] = true;
      return true;
    });
    if (errors.length) throw new Error(errors.join('\n'));

    const sh = sheet_(SHEETS.SWEETS);
    if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).clearContent();
    appendObjs_(SHEETS.SWEETS, clean);
    log_('', 'SWEETS_UPDATED', s, '', '', clean.length + ' sweets');
    return adminGetData(token);
  });
}

function adminSaveSettings(token, settings) {
  const s = auth_(token, ['admin']);
  const editable = [
    'COMPANY_NAME', 'ORDER_PREFIX', 'ALLOW_PARTIAL_PRODUCTION_FINISH', 'ALLOW_PARTIAL_PACKING_FINISH',
    'DRIVE_FOLDER_ID', 'SHARE_IMAGES_BY_LINK',
    'CURRENCY_SYMBOL', 'DEFAULT_GST_PERCENT', 'REQUIRE_ITEM_RATE',
    'INVOICE_FOLDER_ID', 'SHARE_INVOICES_BY_LINK'
  ];
  return withLock_(function () {
    Object.keys(settings || {}).forEach(function (k) {
      if (editable.indexOf(k) < 0) return;
      let v = typeof settings[k] === 'boolean' ? settings[k] : str_(settings[k]);
      if (k === 'ORDER_PREFIX' && !/^[A-Za-z0-9]{1,8}$/.test(v)) throw new Error('Order prefix: 1-8 letters/numbers.');
      if (k === 'DEFAULT_GST_PERCENT') {
        const n = parseFloat(v);
        if (isNaN(n) || n < 0 || n > 28) throw new Error('Default GST % must be between 0 and 28.');
        v = num_(n); // store as a number, not text
      }
      if (k === 'CURRENCY_SYMBOL') v = v.slice(0, 4) || '₹';
      setSetting_(k, v);
    });
    log_('', 'SETTINGS_UPDATED', s, '', '', JSON.stringify(settings));
    return adminGetData(token);
  });
}

/** Admin override: move an order to any status (e.g. send back to production) or cancel it. */
function adminSetStatus(token, orderId, status, reason) {
  const s = auth_(token, ['admin']);
  if (STATUS_ORDER.indexOf(status) < 0) throw new Error('Invalid status.');
  return withLock_(function () {
    const o = findOrder_(orderId);
    if (!o) throw new Error('Order not found.');
    updateRow_(SHEETS.ORDERS, o._row, { Status: status, UpdatedAt: now_() });
    log_(String(o.OrderID), status === STATUS.CANCELLED ? 'CANCELLED' : 'STATUS_OVERRIDE', s, o.Status, status, str_(reason));
    return { orderId: String(o.OrderID), status: status };
  });
}

/** Sales (before production accepts) or admin can cancel an order. */
function cancelOrder(token, orderId, reason) {
  const s = auth_(token, ['sales']);
  return withLock_(function () {
    const o = findOrder_(orderId);
    if (!o) throw new Error('Order not found.');
    if (s.role !== 'admin' && o.Status !== STATUS.NEW) throw new Error('Only orders not yet accepted by production can be cancelled by sales.');
    if (s.role !== 'admin' && invoiceStatus_(o) !== INVOICE.PENDING) throw new Error('Accounts has already invoiced this order. Ask accounts / admin to cancel it.');
    if (o.Status === STATUS.DELIVERED || o.Status === STATUS.CANCELLED) throw new Error('Order is already ' + o.Status + '.');
    if (!str_(reason)) throw new Error('Please give a reason for cancelling.');
    updateRow_(SHEETS.ORDERS, o._row, { Status: STATUS.CANCELLED, UpdatedAt: now_() });
    log_(String(o.OrderID), 'CANCELLED', s, o.Status, STATUS.CANCELLED, str_(reason));
    return { orderId: String(o.OrderID), status: STATUS.CANCELLED };
  });
}