/**
 * Auth.gs — username/password login with server-side sessions.
 * Sessions live in CacheService (sliding 6 hour expiry, refreshed on every call).
 * Every server function the UI calls takes the session token as its first argument.
 */

const SESSION_SECONDS = 6 * 60 * 60; // CacheService maximum

function hashPassword_(password, salt) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + password, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function findUser_(username) {
  const u = str_(username).toLowerCase();
  return readAll_(SHEETS.USERS).filter(function (r) { return String(r.Username).toLowerCase() === u; })[0] || null;
}

function createUserRecord_(username, fullName, role, password) {
  const salt = Utilities.getUuid();
  appendObj_(SHEETS.USERS, {
    Username: str_(username).toLowerCase(), FullName: fullName, Role: role,
    PasswordHash: hashPassword_(password, salt), Salt: salt,
    Active: true, CreatedAt: now_(), LastLogin: ''
  });
}

/** Called from the login screen. */
function login(username, password) {
  const u = findUser_(username);
  if (!u || !isTrue_(u.Active) || hashPassword_(String(password || ''), String(u.Salt)) !== u.PasswordHash) {
    Utilities.sleep(800); // slow down guessing
    throw new Error('Invalid username or password.');
  }
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  const session = { username: String(u.Username), name: String(u.FullName || u.Username), role: String(u.Role) };
  CacheService.getScriptCache().put('sess_' + token, JSON.stringify(session), SESSION_SECONDS);
  updateRow_(SHEETS.USERS, u._row, { LastLogin: now_() });
  log_('', 'LOGIN', session, '', '', '');
  return { token: token, user: session };
}

function logout(token) {
  CacheService.getScriptCache().remove('sess_' + token);
  return true;
}

/**
 * Validates the token and (optionally) the role. Admin passes every role check.
 * Re-reads the user row so that disabling a user or changing a role takes effect immediately.
 */
function auth_(token, allowedRoles) {
  if (!token) throw new Error('SESSION_EXPIRED');
  const cache = CacheService.getScriptCache();
  const raw = cache.get('sess_' + token);
  if (!raw) throw new Error('SESSION_EXPIRED');
  const s = JSON.parse(raw);
  const u = findUser_(s.username);
  if (!u || !isTrue_(u.Active)) { cache.remove('sess_' + token); throw new Error('SESSION_EXPIRED'); }
  s.role = String(u.Role);
  s.name = String(u.FullName || u.Username);
  cache.put('sess_' + token, JSON.stringify(s), SESSION_SECONDS);
  if (allowedRoles && s.role !== 'admin' && allowedRoles.indexOf(s.role) < 0) {
    throw new Error('Your role (' + s.role + ') is not allowed to do this.');
  }
  return s;
}

/** Lets any logged-in user change their own password. */
function changePassword(token, oldPassword, newPassword) {
  const s = auth_(token);
  if (!newPassword || String(newPassword).length < 6) throw new Error('New password must be at least 6 characters.');
  return withLock_(function () {
    const u = findUser_(s.username);
    if (hashPassword_(String(oldPassword || ''), String(u.Salt)) !== u.PasswordHash) throw new Error('Current password is wrong.');
    const salt = Utilities.getUuid();
    updateRow_(SHEETS.USERS, u._row, { PasswordHash: hashPassword_(String(newPassword), salt), Salt: salt });
    log_('', 'CHANGE_PASSWORD', s, '', '', '');
    return true;
  });
}
