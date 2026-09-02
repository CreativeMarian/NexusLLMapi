// Slow-start worker fixture: waits NEXUS_SLOW_START_MS (default 30000) before
// sending heartbeat and serving /health/live. Used to verify Supervisor's
// startup grace period does NOT kill a slowly-starting worker.
import http from 'node:http';

const port = Number(process.env.NEXUS_WORKER_PORT || 20000);
const delayMs = Number(process.env.NEXUS_SLOW_START_MS || 30000);

// 等待期保持事件循环存活（ref 的定时器）；就绪后清理
let keepAlive = setInterval(() => {
  /* keep event loop alive during slow start */
}, 1000);

const timer = setTimeout(() => {
  clearInterval(keepAlive);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'alive', pid: process.pid }));
  });
  server.listen(port, '127.0.0.1');
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
      process.exit(0);
    }
  });
  process.on('SIGTERM', () => process.exit(0));
  process.on('disconnect', () => process.exit(22));
}, delayMs);
timer.unref();
