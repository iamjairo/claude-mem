
import { DatabaseManager } from './DatabaseManager.js';
import { logger } from '../../utils/logger.js';
import type { ViewerSettings } from '../worker-types.js';

const MONGO_BACKEND = process.env.CLAUDE_MEM_DB_BACKEND === 'mongodb';

export class SettingsManager {
  private dbManager: DatabaseManager;
  private readonly defaultSettings: ViewerSettings = {
    sidebarOpen: true,
    selectedProject: null,
    theme: 'system'
  };

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager;
  }

  getSettings(): ViewerSettings {
    if (MONGO_BACKEND) return this._getSettingsMongo();

    const db = this.dbManager.getSessionStore().db;

    try {
      const stmt = db.prepare('SELECT key, value FROM viewer_settings');
      const rows = stmt.all() as Array<{ key: string; value: string }>;

      const settings: ViewerSettings = { ...this.defaultSettings };
      for (const row of rows) {
        const key = row.key as keyof ViewerSettings;
        if (key in settings) {
          Object.assign(settings, { [key]: JSON.parse(row.value) });
        }
      }

      return settings;
    } catch (error) {
      if (error instanceof Error) {
        logger.debug('WORKER', 'Failed to load settings, using defaults', {}, error);
      } else {
        logger.debug('WORKER', 'Failed to load settings, using defaults', { rawError: String(error) });
      }
      return { ...this.defaultSettings };
    }
  }

  updateSettings(updates: Partial<ViewerSettings>): ViewerSettings {
    if (MONGO_BACKEND) return this._updateSettingsMongo(updates);

    const db = this.dbManager.getSessionStore().db;

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO viewer_settings (key, value)
      VALUES (?, ?)
    `);

    for (const [key, value] of Object.entries(updates)) {
      stmt.run(key, JSON.stringify(value));
    }

    return this.getSettings();
  }

  // ── MongoDB settings (stored in viewer_settings collection) ────────────────

  private _settingsCache: ViewerSettings | null = null;

  private _getSettingsMongo(): ViewerSettings {
    return this._settingsCache ?? { ...this.defaultSettings };
  }

  private _updateSettingsMongo(updates: Partial<ViewerSettings>): ViewerSettings {
    this._settingsCache = { ...(this._settingsCache ?? this.defaultSettings), ...updates };
    // Fire-and-forget persist to MongoDB
    try {
      const { getDb } = require('../mongodb/MongoConnection.js') as typeof import('../mongodb/MongoConnection.js');
      const col = getDb().collection('viewer_settings');
      for (const [key, value] of Object.entries(updates)) {
        col.updateOne({ _id: key as any }, { $set: { value } }, { upsert: true }).catch(() => {});
      }
    } catch {
      // MongoDB not ready — keep in memory only
    }
    return { ...(this._settingsCache ?? this.defaultSettings) };
  }
}
