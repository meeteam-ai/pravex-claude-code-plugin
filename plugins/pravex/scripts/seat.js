'use strict';
/**
 * Whether the person on this machine holds a Pravex seat, and what to tell them.
 *
 * A workspace pays per seat, and only members holding an active one are tracked
 * (pravex-backend ADR 0014). Someone without a seat must notice Pravex only by
 * being told, once, that the session isn't tracked. Nothing is blocked or slowed
 * down beyond the start check, and every failure here fails open. The server
 * checks the seat on ingest anyway, so a report it refuses costs one request,
 * while a report skipped by mistake loses a session.
 *
 *   ~/.pravex/seat.json              { status, message, workspace, checkedAt }: the last answer
 *   ~/.pravex/seat-shown/<session>   what that session last told its user: active | none | suspended
 *
 * The cache is refreshed at SessionStart (`GET /api/me/seat`, 1.5 s at most) and
 * by every ingest response. `statusline.js` reads the same file without
 * requiring this one, because it runs from a copy away from the plugin. Change
 * both together.
 *
 * Standard library only, like everything else in this plugin.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const CONFIG_DIR = path.join(os.homedir(), '.pravex');
const SEAT_FILE = path.join(CONFIG_DIR, 'seat.json');
/**
 * One small file per session, holding the seat state its user was last told.
 * A file per session for the same reason as the incognito markers: `Stop` hooks
 * of several sessions can run at once, and rewriting a shared map loses updates.
 */
const SHOWN_DIR = path.join(CONFIG_DIR, 'seat-shown');
/** Long enough for any resumed session, the sweep and a spooled replay. */
const SHOWN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const STATUSES = ['active', 'suspended', 'none'];
/**
 * The longest a session start waits for the server.
 *
 * ⚠️ The only network call a session waits on. The start line depends on the
 * answer, so it cannot run in the background like the update check. Past this,
 * the cache answers and the session goes on.
 */
const START_TIMEOUT_MS = 1500;
/**
 * While the cache says there is no seat, `Stop` and `SessionEnd` send nothing
 * and trust the cache for this long. After that they ask the server again, so
 * a seat given mid-session takes effect within one more turn.
 */
const RECHECK_AFTER_MS = 5 * 60 * 1000;

const PLUGIN_VERSION = (() => {
  try {
    return require('../.claude-plugin/plugin.json').version;
  } catch {
    return 'unknown';
  }
})();

const isStatus = (status) => STATUSES.includes(status);

function readSeat() {
  try {
    const cached = JSON.parse(fs.readFileSync(SEAT_FILE, 'utf8'));
    return cached && isStatus(cached.status) ? cached : null;
  } catch {
    return null;
  }
}

/**
 * Record an answer and return what was stored.
 *
 * An ingest response does not name the workspace, so the name `/api/me/seat`
 * gave last is kept. The change messages need it.
 */
function writeSeat(seat, now = Date.now()) {
  const previous = readSeat();
  const next = {
    status: seat.status,
    message: seat.status === 'active' ? null : seat.message || null,
    workspace: seat.workspace || (previous && previous.workspace) || null,
    checkedAt: now,
  };
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(SEAT_FILE, JSON.stringify(next), { mode: 0o600 });
  } catch {
    /* a cache; the next answer writes it again */
  }
  return next;
}

/** After a login: the previous credential's workspace must not answer for the new one. */
function forgetSeat() {
  try {
    fs.unlinkSync(SEAT_FILE);
  } catch {
    /* nothing cached */
  }
}

/** The cache says, and said recently, that there is no seat. */
function noSeatRecently(seat, now = Date.now()) {
  if (!seat || seat.status === 'active') return false;
  const age = now - seat.checkedAt;
  // A `checkedAt` in the future (a clock moved) counts as stale, not as fresh forever.
  return typeof seat.checkedAt === 'number' && age >= 0 && age < RECHECK_AFTER_MS;
}

function workspaceOf(value) {
  if (!value || typeof value !== 'object' || typeof value.name !== 'string' || !value.name.trim()) return null;
  return { id: typeof value.id === 'string' ? value.id : null, name: value.name.trim() };
}

