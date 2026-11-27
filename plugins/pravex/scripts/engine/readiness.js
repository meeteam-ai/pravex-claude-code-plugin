'use strict';
/**
 * Whether a repository's checks can run at all in a run's own clone, and what they need from the machine to do so.
 *
 * A check that fails because the code is wrong is work for an agent. A check that fails before it tests anything (a
 * database it cannot reach, a variable nobody set, no test files found) is not: rebuilding the code does not change it,
 * and every round spent on it is money for nothing. This tells the two apart from the output, so the engine can stop and
 * say what is missing instead.
 *
 * What a repository needs is said in `.pravex/project.json`, which agents cannot change:
 *
 *   { "checks": ["pnpm test"], "setup": ["docker compose up -d db"], "env": ["TEST_DATABASE_URL"] }
 *
 * The values never go in the repository. They are read from `~/.pravex/env/<owner>__<repo>.env` on the machine (a person
 * writes it; agents cannot read `~/.pravex`) or from the environment the runner was started with, and they are handed to
 * the checks the engine runs, never to an agent.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { PLAIN } = require('./checks');

/**
 * Output that says the check never got to test anything. Ordered from most to least telling: the first sign found is the line shown
 * to a person, so a missing variable wins over the "no test files found" it causes. A test that imports a module the work has not written yet is a real failure, so "Cannot find module"
 * is deliberately not here.
 */
const SIGNS = [
  // A validated configuration (zod and the like) that refuses to start: "Variables de entorno inválidas: SESSION_SECRET: …".
  /\b[A-Z][A-Z0-9_]{2,}: (?:Invalid input: )?expected \w+, received undefined/,
  /\b[A-Z][A-Z0-9_]{2,}: Required\b/,
  /Variables de entorno inv[aá]lidas|Invalid environment variables|Environment variable validation failed/i,
  /(?:Falta|Missing|missing required|Required) (?:la variable |the variable |env(?:ironment)? (?:var(?:iable)?|key) )?`?[A-Z][A-Z0-9_]{2,}`?/,
  /`?[A-Z][A-Z0-9_]{2,}`? (?:is not set|is not defined in (?:the )?env|is required|must be set|no est[aá] definid[ao])/,
  /ECONNREFUSED\s+(?:127\.0\.0\.1|::1|localhost|\[::1\]):\d+/,
  /could not connect to (?:server|database|the database|postgres|mysql|redis)/i,
  /connection (?:to server at .* )?refused/i,
  /database "[^"]+" does not exist/i,
  /role "[^"]+" does not exist/i,
  /password authentication failed for user/i,
  /Can't reach database server/i,
  /getaddrinfo (?:ENOTFOUND|EAI_AGAIN)/,
  /Cannot connect to the Docker daemon/i,
  // The app a browser test needs never started (its own variables or services are missing here).
  /config\.webServer was not able to start/,
  /\bglobal[ -]?setup\b.*(?:error|fail|threw|lanz)/i,
  /errors? during collection/i,
  /No test files found/i,
  /no tests? (?:ran|were found|to run)\b/i,
];

/** The name of the variable the output says is missing, when it names one. */
const MISSING = [
  /\b([A-Z][A-Z0-9_]{2,}): (?:Invalid input: )?(?:expected \w+, received undefined|Required)\b/,
  /(?:Falta|Missing|missing required|Required) (?:la variable |the variable |env(?:ironment)? (?:var(?:iable)?|key) )?`?([A-Z][A-Z0-9_]{2,})`?/,
  /`?([A-Z][A-Z0-9_]{2,})`? (?:is not set|is not defined in (?:the )?env|is required|must be set|no est[aá] definid[ao])/,
];

const strip = (s) => String(s || '').replace(/\u001b\[[0-9;]*m/g, '');

/** Why the output says the check could not run, or null when it ran (and maybe failed for real). */
function envProblem(output) {
  const text = strip(output);
  if (!text.trim()) return null;
  const lines = text.split('\n');
  for (const sign of SIGNS) {
    const line = lines.find((l) => sign.test(l));
    if (!line) continue;
    // Every variable it names, in order, so a person fixes them all at once instead of one per stop.
    const names = [];
    for (const m of MISSING) for (const x of text.matchAll(new RegExp(m.source, 'g'))) if (!names.includes(x[1])) names.push(x[1]);
    // A name cut short in a code frame ("Falta TEST_DATA…") is the longer one said elsewhere, not another variable.
    const whole = names.filter((n) => !names.some((o) => o !== n && o.startsWith(n)));
    return { line: line.trim().slice(0, 300), missing: whole.length ? whole.slice(0, 12).join(', ') : null };
  }
  return null;
}

/** The same problem twice is the same problem: what changes between runs (paths, ports, times, numbers) is left out. */
const problemFp = (command, p) =>
  crypto
    .createHash('sha256')
    .update(`${command}\n${String(p.missing || p.line).replace(/\/[^\s'"]+/g, '<path>').replace(/\d+/g, '0')}`)
    .digest('hex')
    .slice(0, 16);

/** `owner__repo` from a remote address, or from the folder's name when there is no remote. */
function repoKey(origin, top) {
  const m = /[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(String(origin || ''));
  const raw = m ? `${m[1]}__${m[2]}` : path.basename(String(top || 'repo'));
  return raw.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 120) || 'repo';
}

const ENV_DIR = () => path.join(os.homedir(), '.pravex', 'env');
const envFileOf = (key) => path.join(ENV_DIR(), `${key}.env`);

/** `KEY=value` lines; `#` comments, blank lines, `export ` and surrounding quotes are allowed. Anything else is skipped. */
function parseEnv(text) {
  const out = {};
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** What `.pravex/project.json` says, with anything malformed left out. */
function projectConfig(repo) {
  let own = {};
  try {
    own = JSON.parse(fs.readFileSync(path.join(repo, '.pravex', 'project.json'), 'utf8')) || {};
  } catch {
    /* no project file */
  }
  const strings = (x) => (Array.isArray(x) ? x.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim()) : []);
  return { checks: strings(own.checks), setup: strings(own.setup), env: strings(own.env).filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) };
}

