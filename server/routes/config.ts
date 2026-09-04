import type { FastifyInstance } from 'fastify';
import type { RuntimeContext } from '../context.js';
import { nowDb } from '../util/time.js';
import type { ChannelDTO, ModelDTO } from '../db/types.js';

interface ExportPayload {
  version: string;
  export_at: string;
  channels: ChannelDTO[];
  models: ModelDTO[];
  settings: Record<string, string>;
}

export function registerConfigRoutes(app: FastifyInstance, ctx: RuntimeContext) {
  const chRepo = ctx.repos.channels;
  const mRepo = ctx.repos.models;
  const sRepo = ctx.repos.settings;

  app.get('/api/config/export', async (_req, reply) => {
    const payload: ExportPayload = {
      version: '1.0',
      export_at: new Date().toISOString(),
      channels: chRepo.list(),
      models: mRepo.listAll(),
      settings: sRepo.all(),
    };
    const filename = `nexus-llm-api-config-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`;
    reply.header('Content-Disposition', `attachment; filename=${filename}`);
    reply.header('Content-Type', 'application/json');
    return payload;
  });

  app.post('/api/config/import', async (req, reply) => {
    const body = (req.body ?? {}) as { data?: string; mode?: string; clear_all?: boolean };
    if (!body.data) return reply.code(400).send({ error: '缺少 data 字段' });

    let parsed: ExportPayload;
    try {
      parsed = JSON.parse(body.data);
    } catch (err) {
      return reply.code(400).send({ error: 'JSON 解析失败: ' + (err as Error).message });
    }
    if (!Array.isArray(parsed.channels) || !Array.isArray(parsed.models)) {
      return reply.code(400).send({ error: '配置结构不合法：缺少 channels/models' });
    }

    const replace = body.mode === 'replace' || body.clear_all === true;
    const db = ctx.db.db;

    try {
      const importTx = db.transaction(() => {
        if (replace) {
          db.prepare('DELETE FROM models').run();
          db.prepare('DELETE FROM channels').run();
        }
        // 预建索引（事务内逐条查全表是 O(n²)，大配置会长时间阻塞事件循环）
        const byName = new Map<string, ChannelDTO[]>();
        if (!replace) {
          for (const c of chRepo.list()) {
            const l = byName.get(c.name) ?? [];
            l.push(c);
            byName.set(c.name, l);
          }
        }
        const existingModelKeys = new Set<string>();
        if (!replace) {
          for (const m of mRepo.listAll()) existingModelKeys.add(`${m.channel_id}::${m.model_id}`);
        }
        const payloadModelKeys = new Set<string>();

        // 旧导出 ID -> 新渠道 ID 映射
        const idMap = new Map<number, number>();
        let importedChannels = 0;
        for (const c of parsed.channels) {
          const candidates = byName.get(c.name) ?? [];
          const existing = candidates.find((x) => !c.base_url || x.base_url === c.base_url);
          if (existing && !replace) {
            idMap.set(c.id, existing.id);
            continue;
          }
          const created = chRepo.create({
            name: c.name,
            provider_type: c.provider_type,
            base_url: c.base_url,
            api_key: c.api_key,
            extra_config: c.extra_config,
            enabled: c.enabled,
            rpm_limit: c.rpm_limit,
            retry_count: c.retry_count,
          });
          idMap.set(c.id, created.id);
          importedChannels++;
        }

        let importedModels = 0;
        for (const m of parsed.models) {
          const newChannelId = idMap.get(m.channel_id) ?? m.channel_id;
          const key = `${newChannelId}::${m.model_id}`;
          // 既有模型在 merge 模式下跳过；payload 内部重复也跳过（唯一索引会让整个导入回滚 500）
          if (payloadModelKeys.has(key) || (!replace && existingModelKeys.has(key))) continue;
          payloadModelKeys.add(key);
          mRepo.create({
            model_id: m.model_id,
            alias: m.alias,
            channel_id: newChannelId,
            tags: m.tags,
            modal_type: m.modal_type,
            max_context: m.max_context,
            enabled: m.enabled,
            available: m.available,
            remark: m.remark,
          });
          importedModels++;
        }

        let importedSettings = 0;
        for (const [k, v] of Object.entries(parsed.settings ?? {})) {
          sRepo.set(k, v);
          importedSettings++;
        }
        return { importedChannels, importedModels, importedSettings };
      });
      const result = importTx();
      ctx.requestRuntimeReload();
      return { message: '配置导入成功', mode: body.mode ?? 'merge', ...result };
    } catch (err) {
      // 事务自动回滚
      return reply.code(500).send({ error: '导入失败（已回滚）: ' + (err as Error).message });
    }
  });

  // 一键清空所有渠道与模型（事务）
  app.post('/api/config/clear', async () => {
    const tx = ctx.db.db.transaction(() => {
      ctx.db.db.prepare('DELETE FROM models').run();
      ctx.db.db.prepare('DELETE FROM channels').run();
    });
    tx();
    ctx.requestRuntimeReload();
    return { message: 'cleared', at: nowDb() };
  });
}