/**
 * What `GET /api/me/seat` answered, as `{ status, message, workspace }`.
 *
 * A 404 is a server from before seats, where everybody is tracked. It comes back
 * as active and marked `legacy`, so `/pravex:status` can say nothing about seats.
 * Anything else that is not a seat (5xx, a revoked key, an HTML error page) is
 * null: the server could not say, and the caller falls back to the cache.
 */
function parseSeatResponse(statusCode, body) {
  if (statusCode === 404) return { status: 'active', message: null, workspace: null, legacy: true };
  if (statusCode !== 200) return null;
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  // The API wraps every response in `{ status, result }`; read it the way `login.js` does.
  const result = json && json.result !== undefined ? json.result : json;
  if (!result || !isStatus(result.status)) return null;
  return {
    status: result.status,
    message: typeof result.message === 'string' && result.message ? result.message : null,
    workspace: workspaceOf(result.workspace),
  };
}

/**
 * Ask the server. Never rejects. Resolves the seat, or null when it could not tell.
 *
 * `timeoutMs` bounds the whole exchange, not just an idle socket. Node's own
 * `timeout` option only fires when the socket goes quiet, so a server dripping a
 * byte a second could hold a session start for as long as it liked.
 */
function fetchSeat(apiHost, apiKey, { timeoutMs = START_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let req;
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      done(null);
      if (req) req.destroy();
    }, timeoutMs);
    try {
      const url = new URL(apiHost);
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/me/seat`;
      const client = url.protocol === 'https:' ? https : http;
      req = client.request(
        url,
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'User-Agent': `pravex-claude-code-plugin/${PLUGIN_VERSION}`,
          },
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (data += c));
          res.on('end', () => done(parseSeatResponse(res.statusCode, data)));
          res.on('error', () => done(null));
        },
      );
      req.on('error', () => done(null));
      req.end();
    } catch {
      done(null);
    }
  });
}

/**
 * What an ingest response (`POST /api/sessions`) says about the seat, or null
 * when it says nothing.
 *
 * `tracked: false` comes back as a 200 with nothing stored. A server from before
 * seats has no `tracked` at all, and that is not news about the seat.
 */
function seatFromIngest(body) {
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const result = json && typeof json === 'object' && json.result !== undefined ? json.result : json;
  if (!result || typeof result !== 'object') return null;
  if (result.tracked === true) return { status: 'active', message: null };
  if (result.tracked === false) {
    return {
      status: result.seat === 'suspended' ? 'suspended' : 'none',
      message: typeof result.message === 'string' && result.message ? result.message : null,
    };
  }
  return null;
}

/**
 * At SessionStart: ask the server, and fall back to the cache when it does not
 * answer in time. Resolves `{ seat, fresh }`. `seat` is null when neither knows.
 */
async function atStart(apiHost, apiKey, { now = Date.now(), timeoutMs = START_TIMEOUT_MS } = {}) {
  const answer = await fetchSeat(apiHost, apiKey, { timeoutMs });
  if (answer) return { seat: writeSeat(answer, now), fresh: true };
  return { seat: readSeat(), fresh: false };
}

/**
 * Whether a report should go, judged from the cache: `{ send, seat, rechecked }`.
 *
 * Sends when there is no cache, when the seat is active, and when a re-check
 * fails, because the server enforces the seat on ingest anyway. Holds a report
 * back only while the cache says, recently, that there is no seat. Once the
 * cache is older than `RECHECK_AFTER_MS` the server is asked again first.
 */
async function gate(apiHost, apiKey, { now = Date.now(), timeoutMs = START_TIMEOUT_MS } = {}) {
  const cached = readSeat();
  if (!cached || cached.status === 'active') return { send: true, seat: cached, rechecked: false };
  if (noSeatRecently(cached, now)) return { send: false, seat: cached, rechecked: false };
  const answer = await fetchSeat(apiHost, apiKey, { timeoutMs });
  if (!answer) return { send: true, seat: cached, rechecked: false };
  const seat = writeSeat(answer, now);
  return { send: seat.status === 'active', seat, rechecked: true };
}

function nameOf(seat) {
  return (seat && seat.workspace && seat.workspace.name) || '';
}

/** `in Northwind`, or nothing at all when the name is unknown. "your seat in your workspace" reads worse than no name. */
const inWorkspace = (name) => (name ? ` in ${name}` : '');

/**
 * The line a session opens with when it is not tracked. Uses the server's own
 * words when it sent them, and builds the same sentence when it did not.
 */
function notTrackedMessage(seat) {
  if (!seat || seat.status === 'active') return null;
  if (seat.message) return seat.message;
  const where = inWorkspace(nameOf(seat));
  if (seat.status === 'suspended') {
    return `Pravex: your seat${where} is paused, so this session isn't tracked. A workspace admin can restore it.`;
  }
  return `Pravex: you don't have a seat${where}, so this session isn't tracked. Ask a workspace admin to assign you one.`;
}