/**
 * The variables the checks get, and the ones the project asks for that nobody set: everything in the machine's file for
 * this repository, and the project's names from the runner's own environment when the file does not have them.
 */
function checkEnv({ key, names = [], base = process.env, file } = {}) {
  const where = file || envFileOf(key);
  let own = {};
  try {
    own = parseEnv(fs.readFileSync(where, 'utf8'));
  } catch {
    /* no file on this machine */
  }
  const env = {};
  const missing = [];
  // Everything in the machine's file for this repository: a person or Pravex put it there for these checks.
  Object.assign(env, own);
  for (const k of names) {
    if (env[k] !== undefined) continue;
    if (base[k] !== undefined) env[k] = base[k];
    else missing.push(k);
  }
  return { env, missing, file: where, names: Object.keys(env) };
}

/** Programs a project's own setup may start, on top of the ones a check may: it is written by people, in a file agents cannot change. */
const SETUP_PROGRAMS = new Set(['docker', 'docker-compose', 'podman', 'createdb', 'psql', 'redis-server']);
const NOT_SETUP = /\b(publish|deploy|release|login|logout|adduser|push)\b/;

function setupAllowed(command, programs) {
  const c = String(command || '').trim().replace(/\s+/g, ' ');
  const first = c.split(' ')[0];
  return PLAIN.test(c) && (programs.has(first) || SETUP_PROGRAMS.has(first)) && !NOT_SETUP.test(c) && !c.includes('..') && !/(^| )\//.test(c);
}

/**
 * A requirement that would make the checks run in a clean clone, for a person to start as a flow of its own. Plain words,
 * no secrets: it names the command, what it printed and the variable, never a value.
 */
function fixRequirement({ command, line, missing, locale = 'es' }) {
  if (locale === 'en')
    return [
      `Make \`${command}\` run in a fresh clone of this repository, on a machine that has its own test database, without files that git ignores.`,
      `Today it stops before testing anything: "${line}".`,
      missing ? `It needs ${missing}: read it from the environment and say in the docs which value a test machine needs.` : 'Say in the docs what a test machine needs to run it.',
      'Do not put real secrets or real keys anywhere. Do not change what the tests check.',
      'At the end, list what a person must add to .pravex/project.json ("setup" and "env") and to the machine.',
    ].join(' ');
  return [
    `Haz que \`${command}\` corra en una copia limpia de este repositorio, en una máquina con su propia base de pruebas, sin depender de archivos que git ignora.`,
    `Hoy se detiene antes de probar nada: «${line}».`,
    missing ? `Necesita ${missing}: que se lea del entorno y que la documentación diga qué valor necesita una máquina de pruebas.` : 'Que la documentación diga qué necesita una máquina de pruebas para correrlo.',
    'No pongas secretos ni llaves reales en ninguna parte. No cambies lo que las pruebas comprueban.',
    'Al final, lista lo que una persona debe agregar a .pravex/project.json («setup» y «env») y a la máquina.',
  ].join(' ');
}

// ---------------------------------------------------------------------------
// Preparing by itself: what is not a secret, Pravex fills without asking
// ---------------------------------------------------------------------------

/** Keys of somebody else's service: never invented, never copied. A person gives them, or the work uses a test mode. */
const THIRD_PARTY = /(^|_)(STRIPE|APPLE|APNS|GOOGLE|GCP|FIREBASE|AWS|AZURE|TWILIO|TELNYX|SENDGRID|RESEND|MAILGUN|POSTMARK|SMTP|OPENAI|ANTHROPIC|DEEPSEEK|GITHUB|GITLAB|SLACK|DISCORD|PAYPAL|WOMPI|MERCADOPAGO|PAYU|SENTRY|DATADOG|SEGMENT|AUTH0|CLERK|SUPABASE|OKTA|WALLET|META|FACEBOOK|WHATSAPP|HUBSPOT|SHOPIFY|CLOUDINARY|MAPBOX|ALGOLIA|PUSHER)(_|$)/;
/** Values only this application reads (it signs or hashes with them): any random text works for a test. */
const INTERNAL_SECRET = /(^|_)(SECRET|SALT|PEPPER|SIGNING|HASH|SESSION|JWT|COOKIE|ENCRYPTION|CSRF|PASSWORD|PASSPHRASE|ACCESS_KEY|SECRET_KEY|PRIVATE_KEY|API_KEY|KEY)(_|$)/;
/** A URL that only points at this machine: it carries nothing private, so an example's can be used as is. */
function localUrl(v) {
  try {
    const u = new URL(String(v));
    return ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', 'host.docker.internal'].includes(u.hostname) || u.hostname.endsWith('.localhost') || u.hostname.endsWith('.test');
  } catch {
    return false;
  }
}

