// 正常 worker：持续发心跳，保持存活，收到 shutdown 时优雅退出
let alive = true;
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
  if (m && m.type === 'shutdown' && alive) {
    alive = false;
    process.exit(0);
  }
});
setInterval(() => {
  /* 保持事件循环存活 */
}, 1000);
