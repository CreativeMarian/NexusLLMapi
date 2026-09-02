import type { FastifyInstance } from 'fastify';
import type { RuntimeContext } from '../context.js';
import { registerChannelRoutes } from './channels.js';
import { registerModelRoutes } from './models.js';
import { registerSettingRoutes } from './settings.js';
import { registerLogRoutes } from './logs.js';
import { registerDashboardRoutes } from './dashboard.js';
import { registerConfigRoutes } from './config.js';
import { registerMcpRoutes } from './mcp.js';
import { registerPromptRoutes } from './prompts.js';

/** 注册所有管理 API 路由（Gateway 路由在 Phase D 单独挂载） */
export async function registerAllRoutes(app: FastifyInstance, ctx: RuntimeContext): Promise<void> {
  registerChannelRoutes(app, ctx);
  registerModelRoutes(app, ctx);
  registerSettingRoutes(app, ctx);
  registerLogRoutes(app, ctx);
  registerDashboardRoutes(app, ctx);
  registerConfigRoutes(app, ctx);
  registerMcpRoutes(app, ctx);
  registerPromptRoutes(app, ctx);
}
