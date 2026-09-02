// 生成正式交付 ZIP（不含 node_modules / 构建产物 / 运行期 WAL-SHM）。
// 数据快照规则（见 MIGRATION_REPORT 第十三章）：
//   - 真实数据包：先用 SQLite backup API（better-sqlite3）从活库生成自包含 store.db 快照
//     （journal_mode=DELETE + quick_check=ok，无 -wal/-shm 侧文件），放入交付包；
//   - 绝不对正在运行的 store.db + store.db-wal + store.db-shm 分别 ZIP（避免非原子快照）；
//   - 不修改、不删除任何真实数据（data/ 原样保留）。
// 用法：node scripts/make-delivery-zip.cjs [输出路径]
const { existsSync, statSync, mkdirSync, copyFileSync, cpSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { join, resolve, dirname, basename } = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');

const require2 = createRequire(join(__dirname, '..', 'package.json'));
const Database = require2('better-sqlite3');

const root = resolve(__dirname, '..');
const outZip = process.argv[2] || join(root, 'NexusLLMapi-final.zip');
const stageRoot = join(root, '.delivery');
const stageName = 'NexusLLMapi';
const stage = join(stageRoot, stageName);

const EXCLUDE_DIRS = new Set(['node_modules', 'dist-server', 'dist', '.git', '.delivery', 'legacy-go', 'backups']);
const EXCLUDE_FILES = new Set(['NexusLLMapi-final.zip', 'store.db-wal', 'store.db-shm']);

function rm(target) {
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
}

function copyDir(src, dest) {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    if (EXCLUDE_DIRS.has(name) || EXCLUDE_FILES.has(name)) continue;
    const s = join(src, name);
    const d = join(dest, name);
    let st;
    try {
      st = statSync(s);
    } catch {
      continue;
    }
    if (st.isDirectory()) copyDir(s, d);
    else if (st.isFile()) copyFileSync(s, d);
  }
}

function copyFile(src, dest) {
  if (!existsSync(src)) return;
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

/** 用 SQLite backup API 生成自包含快照：读取活库（含 WAL 未 checkpoint 数据），校验 quick_check */
async function snapshotDb(srcDb, destDb) {
  if (!existsSync(srcDb)) return;
  mkdirSync(dirname(destDb), { recursive: true });
  // 只读连接即可安全执行在线备份；WAL 模式下允许并发读者
  const db = new Database(srcDb, { readonly: true });
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  try {
    await db.backup(destDb); // 在线备份为异步 Promise，完成后才可关闭连接
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  verifySnapshot(destDb);
}

function verifySnapshot(destDb) {
  const b = new Database(destDb);
  b.pragma('journal_mode = DELETE'); // 并库入主文件，成为单一自包含文件
  const qc = String(b.pragma('quick_check', { simple: true }));
  b.close();
  if (qc !== 'ok') throw new Error(`数据快照 quick_check 未通过: ${qc}`);
  // 确认没有残留 -wal/-shm 侧文件
  const side = [destDb + '-wal', destDb + '-shm'];
  const leftover = side.filter((f) => existsSync(f));
  if (leftover.length) {
    for (const f of leftover) rm(f);
  }
  // eslint-disable-next-line no-console
  console.log(`[make-delivery-zip] 数据快照 OK quick_check=${qc} size=${(statSync(destDb).size / 1024).toFixed(1)}KB`);
}

function zipWithPowerShell(srcDir, dest) {
  if (existsSync(dest)) rm(dest);
  mkdirSync(dirname(dest), { recursive: true });
  // Compress-Archive：把 stageRoot 下的 NexusLLMapi 目录打包，使 ZIP 内根目录为 NexusLLMapi/
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path ${JSON.stringify(srcDir)} -DestinationPath ${JSON.stringify(dest)} -CompressionLevel Optimal`,
    ],
    { cwd: root, stdio: 'inherit' },
  );
  if (r.status !== 0) throw new Error(`Compress-Archive 失败 exit=${r.status}`);
}

async function main() {
  rm(stageRoot);
  mkdirSync(stage, { recursive: true });

  // 顶层文件
  for (const f of ['package.json', 'package-lock.json', 'README.md', 'MIGRATION_REPORT.md', 'tsconfig.json', 'tsconfig.build.json', 'vitest.config.ts', '.gitignore']) {
    copyFile(join(root, f), join(stage, f));
  }
  // 目录（排除构建产物与运行期侧文件）
  copyDir(join(root, 'server'), join(stage, 'server'));
  copyDir(join(root, 'web'), join(stage, 'web'));
  copyDir(join(root, 'scripts'), join(stage, 'scripts'));
  copyDir(join(root, 'tests'), join(stage, 'tests'));

  // data/：仅放配置与自包含数据库快照，绝不打包活库的 -wal/-shm，也不打包运行日志
  mkdirSync(join(stage, 'data'), { recursive: true });
  copyFile(join(root, 'data', 'config.json'), join(stage, 'data', 'config.json'));
  await snapshotDb(join(root, 'data', 'store.db'), join(stage, 'data', 'store.db'));

  // 校验交付树无违规内容
  const forbidden = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name === 'dist-server' || name === 'dist') {
        forbidden.push(join(d, name));
        continue;
      }
      const p = join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
    }
  };
  walk(stage);
  if (forbidden.length) {
    throw new Error(`交付树仍包含违规内容: ${forbidden.join(', ')}`);
  }

  zipWithPowerShell(join(stageRoot, stageName), outZip);
  const size = (statSync(outZip).size / 1024).toFixed(1);
  // eslint-disable-next-line no-console
  console.log(`[make-delivery-zip] 完成: ${outZip} (${size} KB)`);
  rm(stageRoot);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[make-delivery-zip] 失败:', err.message);
  process.exit(1);
});
