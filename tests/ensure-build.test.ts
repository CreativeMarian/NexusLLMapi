// ensure-build 纯逻辑单测：验证 newestMtime 同时正确处理文件与目录（修复 ENOTDIR），
// 以及 needs() 的产物过期判断。
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { newestMtime, needs } = require('../scripts/ensure-build.cjs');

function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'eb-test-'));
  const server = join(root, 'server');
  mkdirSync(server, { recursive: true });
  const a = join(root, 'a.txt');
  writeFileSync(a, 'a');
  const cfg = join(root, 'tsconfig.build.json');
  writeFileSync(cfg, '{}');
  const src1 = join(server, 'src1.ts');
  writeFileSync(src1, 'x');
  const sub = join(server, 'sub');
  mkdirSync(sub);
  const src2 = join(sub, 'src2.ts');
  writeFileSync(src2, 'y');
  // node_modules 应被跳过
  const nm = join(server, 'node_modules');
  mkdirSync(nm);
  const nmF = join(nm, 'big.js');
  writeFileSync(nmF, 'z');
  return { root, a, cfg, server, src1, src2, nmF };
}

describe('ensure-build newestMtime / needs', () => {
  it('单文件路径直接返回其 mtime，不再 readdirSync（ENOTDIR 修复）', () => {
    const t = makeTree();
    try {
      expect(newestMtime(t.a)).toBeGreaterThan(0);
      expect(newestMtime(t.cfg)).toBeGreaterThan(0);
    } finally {
      rmSync(t.root, { recursive: true, force: true });
    }
  });

  it('不存在的路径返回 0', () => {
    const t = makeTree();
    try {
      expect(newestMtime(join(t.root, 'nope.ts'))).toBe(0);
    } finally {
      rmSync(t.root, { recursive: true, force: true });
    }
  });

  it('目录递归返回最新文件 mtime（含子目录），跳过 node_modules', () => {
    const t = makeTree();
    try {
      // 把子目录文件 src2 设为未来时间，应成为目录最新 mtime
      const future = Date.now() / 1000 + 100;
      utimesSync(t.src2, future, future);
      const dirM = newestMtime(t.server);
      expect(dirM).toBeCloseTo(future * 1000, -2); // 与 src2 的 mtime 一致
      expect(dirM).toBeGreaterThanOrEqual(newestMtime(t.src1));
      // 即使 node_modules 里有更新文件也不影响结果
      const nmFuture = Date.now() / 1000 + 500;
      utimesSync(t.nmF, nmFuture, nmFuture);
      const after = newestMtime(t.server);
      expect(after).toBe(dirM); // 未被 node_modules 污染
    } finally {
      rmSync(t.root, { recursive: true, force: true });
    }
  });

  it('needs()：产物缺失 → true；产物最新 → false；源文件更新 → true', () => {
    const t = makeTree();
    try {
      const out = join(t.root, 'dist-server', 'main.js');
      // 产物不存在
      expect(needs(out, ['server', 'tsconfig.build.json'], t.root)).toBe(true);
      // 造一个比源更新的产物
      mkdirSync(join(t.root, 'dist-server'), { recursive: true });
      writeFileSync(out, 'build');
      const far = Date.now() / 1000 + 100;
      utimesSync(out, far, far);
      expect(needs(out, ['server', 'tsconfig.build.json'], t.root)).toBe(false);
      // 让源更新（touch 到比产物更晚）
      const newer = far + 1000;
      utimesSync(t.src1, newer, newer);
      expect(needs(out, ['server', 'tsconfig.build.json'], t.root)).toBe(true);
    } finally {
      rmSync(t.root, { recursive: true, force: true });
    }
  });

  it('needs() 对 tsconfig.build.json / vite.config.ts / index.html 等文件源不抛 ENOTDIR', () => {
    const t = makeTree();
    try {
      const out = join(t.root, 'dist-server', 'main.js');
      mkdirSync(join(t.root, 'dist-server'), { recursive: true });
      writeFileSync(out, 'b');
      // 未来产物
      const far = Date.now() / 1000 + 200;
      utimesSync(out, far, far);
      // 文件源：tsconfig.build.json
      expect(needs(out, ['server', 'tsconfig.build.json'], t.root)).toBe(false);
      // 再 touch tsconfig.build.json 到更晚 → 需要重建
      const newer = far + 500;
      utimesSync(t.cfg, newer, newer);
      expect(needs(out, ['server', 'tsconfig.build.json'], t.root)).toBe(true);
    } finally {
      rmSync(t.root, { recursive: true, force: true });
    }
  });
});