/**
 * Said once, on the `Stop` after the seat changed under a running session.
 * From one untracked state to the other (none and paused) says nothing, because
 * the session was not tracked before and still is not.
 */
function changeMessage(from, to, name) {
  const where = inWorkspace(name);
  if (from === 'active' && to === 'suspended') return `Pravex: your seat${where} was paused, so the rest of this session isn't tracked.`;
  if (from === 'active' && to === 'none') return `Pravex: your seat${where} was removed, so the rest of this session isn't tracked.`;
  if (from !== 'active' && to === 'active') return `Pravex: you now have a seat${where}. This session is tracked from here on.`;
  return null;
}

/** Session ids are UUIDs; anything else must not become a path segment. */
function shownMarker(sessionId) {
  const safe = String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '');
  return safe ? path.join(SHOWN_DIR, safe) : null;
}

function readShown(sessionId) {
  const marker = shownMarker(sessionId);
  if (!marker) return null;
  try {
    const status = fs.readFileSync(marker, 'utf8').trim();
    return isStatus(status) ? status : null;
  } catch {
    return null;
  }
}

function writeShown(sessionId, status) {
  const marker = shownMarker(sessionId);
  if (!marker || !isStatus(status)) return;
  try {
    fs.mkdirSync(SHOWN_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(marker, status, { mode: 0o600 });
  } catch {
    /* worst case the change is said again on the next turn */
  }
}

/** The session last told its user it was not tracked. The sweep must never send it later. */
function untrackedSession(sessionId) {
  const shown = readShown(sessionId);
  return shown !== null && shown !== 'active';
}

/**
 * Compare `seat` with what the session last showed, record the new state, and
 * return the one line to say, or null.
 *
 * A session with no record (it started signed out, or under a plugin from before
 * seats, whose start line said "recording") that turns out untracked gets the
 * plain not-tracked line. "Was removed" would be a guess.
 */
function noteSeat(sessionId, seat) {
  if (!sessionId || !seat || !isStatus(seat.status)) return null;
  const shown = readShown(sessionId);
  if (shown === seat.status) return null;
  writeShown(sessionId, seat.status);
  if (shown === null) return seat.status === 'active' ? null : notTrackedMessage(seat);
  return changeMessage(shown, seat.status, nameOf(seat) || nameOf(readSeat()));
}

function pruneShown(now = Date.now()) {
  let entries = [];
  try {
    entries = fs.readdirSync(SHOWN_DIR);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(SHOWN_DIR, entry);
    try {
      if (now - fs.statSync(full).mtimeMs > SHOWN_MAX_AGE_MS) fs.unlinkSync(full);
    } catch {
      /* already gone */
    }
  }
}

/** The seat line `/pravex:status` and `npx @pravex/codex status` print. Null for a server from before seats. */
function statusLine(seat) {
  if (!seat || seat.legacy || !isStatus(seat.status)) return null;
  if (seat.status === 'active') return 'Seat: active. Every session is reported when it ends.';
  if (seat.status === 'suspended') return "Seat: paused. Sessions on this machine aren't tracked until a workspace admin restores it.";
  return "Seat: not assigned. Sessions on this machine aren't tracked until a workspace admin assigns you one.";
}

module.exports = {
  RECHECK_AFTER_MS,
  SEAT_FILE,
  SHOWN_DIR,
  START_TIMEOUT_MS,
  atStart,
  changeMessage,
  fetchSeat,
  forgetSeat,
  gate,
  noSeatRecently,
  notTrackedMessage,
  noteSeat,
  parseSeatResponse,
  pruneShown,
  readSeat,
  readShown,
  seatFromIngest,
  statusLine,
  untrackedSession,
  writeSeat,
  writeShown,
};
