// 绑定真实端口的 worker：监听 NEXUS_WORKER_PORT，提供 /health/live，持续发心跳；
// 收到 IPC shutdown 时优雅关闭服务并退出 0（模拟真实 Worker 的端口释放行为）。
import http from 'node:http';

const port = Number(process.env.NEXUS_WORKER_PORT || process.argv[2] || 0);
let closed = false;
const server = http.createServer((req, res) => {
  if (req.url === '/health/live') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":"alive"}');
    return;
  }
  res.writeHead(200);
  res.end('ok');
});

server.listen(port, '127.0.0.1', () => {
  if (typeof process.send === 'function') {
    const t = setInterval(() => {
      try {
        process.send({ type: 'heartbeat', pid: process.pid, time: Date.now(), ready: true });
      } catch {
        /* parent gone */
      }
    }, 400);
    t.unref();
  }
});

function shutdown() {
  if (closed) return;
  closed = true;
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('message', (m) => {
  if (m && typeof m === 'object' && m.type === 'shutdown') shutdown();
});
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
