#!/usr/bin/env node
// aicompany-template: pm2-drift-check.cjs.tpl@f730fa41850ac36f359d5694de1e0c07e5139be6b9702cbfbc5a0c5b0382079b
// aiwebsite pm2 drift check (v1.175.0, architecture.md §9.10; S12 P1 / refuter 2S2).
// READ-ONLY. Prints NAMES only — never an env value.
//
// Why: under the app account the pm2 daemon runs as that account, so code
// running as it can talk to the daemon directly and add an env key
// (NODE_OPTIONS=--require …) or node_args to an app. A deploy never removes
// either: startOrReload EXTENDS an app's env (pm2 God/ActionMethods.js,
// Utility.extend), the ecosystem sets no node_args, and `pm2 save` writes the
// live state into the dump `pm2 resurrect` replays at every boot. So every
// split-mode deploy runs this BEFORE `pm2 save` (live) and after it (dump),
// and so do `app-user.sh verify` and the hourly posture check.
//
// What it compares against the RENDERED ecosystem (deploy/ecosystem.config.cjs,
// evaluated here, so its .env spread gives the site's legitimate key names):
//   - the app set: exactly aiwebsite, brain-api, skills-host; no pm2 module;
//   - per app: the script, args, cwd, interpreter, exec mode; node_args and
//     interpreter_args empty; no uid/gid;
//   - every env key name the process receives (pm2 hands an app its whole
//     pm2_env, top level and .env): the ecosystem's keys, the setup-vm wrapper's
//     clean CLI environment, and pm2's own documented attribute names;
//   - the VALUE of each key that decides what code loads (NODE_OPTIONS, PATH,
//     NODE_PATH, LD_*, HOME …) against the ecosystem/wrapper value — compared,
//     never printed.
//
// Usage: pm2-drift-check.cjs --live -        (pm2 jlist JSON on stdin)
//        pm2-drift-check.cjs --dump <file|-> (a dump.pm2: an array of pm2_env)
// Exit:  0 matches · 1 drift (names above) · 2 the check could not run.
'use strict';
const fs = require('fs');
const path = require('path');

const APP_DIR = '/var/www/aiwebsite';
const SLUG = 'aiwebsite';
const APP_USER = 'aiwebsite';
const TOOLCHAIN_PREFIX = '';
const ECOSYSTEM = path.join(APP_DIR, 'deploy', 'ecosystem.config.cjs');
const APP_HOME = '/home/' + APP_USER;
const BASE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

// The CLI environment setup-vm's pm2 wrapper and app-user.sh hand pm2
// (`env -i` + exactly these), which pm2 merges into every app it starts.
const WRAPPER_ENV = {
  HOME: APP_HOME,
  PM2_HOME: APP_HOME + '/.pm2',
  PATH: (TOOLCHAIN_PREFIX ? TOOLCHAIN_PREFIX + ':' : '') + BASE_PATH,
  LANG: 'C.UTF-8',
  NPM_CONFIG_USERCONFIG: '/etc/' + SLUG + '/npmrc-empty',
};
// Keys the pm2 7.0 CLI itself sets in the environment it passes on.
const PM2_CLI_ENV = ['PM2_USAGE', 'PM2_JSON_PROCESSING', 'PM2_PROGRAMMATIC', 'NODE_APP_INSTANCE'];
// pm2 7.0.3 also sets PWD to the app's cwd when the CLI environment has none
// (measured on aiwebsite 2026-10-26, the first split start under env -i: top
// level and .env, every app). Allowed by name ONLY with a value exactly equal
// to that app's configured cwd; any other value is drift. Absent is fine (it is
// not a code-path key, so the missing-key rule does not apply) (v1.175.1).
const PM2_CWD_ENV = 'PWD';
// pm2's own attribute names (pm2_env top level). Measured on pm2 7.0.3 (jlist,
// 2026-10-26) plus pm2's documented ecosystem attributes. None of these loads
// code except the ones compared by value below; an UNKNOWN name fails closed
// (re-measure after a pm2 upgrade: MIGRATIONS v1.175.0).
const PM2_META = new Set([
  '_tree_pids', 'append_env_to_name', 'args', 'automation', 'autorestart', 'autostart',
  'axm_actions', 'axm_dynamic', 'axm_monitor', 'axm_options', 'combine_logs', 'created_at',
  'cron_restart', 'cwd', 'deep_monitoring', 'disable_trace', 'env', 'error_file',
  'exec_interpreter', 'exec_mode', 'exit_code', 'exp_backoff_restart_delay', 'filter_env',
  'force', 'ignore_watch', 'increment_var', 'instance_var', 'instances', 'interpreter',
  'interpreter_args', 'kill_retry_time', 'kill_timeout', 'km_link', 'listen_timeout',
  'log_date_format', 'log_file', 'log_type', 'max_memory_restart', 'max_restarts',
  'merge_logs', 'min_uptime', 'name', 'namespace', 'node_args', 'node_version', 'out_file',
  'pid_file', 'pm_cwd', 'pm_err_log_path', 'pm_exec_path', 'pm_id', 'pm_out_log_path',
  'pm_pid_path', 'pm_uptime', 'pmx', 'post_update', 'prev_restart_delay', 'restart_delay',
  'restart_time', 'script', 'shutdown_with_message', 'source_map_support', 'status',
  'stop_exit_codes', 'time', 'trace', 'treekill', 'unique_id', 'unstable_restarts',
  'username', 'version', 'vizion', 'vizion_running', 'wait_ready', 'watch',
  'watch_options', 'windowsHide',
]);
// Keys whose value decides what code a process loads or where it runs it.
const CODE_PATH_KEYS = [
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_REPL_EXTERNAL_MODULE', 'PATH', 'HOME', 'PM2_HOME',
  'NPM_CONFIG_USERCONFIG', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'BASH_ENV', 'ENV',
];
const MUST_BE_ABSENT = ['uid', 'gid', 'pmx_module'];

