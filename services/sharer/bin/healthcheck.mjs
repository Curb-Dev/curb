// The Docker HEALTHCHECK: exit 0 when the loop's /healthz answers 200.
// No shell, no curl in the image: plain Node.
import http from 'node:http';

const sock = process.env.CURB_SHARER_HEALTH_SOCKET;
const port = Number(process.env.CURB_SHARER_HEALTH_PORT || 8080);
const opts = sock ? { socketPath: sock, path: '/healthz', timeout: 4000 } : { host: '127.0.0.1', port, path: '/healthz', timeout: 4000 };
const req = http.request(opts, (res) => {
  res.resume();
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on('error', () => process.exit(1));
req.on('timeout', () => {
  req.destroy();
  process.exit(1);
});
req.end();
