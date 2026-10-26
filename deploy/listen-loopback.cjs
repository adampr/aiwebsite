// aicompany-template: listen-loopback.cjs.tpl@7abbc909ef2951477035290f80e7a8e1bf3c1a9bc0605c1cea27794ff881e9e0
/* eslint-disable @typescript-eslint/no-require-imports */
// Loopback-only listen for the brain processes (v1.174.0, architecture.md §9.1).
//
// WHY. brain-api and skills-host call `httpServer.listen(port)` / `app.listen(port)`
// with NO host, which binds every interface, while both print
// "listening on http://127.0.0.1:<port>" whatever they bound. Measured 2026-10-23
// on aiwebsite, roleplay, itsupportchicago and topmspnearme: `*:3211` and `*:3213`
// (S2 IR item 7.2, refute N12). The brain SDK has no host knob, so the module
// loads this file into those two pm2 apps through the ecosystem's
// `NODE_OPTIONS=--require <this file>`. NODE_OPTIONS (not node_args) because the
// pm2 script is tsx's CLI, which re-spawns the real server as a CHILD node
// process: node_args reach only the tsx parent, the environment reaches both.
//
// WHAT. Every TCP listen() whose host is absent or a wildcard ("", 0.0.0.0, ::)
// is pinned to 127.0.0.1. A caller that names a specific address keeps it (the
// posture check, deploy/posture-check.sh, fails on any non-loopback listener on
// the module's ports, so a deliberate choice is visible, never silent). Pipe
// paths, handles and file descriptors are untouched. Nothing in packages/brain
// is modified; the same technique has run in production on xlant.ai since
// 2026-09-06 (xlantai deploy/interim/port-shim.cjs, XLANTAI_BIND_HOST).
//
// It is rendered into deploy/ (so the deploy's `node --check deploy/*.cjs` gate
// parses it and `render.mjs --check` proves it is this template's output), and
// setup-vm installs it ROOT-OWNED (0644) as /usr/local/lib/aiwebsite/listen-loopback.cjs
// BEFORE the cutover's `pm2 startOrReload`. NODE_OPTIONS names that copy: the
// app account cannot rewrite a preload every brain start loads, and a module
// rollback (rsync --delete removes the tree file, pm2 keeps the stale env key)
// can never point node at a missing file. A missing file would make node
// refuse to start the brain: loud, by design.
"use strict";
const net = require("node:net");

const LOOPBACK = "127.0.0.1";
const ARMED = Symbol.for("aicompany.listen-loopback");
const WILDCARDS = new Set(["", "0.0.0.0", "::", "[::]", "::0", "0:0:0:0:0:0:0:0"]);

function isWildcard(host) {
  return typeof host === "string" && WILDCARDS.has(host.trim().toLowerCase());
}

// Node's own rule (net.js isPipeName): a string that is not a number is a pipe
// path; a numeric string is a port.
function isPort(v) {
  return typeof v === "number" || (typeof v === "string" && /^\s*\d+\s*$/.test(v));
}

// Rewrites `args` IN PLACE when the listen would bind every interface.
// Returns the port it pinned (as a string), or null when it left args alone.
function pin(args) {
  const a0 = args[0];
  // listen() / listen(cb): an ephemeral port on every interface.
  if (args.length === 0 || typeof a0 === "function") {
    args.unshift(0, LOOPBACK);
    return "0";
  }
  // listen(port[, host][, backlog][, cb]). A string at index 1 is a host the
  // caller chose; anything else (undefined, a backlog, a callback) means none.
  if (isPort(a0) || a0 === undefined || a0 === null) {
    if (a0 === undefined || a0 === null) args[0] = 0;
    if (typeof args[1] === "string") {
      if (!isWildcard(args[1])) return null;
      args[1] = LOOPBACK;
    } else {
      args.splice(1, 0, LOOPBACK);
    }
    return String(args[0]).trim();
  }
  // listen(options[, cb]): the TCP options form (a port, no pipe path).
  if (typeof a0 === "object" && !Array.isArray(a0) && a0.port !== undefined && a0.path === undefined) {
    if (a0.host !== undefined && !isWildcard(a0.host)) return null;
    args[0] = { ...a0, host: LOOPBACK };
    return String(a0.port);
  }
  return null;
}

if (!net.Server.prototype[ARMED]) {
  const original = net.Server.prototype.listen;
  net.Server.prototype.listen = function listen(...args) {
    const port = pin(args);
    if (port !== null) {
      console.log('[listen-loopback] pid ' + process.pid + ' listen :' + port + ' pinned to ' + LOOPBACK);
    }
    return original.apply(this, args);
  };
  Object.defineProperty(net.Server.prototype, ARMED, { value: true });
}

module.exports = { pin, isWildcard, LOOPBACK };
