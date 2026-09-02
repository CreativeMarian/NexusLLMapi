// ensure-build：确保 dist-server 与 web/dist 存在且不陈旧。
// npm install && npm start 即可一键运行（npm 会自动先执行 prestart），无需手动 build。
const { existsSync, statSync, readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const root = resolve(__dirname, '..');
const serverOut = join(root, 'dist-server', 'main.js');
const webOut = join(root, 'web', 'dist', 'index.html');

/**
 * 返回路径的最新 mtimeMs：
 * - 不存在 → 0
 * - 文件 → 直接返回其 mtime（绝不对文件执行 readdirSync，避免 ENOTDIR）
 * - 目录 → 递归扫描目录内文件/子目录，返回最新 mtime（跳过 node_modules/dist/dist-server）
 */
function newestMtime(p) {
  let st;
  try {
    st = statSync(p);
  } catch {
    return 0;
  }
  if (st.isFile()) return st.mtimeMs;
  if (!st.isDirectory()) return 0;
  let newest = st.mtimeMs;
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const child = join(d, name);
      let cs;
      try {
        cs = statSync(child);
      } catch {
        continue;
      }
      if (cs.isDirectory()) {
        if (name === 'node_modules' || name === 'dist' || name === 'dist-server') continue;
        const sub = newestMtime(child);
        if (sub > newest) newest = sub;
      } else if (cs.mtimeMs > newest) {
        newest = cs.mtimeMs;
      }
    }
  };
  walk(p);
  return newest;
}

/** 产物是否缺失或比任一源目录/文件旧（需要重建）。base 默认项目根，测试可注入临时根 */
function needs(out, srcDirs, base = root) {
  if (!existsSync(out)) return true;
  const outM = statSync(out).mtimeMs;
  return srcDirs.some((d) => newestMtime(join(base, d)) > outM);
}

function run(script) {
  // eslint-disable-next-line no-console
  console.log(`[ensure-build] 执行 npm run ${script} ...`);
  const r = spawnSync('npm', ['run', script], { cwd: root, shell: true, stdio: 'inherit' });
  if (r.status !== 0) {
    // eslint-disable-next-line no-console
    console.error(`[ensure-build] ${script} 失败，exit=${r.status}`);
    process.exit(r.status || 1);
  }
}

function main() {
  try {
    if (needs(serverOut, ['server', 'tsconfig.build.json'])) {
      run('build:server');
    } else {
      // eslint-disable-next-line no-console
      console.log('[ensure-build] dist-server 已是最新，跳过');
    }
    if (needs(webOut, ['web/src', 'web/vite.config.ts', 'web/index.html'])) {
      run('build:web');
    } else {
      // eslint-disable-next-line no-console
      console.log('[ensure-build] web/dist 已是最新，跳过');
    }
    // eslint-disable-next-line no-console
    console.log('[ensure-build] 构建产物就绪，启动服务');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[ensure-build] 检查失败:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { newestMtime, needs, root, serverOut, webOut };
