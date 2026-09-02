// 崩溃循环 worker：每次 spawn 都立即 exit(1)
if (typeof process.send === 'function') {
  process.send({ type: 'heartbeat', pid: process.pid, time: Date.now() });
}
setTimeout(() => process.exit(1), 100);
