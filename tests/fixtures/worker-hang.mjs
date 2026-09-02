// 卡死 worker：只发一次心跳，随后事件循环忙转、不再发心跳
if (typeof process.send === 'function') {
  process.send({ type: 'heartbeat', pid: process.pid, time: Date.now() });
}
// 忙转，但不再发心跳（模拟事件循环卡死 / IPC 心跳停止）
setInterval(() => {
  const x = Math.sqrt(Date.now());
  void x;
}, 100);
process.on('message', () => {
  /* 收到 shutdown 也不响应（卡死） */
});
