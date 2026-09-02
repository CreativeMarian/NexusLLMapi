// Hard-hang worker fixture for Supervisor self-healing tests.
// First launch: BINDS the port but NEVER sends heartbeat, NEVER answers HTTP,
// ignores IPC shutdown / SIGTERM / disconnect, keeps event loop alive.
// After being force-killed, next launch becomes a healthy worker
// (decided by a marker file created on the first run).
import http from 'node:http';
import { existsSync, writeFileSync } from 'node:fs';

const port = Number(process.env.NEXUS_WORKER_PORT || 20000);
const marker = process.env.NEXUS_HARD_HANG_MARKER || '';

const isFirstRun = !marker || !existsSync(marker);

if (isFirstRun) {
  // ---- HARD HANG ----
  if (marker) {
    try {
      writeFileSync(marker, 'hung');
    } catch {
      /* ignore */
    }
  }
  const server = http.createServer(() => {
    /* never respond to any request, including /health/live */
  });
  server.listen(port, '127.0.0.1');
  // ignore all lifecycle signals: keep listening forever
  process.on('message', () => {
    /* ignore IPC shutdown */
  });
  process.on('SIGTERM', () => {
    /* ignore */
  });
  process.on('SIGINT', () => {
    /* ignore */
  });
  process.on('disconnect', () => {
    /* ignore: simulate a truly stuck process */
  });
  process.on('uncaughtException', () => {
    /* swallow */
  });
  // keep event loop alive and busy
  setInterval(() => {
    const x = Math.sqrt(Date.now());
    void x;
  }, 50);
} else {
  // ---- HEALTHY ----
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'alive', pid: process.pid }));
  });
  server.on('error', (e) => {
    // eslint-disable-next-line no-console
    console.error('[worker-hard-hang healthy] listen error:', e.message);
  });
  server.listen(port, '127.0.0.1', () => {
    // eslint-disable-next-line no-console
    console.error('[worker-hard-hang healthy] listening on', port);
  });
  if (typeof process.send === 'function') {
    const t = setInterval(() => {
      try {
        process.send({ type: 'heartbeat', pid: process.pid, time: Date.now() });
      } catch {
        /* parent gone */
      }
    }, 400);
    t.unref();
  }
  process.on('message', (m) => {
    if (m && typeof m === 'object' && m.type === 'shutdown') {
      try {
        server.close();
      } catch {
        /* ignore */
      }
      process.exit(0);
    }
  });
  process.on('SIGTERM', () => {
    process.exit(0);
  });
  process.on('disconnect', () => {
    process.exit(22);
  });
}
