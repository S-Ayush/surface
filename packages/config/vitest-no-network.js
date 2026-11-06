// Unit tests never reach the network or third-party services (CLAUDE.md, Testing).
// Loaded by every `surfaceVitest()` config. Connections to the test's own machine
// (loopback, Unix sockets) stay allowed, e.g. an in-process server on port 0;
// any other TCP or TLS connection fails. Real services belong in `*.int.test.ts`.
// This sees only sockets opened by the test process: not DNS lookups, UDP or
// child processes.
import net from 'node:net';

const PATCHED = Symbol.for('surface.vitestNoNetwork');

/** This machine's addresses. BlockList also matches IPv4-mapped and long IPv6 forms. */
const local = new net.BlockList();
local.addSubnet('127.0.0.0', 8, 'ipv4');
local.addAddress('0.0.0.0', 'ipv4'); // what `listen(0)` reports; connecting reaches this machine
local.addAddress('::1', 'ipv6');
local.addAddress('::', 'ipv6');

function isLocal(host) {
  const name = host.toLowerCase();
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  const ip = name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name;
  const family = net.isIP(ip);
  // A hostname other than localhost is never local: it would go to DNS first.
  if (family === 0) return false;
  return local.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

/** The TCP host a `connect()` call targets, or undefined for local IPC paths. */
function tcpHost(args) {
  // net.connect() and http agents pass their normalised arguments as one array.
  const [first, second] = Array.isArray(args[0]) ? args[0] : args;
  if (first !== null && typeof first === 'object') {
    if (typeof first.path === 'string') return undefined;
    return String(first.host ?? 'localhost');
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return undefined; // a socket path
  return typeof second === 'string' ? second : 'localhost';
}

const original = net.Socket.prototype.connect;

// Setup files can run more than once per process (`isolate: false`): patch once.
if (!original[PATCHED]) {
  const guarded = function connect(...args) {
    const host = tcpHost(args);
    if (host === undefined || isLocal(host)) return original.apply(this, args);
    const error = new Error(
      `Unit tests must not use the network (tried to connect to ${host}). ` +
        'Mock the client or use a fake; tests against real services belong in *.int.test.ts.',
    );
    error.code = 'ERR_UNIT_TEST_NETWORK';
    // Fail the way a refused connection does (an 'error' event, not a throw), so
    // clients such as pg and undici clean up their own timers and reject normally.
    process.nextTick(() => this.destroy(error));
    return this;
  };
  guarded[PATCHED] = true;
  net.Socket.prototype.connect = guarded;
}
