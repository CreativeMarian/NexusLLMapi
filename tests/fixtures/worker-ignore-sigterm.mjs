// 顽固 worker：发心跳；收到 IPC shutdown 时写标记文件但**拒绝退出**（模拟收到优雅退出指令后卡住的进程）。
// Windows 上 SIGTERM 为强制终止、handler 不可捕获，因此以「收到 shutdown 仍不退出 → 被 Supervisor 升级强杀 → 重启」验证升级路径。
import { writeFileSync } from 'node:fs';

const marker = process.env.NEXUS_SIGTERM_MARKER || '';

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
    // 记录收到优雅退出指令，但故意不退出（卡住）
    if (marker) {
      try {
        writeFileSync(marker, 'shutdown-received');
      } catch {
        /* ignore */
      }
    }
  }
});
process.on('SIGTERM', () => {
  /* 不响应（Windows 上为强制终止，handler 不可达） */
});
process.on('disconnect', () => {
  /* 父进程断开也不自退 */
});
setInterval(() => {
  /* 保持事件循环存活 */
}, 1000);
