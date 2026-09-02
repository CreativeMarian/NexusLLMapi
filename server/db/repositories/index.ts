import type { DatabaseManager } from '../database.js';
import { ChannelRepository } from './channel-repo.js';
import { ModelRepository } from './model-repo.js';
import { LogRepository } from './log-repo.js';
import { SettingRepository } from './setting-repo.js';

export class Repositories {
  readonly channels: ChannelRepository;
  readonly models: ModelRepository;
  readonly logs: LogRepository;
  readonly settings: SettingRepository;

  constructor(db: DatabaseManager) {
    this.channels = new ChannelRepository(db.db);
    this.models = new ModelRepository(db.db);
    this.logs = new LogRepository(db.db);
    this.settings = new SettingRepository(db.db);
  }
}