function usage(msg) {
  if (msg) console.error('pm2-drift-check: ' + msg);
  console.error('usage: pm2-drift-check.cjs --live - | --dump <file|->');
  process.exit(2);
}
function safeName(k) {
  return String(k).replace(/[^\x21-\x7e]/g, '?').slice(0, 64);
}
function readInput(src) {
  try {
    return src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8');
  } catch (e) {
    usage('cannot read ' + (src === '-' ? 'stdin' : src) + ': ' + e.code);
  }
}
function whichNode(p) {
  for (const d of p.split(':')) {
    if (!d) continue;
    const f = path.join(d, 'node');
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* next */ }
  }
  return null;
}
function real(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}
function argList(a) {
  if (a == null || a === '') return [];
  if (Array.isArray(a)) return a.map(String);
  return String(a).split(/\s+/).filter(Boolean);
}

function expectedApps() {
  let eco;
  try {
    eco = require(ECOSYSTEM);
  } catch (e) {
    usage('cannot evaluate ' + ECOSYSTEM + ': ' + (e && e.code ? e.code : 'error'));
  }
  if (!eco || !Array.isArray(eco.apps)) usage(ECOSYSTEM + ' exports no apps array');
  const node = whichNode(WRAPPER_ENV.PATH);
  const out = new Map();
  for (const a of eco.apps) {
    const cwd = a.cwd || APP_DIR;
    const env = {};
    for (const [k, v] of Object.entries(a.env || {})) env[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
    out.set(a.name, {
      name: a.name,
      cwd,
      script: path.resolve(cwd, a.script),
      args: argList(a.args),
      interpreter: a.interpreter || node,
      env,
      optionKeys: Object.keys(a).filter((k) => k !== 'env'),
    });
  }
  return out;
}

function checkOne(spec, e, label, findings) {
  const f = (what) => findings.push('DRIFT ' + label + ': ' + what);
  if (e.pmx_module) f('is a pm2 MODULE — a module runs inside the daemon from ' + APP_HOME + '/.pm2/modules, which the app account can rewrite (pm2 uninstall it through the wrapper)');
  if (e.pm_exec_path !== spec.script) f('script differs from the rendered ecosystem');
  if (JSON.stringify(argList(e.args)) !== JSON.stringify(spec.args)) f('args differ from the rendered ecosystem');
  if (e.pm_cwd !== spec.cwd) f('cwd differs from the rendered ecosystem');
  if (!(e.exec_interpreter === spec.interpreter || real(e.exec_interpreter || '') === real(spec.interpreter || ''))) f('interpreter differs from the rendered ecosystem');
  if (argList(e.node_args).length > 0) f('node_args is not empty');
  if (argList(e.interpreter_args).length > 0) f('interpreter_args is not empty');
  // filter_env strips env keys from the child pm2 launches: set, it could drop
  // the brain's NODE_OPTIONS (the only loopback pin) without adding a name (refuter S1).
  if (e.filter_env != null && e.filter_env !== false && !(Array.isArray(e.filter_env) && e.filter_env.length === 0))
    f('filter_env is set — it can strip a code-loading env key (e.g. NODE_OPTIONS) the ecosystem requires');
  if (e.exec_mode && e.exec_mode !== 'fork_mode') f('exec_mode is not fork_mode');
  for (const k of MUST_BE_ABSENT) if (k !== 'pmx_module' && e[k] != null && e[k] !== '') f(k + ' is set');
  const expectedEnv = { ...WRAPPER_ENV, ...spec.env };
  const allowed = new Set([...Object.keys(spec.env), ...Object.keys(WRAPPER_ENV), ...PM2_CLI_ENV, PM2_CWD_ENV, ...PM2_META, ...spec.optionKeys, spec.name]);
  const extra = new Set();
  for (const k of Object.keys(e)) if (!allowed.has(k)) extra.add(k);
  const subEnv = e.env && typeof e.env === 'object' ? e.env : {};
  for (const k of Object.keys(subEnv)) if (!allowed.has(k)) extra.add(k);
  for (const k of [...extra].sort()) f('env key ' + safeName(k) + ' is not in the rendered ecosystem or the wrapper environment');
  for (const [where, src] of [['', e], ['env.', subEnv]]) {
    if (PM2_CWD_ENV in src && String(src[PM2_CWD_ENV]) !== spec.cwd)
      f('value of ' + where + PM2_CWD_ENV + " is not the app's cwd (value not printed)");
  }
  for (const k of CODE_PATH_KEYS) {
    if (!(k in expectedEnv)) continue; // not set for this app: an unexpected name is reported above
    // An EXPECTED key that is gone (deleted, or stripped) is drift too (refuter S1).
    if (!(k in e) && !(k in subEnv)) {
      f('value of ' + k + ' is MISSING from the live env but the ecosystem/wrapper sets it (stripped?)');
      continue;
    }
    for (const [where, src] of [['', e], ['env.', subEnv]]) {
      if (!(k in src)) continue;
      if (String(src[k]) !== expectedEnv[k]) f('value of ' + where + k + ' differs from the rendered ecosystem/wrapper (value not printed)');
    }
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length !== 2 || (argv[0] !== '--live' && argv[0] !== '--dump')) usage();
  if (!APP_USER) usage('APP_USER is empty in deploy/site-deploy.env — there is no app account to check');
  const mode = argv[0].slice(2);
  let data;
  try {
    data = JSON.parse(readInput(argv[1]));
  } catch {
    usage('the ' + mode + ' input is not JSON');
  }
  if (!Array.isArray(data)) usage('the ' + mode + ' input is not a JSON array');
  const specs = expectedApps();
  const findings = [];
  const seen = new Map();
  for (const item of data) {
    const e = mode === 'live' ? (item && item.pm2_env) || {} : item || {};
    const name = mode === 'live' ? item && item.name : e.name;
    seen.set(name, (seen.get(name) || 0) + 1);
    const spec = specs.get(name);
    if (!spec) {
      findings.push('DRIFT app ' + safeName(name) + ' is not in the rendered ecosystem' + (e.pmx_module ? ' (a pm2 module)' : ''));
      continue;
    }
    checkOne(spec, e, safeName(name), findings);
  }
  for (const name of specs.keys()) {
    const n = seen.get(name) || 0;
    if (n === 0) findings.push('DRIFT app ' + name + ' is missing from the ' + mode + ' list');
    if (n > 1) findings.push('DRIFT app ' + name + ' appears ' + n + ' times');
  }
  for (const l of findings) console.log(l);
  if (findings.length) {
    console.log('pm2-drift-check: ' + findings.length + ' finding(s) in the ' + mode + ' pm2 state of ' + SLUG + ' (names only). Repair: bash deploy/app-user.sh pm2 delete <app>, then bash deploy/app-user.sh pm2 startOrReload deploy/ecosystem.config.cjs --only <app> --update-env, then this check again; a module: bash deploy/app-user.sh pm2 uninstall <name>.');
    process.exit(1);
  }
  console.log('pm2-drift-check: the ' + mode + ' pm2 state of ' + SLUG + ' matches the rendered ecosystem (' + specs.size + ' apps)');
}

main();
