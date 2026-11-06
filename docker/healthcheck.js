// Docker HEALTHCHECK (SPEC-004 §5, §8): exit 0 when GET /healthz answers 200.
// Standalone on purpose: it must answer within the 3 s timeout and must not load
// the application or validate its configuration. It is therefore the one place
// outside loadConfig() that reads PORT and HOST (SPEC-004 §5), with the same
// rules: values are trimmed, and blank means unset. The image copies it to /app/bin/.
import http from 'node:http';

const setting = (name) => process.env[name]?.trim() || undefined;
const port = Number(setting('PORT') ?? 3000);
// The server listens on HOST (default all interfaces); loopback reaches it then.
const listen = setting('HOST');
const host = !listen || listen === '0.0.0.0' || listen === '::' ? '127.0.0.1' : listen;

const request = http.get({ host, port, path: '/healthz', timeout: 2_000 }, (response) => {
  response.resume();
  process.exit(response.statusCode === 200 ? 0 : 1);
});
request.on('timeout', () => request.destroy(new Error('timed out')));
request.on('error', () => process.exit(1));
