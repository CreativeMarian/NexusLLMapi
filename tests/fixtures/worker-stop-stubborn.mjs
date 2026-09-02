// 顽固 stop 目标 worker：绑定真实端口 + 发心跳（健康），但收到 IPC shutdown 时
// **拒绝退出**（写标记文件），忽略 SIGTERM（POSIX）/ disconnect，事件循环保持存活。
// 用于验证「生产 stop 路径」：IPC 超时 → SIGTERM → （Windows 上 SIGTERM 即强杀 / POSIX 上继续 SIGKILL）→ 端口释放。
import http from 'node:http';
import { writeFileSync } from 'node:fs';

const port = Number(process.env.NEXUS_WORKER_PORT || process.argv[2] || 0);
const marker = process.env.NEXUS_STOP_MARKER || '';
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

process.on('message', (m) => {
  if (m && typeof m === 'object' && m.type === 'shutdown') {
    if (marker) {
      try {
        writeFileSync(marker, 'shutdown-received');
      } catch {
        /* ignore */
      }
    }
    // 故意不退出（模拟收到优雅退出指令后卡住）
  }
});
process.on('SIGTERM', () => {
  /* 拒绝退出（Windows 上为强制终止、handler 不可达） */
});
process.on('disconnect', () => {
  /* 父进程断开也不自退 */
});
setInterval(() => {
  /* 保持事件循环存活 */
}, 1000).unref();
