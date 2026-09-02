// 首次 spawn 时发一次心跳后 exit(1)；第二次（重启后）保持存活
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const marker = join(dirname(fileURLToPath(import.meta.url)), '.exit-once-marker');
const firstRun = !existsSync(marker);

if (typeof process.send === 'function') {
  process.send({ type: 'heartbeat', pid: process.pid, time: Date.now(), run: firstRun ? 'first' : 'second' });
}

if (firstRun) {
  writeFileSync(marker, 'x');
  setTimeout(() => process.exit(1), 200);
} else {
  if (typeof process.send === 'function') {
    const t = setInterval(() => {
      try {
        process.send({ type: 'heartbeat', pid: process.pid, time: Date.now(), run: 'second' });
      } catch {
        /* ignore */
      }
    }, 400);
    t.unref();
  }
  process.on('message', (m) => {
    if (m && m.type === 'shutdown') process.exit(0);
  });
  setInterval(() => {}, 1000);
}