/** `.env.example` and its kin, as committed: names and example values, never the real `.env`. */
function readExample(repo) {
  const out = {};
  for (const f of ['.env.example', '.env.sample', '.env.test.example', '.env.template', '.env.dist']) {
    try {
      for (const [k, v] of Object.entries(parseEnv(fs.readFileSync(path.join(repo, f), 'utf8')))) if (!(k in out)) out[k] = v;
    } catch {
      /* not there */
    }
  }
  return out;
}

/**
 * A value for a test, when one can be made without a secret: `{ value, how }`, or null when it needs a person.
 * - `example`: the committed example's value, when it only points at this machine;
 * - `generated`: random text for a value only this application reads (it signs or hashes with it);
 * - `placeholder`: a stand-in that lets the application start (a local storage address, a bucket, a test email).
 * Somebody else's keys are never made up.
 */
function fillValue(name, example) {
  if (example !== undefined && localUrl(example)) return { value: example, how: 'example' };
  if (THIRD_PARTY.test(name)) return null;
  if (INTERNAL_SECRET.test(name)) return { value: crypto.randomBytes(24).toString('hex'), how: 'generated' };
  const storage = /(^|_)(S3|MINIO|STORAGE|BUCKET|R2|SPACES)(_|$)/.test(name);
  if (storage && /(_ENDPOINT|_HOST)$/.test(name)) return { value: 'http://localhost:9000', how: 'placeholder' };
  if (storage && /_URL$/.test(name)) return { value: 'http://localhost:9000/pravex-test', how: 'placeholder' };
  if (/(^|_)BUCKET(_NAME)?$/.test(name)) return { value: 'pravex-test', how: 'placeholder' };
  if (/_REGION$/.test(name)) return { value: 'us-east-1', how: 'placeholder' };
  if (/(^|_)EMAIL(_FROM)?$|^EMAIL_FROM$/.test(name)) return { value: 'pruebas@pravex.invalid', how: 'placeholder' };
  return null;
}

/** Adds lines to the machine's file for this repository, never over a value that is already there. Private to the person. */
function writeMachineEnv(file, entries, now = new Date()) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let have = {};
  try {
    have = parseEnv(fs.readFileSync(file, 'utf8'));
  } catch {
    /* new file */
  }
  const add = entries.filter((e) => have[e.name] === undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(e.name) && !/[\r\n]/.test(e.value));
  if (!add.length) return [];
  const head = `\n# Puesto por Pravex el ${now.toISOString().slice(0, 10)} para las pruebas: valores de prueba (generados, locales o de relleno), nunca secretos reales.\n`;
  fs.appendFileSync(file, head + add.map((e) => `${e.name}=${e.value}`).join('\n') + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return add.map((e) => e.name);
}

/** Images of services a test needs locally (a database, a cache, storage, a mail catcher), as the repository's compose file names them. */
const SERVICE_IMAGE = /(postgres|postgis|mysql|mariadb|mongo|redis|valkey|keydb|memcached|minio|seaweedfs|localstack|azurite|mailpit|mailhog|elasticsearch|opensearch|rabbitmq|nats)/i;

/** The compose file at the root and its local services: `{ file, services }`, or null. A line-based read, enough for `services:`. */
function composeServices(repo) {
  const file = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].find((f) => fs.existsSync(path.join(repo, f)));
  if (!file) return null;
  const lines = fs.readFileSync(path.join(repo, file), 'utf8').split('\n');
  const services = [];
  let inServices = false;
  let current = null;
  for (const line of lines) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    if (inServices && /^\S/.test(line)) inServices = false;
    if (!inServices) continue;
    const name = /^ {2}([A-Za-z0-9][\w.-]*):\s*$/.exec(line);
    if (name) current = name[1];
    const image = /^ {4}image:\s*["']?([^"'\s]+)/.exec(line);
    if (current && image && SERVICE_IMAGE.test(image[1]) && !services.includes(current)) services.push(current);
  }
  return services.length ? { file, services } : null;
}

/** Output that says a service is not answering here, as opposed to a value being missing. */
const NOT_RUNNING = /ECONNREFUSED|could not connect|connection (?:to server at .* )?refused|Can't reach database server|getaddrinfo|Connection refused/i;

module.exports = { THIRD_PARTY, fillValue, readExample, localUrl, writeMachineEnv, composeServices, NOT_RUNNING, SIGNS, envProblem, problemFp, repoKey, envFileOf, parseEnv, projectConfig, checkEnv, setupAllowed, fixRequirement };
