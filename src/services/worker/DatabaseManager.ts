
import { Database } from 'bun:sqlite';
import { SessionStore } from '../sqlite/SessionStore.js';
import { SessionSearch } from '../sqlite/SessionSearch.js';
import { ChromaSync } from '../sync/ChromaSync.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, DB_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import type { DBSession } from '../worker-types.js';
import type { ISessionStore, ISessionSearch } from '../mongodb/ISessionStore.js';
import { AsyncSQLiteSessionStore, AsyncSQLiteSessionSearch } from '../mongodb/AsyncSQLiteSessionStore.js';
import { MongoSessionStore } from '../mongodb/MongoSessionStore.js';
import { MongoSessionSearch } from '../mongodb/MongoSessionSearch.js';
import { connectMongo, closeMongo } from '../mongodb/MongoConnection.js';

/** Set CLAUDE_MEM_DB_BACKEND=mongodb to use MongoDB instead of SQLite. */
const MONGO_BACKEND = process.env.CLAUDE_MEM_DB_BACKEND === 'mongodb';
const MONGO_URI = process.env.CLAUDE_MEM_MONGODB_URI ?? 'mongodb://localhost:27017';

export class DatabaseManager {
  private db: Database | null = null;
  private sessionStore: SessionStore | null = null;
  private sessionSearch: SessionSearch | null = null;
  private asyncStore: ISessionStore | null = null;
  private asyncSearch: ISessionSearch | null = null;
  private chromaSync: ChromaSync | null = null;

  async initialize(): Promise<void> {
    if (MONGO_BACKEND) {
      await connectMongo(MONGO_URI);
      this.asyncStore = new MongoSessionStore();
      this.asyncSearch = new MongoSessionSearch();
      logger.info('DB', 'Database initialized (MongoDB backend)', { uri: MONGO_URI.replace(/\/\/[^@]+@/, '//***@') });
    } else {
      this.db = new Database(DB_PATH);
      this.sessionStore = new SessionStore(this.db);
      this.sessionSearch = new SessionSearch(this.db);
      this.asyncStore = new AsyncSQLiteSessionStore(this.sessionStore);
      this.asyncSearch = new AsyncSQLiteSessionSearch(this.sessionSearch);
      logger.info('DB', 'Database initialized (SQLite backend)');
    }

    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const chromaEnabled = settings.CLAUDE_MEM_CHROMA_ENABLED !== 'false';
    if (chromaEnabled) {
      this.chromaSync = new ChromaSync('claude-mem');
    } else {
      logger.info('DB', 'Chroma disabled via CLAUDE_MEM_CHROMA_ENABLED=false, using text-search only');
    }
  }

  async close(): Promise<void> {
    if (this.chromaSync) {
      await this.chromaSync.close();
      this.chromaSync = null;
    }

    if (this.asyncStore) {
      await this.asyncStore.close();
      this.asyncStore = null;
    }
    if (this.asyncSearch) {
      await this.asyncSearch.close();
      this.asyncSearch = null;
    }

    this.sessionStore = null;
    this.sessionSearch = null;

    if (this.db) {
      this.db.close();
      this.db = null;
    }

    if (MONGO_BACKEND) {
      await closeMongo();
    }

    logger.info('DB', 'Database closed');
  }

  /**
   * Returns the async store interface — works with both SQLite and MongoDB.
   * Prefer this over getSessionStore() for new code.
   */
  getStore(): ISessionStore {
    if (!this.asyncStore) throw new Error('Database not initialized');
    return this.asyncStore;
  }

  /**
   * Returns the async search interface — works with both SQLite and MongoDB.
   * Prefer this over getSessionSearch() for new code.
   */
  getSearch(): ISessionSearch {
    if (!this.asyncSearch) throw new Error('Database not initialized');
    return this.asyncSearch;
  }

  /** @deprecated Use getStore() for MongoDB-compatible code. */
  getSessionStore(): SessionStore {
    if (!this.sessionStore) {
      if (MONGO_BACKEND) throw new Error('getSessionStore() not available in MongoDB mode — use getStore()');
      throw new Error('Database not initialized');
    }
    return this.sessionStore;
  }

  /** Returns SessionStore or null in MongoDB mode. Use for SQLite-only paths that are gracefully skipped in MongoDB mode. */
  getSessionStoreOrNull(): SessionStore | null {
    return this.sessionStore;
  }

  /** @deprecated Use getSearch() for MongoDB-compatible code. */
  getSessionSearch(): SessionSearch {
    if (!this.sessionSearch) {
      if (MONGO_BACKEND) throw new Error('getSessionSearch() not available in MongoDB mode — use getSearch()');
      throw new Error('Database not initialized');
    }
    return this.sessionSearch;
  }

  /** Returns SessionSearch or null in MongoDB mode. Use for SQLite-only paths that are gracefully skipped in MongoDB mode. */
  getSessionSearchOrNull(): SessionSearch | null {
    return this.sessionSearch;
  }

  getChromaSync(): ChromaSync | null {
    return this.chromaSync;
  }

  getConnection(): Database {
    if (!this.db) {
      if (MONGO_BACKEND) throw new Error('getConnection() not available in MongoDB mode');
      throw new Error('Database not initialized');
    }
    return this.db;
  }

  async getSessionById(sessionDbId: number): Promise<{
    id: number;
    content_session_id: string;
    memory_session_id: string | null;
    project: string;
    platform_source: string;
    user_prompt: string;
    custom_title: string | null;
    status: string;
  }> {
    const session = await this.getStore().getSessionById(sessionDbId);
    if (!session) throw new Error(`Session ${sessionDbId} not found`);
    return session;
  }

}
