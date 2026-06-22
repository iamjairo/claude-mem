/**
 * AsyncSQLiteSessionStore — wraps the synchronous SQLite SessionStore so it
 * implements the async ISessionStore interface. All methods just wrap return
 * values in Promise.resolve() so callers can use a single await-based
 * interface regardless of which backend is active.
 */
import { SessionStore } from '../sqlite/SessionStore.js';
import { SessionSearch } from '../sqlite/SessionSearch.js';
import type {
  ISessionStore,
  ISessionSearch,
  StoreObservationInput,
  StoreSummaryInput,
} from './ISessionStore.js';
import type { ObservationRecord, UserPromptRecord } from '../../types/database.js';
import type { ObservationSearchResult, SessionSummarySearchResult, SearchOptions } from '../sqlite/types.js';

export class AsyncSQLiteSessionStore implements ISessionStore {
  constructor(private readonly store: SessionStore) {}

  async createSDKSession(contentSessionId: string, project: string, userPrompt: string, customTitle?: string, platformSource?: string) {
    return Promise.resolve(this.store.createSDKSession(contentSessionId, project, userPrompt, customTitle, platformSource));
  }
  async updateMemorySessionId(sessionDbId: number, memorySessionId: string | null) {
    return Promise.resolve(this.store.updateMemorySessionId(sessionDbId, memorySessionId));
  }
  async markSessionCompleted(sessionDbId: number) {
    return Promise.resolve(this.store.markSessionCompleted(sessionDbId));
  }
  async ensureMemorySessionIdRegistered(sessionDbId: number, memorySessionId: string, workerPort?: number) {
    return Promise.resolve(this.store.ensureMemorySessionIdRegistered(sessionDbId, memorySessionId, workerPort));
  }
  async getOrCreateManualSession(project: string) {
    return Promise.resolve(this.store.getOrCreateManualSession(project));
  }
  async getSessionById(id: number) {
    return Promise.resolve(this.store.getSessionById(id));
  }
  async getSdkSessionsBySessionIds(memorySessionIds: string[]) {
    return Promise.resolve(this.store.getSdkSessionsBySessionIds(memorySessionIds));
  }
  async getRecentSessionsWithStatus(project: string, limit?: number) {
    return Promise.resolve(this.store.getRecentSessionsWithStatus(project, limit));
  }
  async storeObservation(memorySessionId: string, project: string, observation: StoreObservationInput, promptNumber?: number, discoveryTokens?: number, overrideTimestampEpoch?: number, generatedByModel?: string) {
    return Promise.resolve(this.store.storeObservation(memorySessionId, project, observation, promptNumber, discoveryTokens, overrideTimestampEpoch, generatedByModel));
  }
  async storeObservations(memorySessionId: string, project: string, observations: StoreObservationInput[], summary: StoreSummaryInput | null, promptNumber?: number, discoveryTokens?: number, overrideTimestampEpoch?: number, generatedByModel?: string) {
    return Promise.resolve(this.store.storeObservations(memorySessionId, project, observations, summary, promptNumber, discoveryTokens, overrideTimestampEpoch, generatedByModel));
  }
  async getRecentObservations(project: string, limit?: number) {
    return Promise.resolve(this.store.getRecentObservations(project, limit));
  }
  async getAllRecentObservations(limit?: number) {
    return Promise.resolve(this.store.getAllRecentObservations(limit));
  }
  async getObservationById(id: number): Promise<ObservationRecord | null> {
    return Promise.resolve(this.store.getObservationById(id));
  }
  async getObservationsByIds(ids: number[], options?: any): Promise<ObservationSearchResult[]> {
    return Promise.resolve(this.store.getObservationsByIds(ids, options));
  }
  async getObservationsForSession(memorySessionId: string) {
    return Promise.resolve(this.store.getObservationsForSession(memorySessionId));
  }
  async getFilesForSession(memorySessionId: string) {
    return Promise.resolve(this.store.getFilesForSession(memorySessionId));
  }
  async storeSummary(memorySessionId: string, project: string, summary: StoreSummaryInput, promptNumber?: number, discoveryTokens?: number, overrideTimestampEpoch?: number) {
    return Promise.resolve(this.store.storeSummary(memorySessionId, project, summary, promptNumber, discoveryTokens, overrideTimestampEpoch));
  }
  async getRecentSummaries(project: string, limit?: number) {
    return Promise.resolve(this.store.getRecentSummaries(project, limit));
  }
  async getRecentSummariesWithSessionInfo(project: string, limit?: number) {
    return Promise.resolve(this.store.getRecentSummariesWithSessionInfo(project, limit));
  }
  async getAllRecentSummaries(limit?: number) {
    return Promise.resolve(this.store.getAllRecentSummaries(limit));
  }
  async getSummaryForSession(memorySessionId: string) {
    return Promise.resolve(this.store.getSummaryForSession(memorySessionId));
  }
  async getSessionSummariesByIds(ids: number[], options?: any): Promise<SessionSummarySearchResult[]> {
    return Promise.resolve(this.store.getSessionSummariesByIds(ids, options));
  }
  async saveUserPrompt(contentSessionId: string, promptNumber: number, promptText: string) {
    return Promise.resolve(this.store.saveUserPrompt(contentSessionId, promptNumber, promptText));
  }
  async getUserPrompt(contentSessionId: string, promptNumber: number) {
    return Promise.resolve(this.store.getUserPrompt(contentSessionId, promptNumber));
  }
  async getLatestUserPrompt(contentSessionId: string) {
    return Promise.resolve(this.store.getLatestUserPrompt(contentSessionId));
  }
  async findRecentDuplicateUserPrompt(contentSessionId: string, promptText: string, windowMs: number) {
    return Promise.resolve(this.store.findRecentDuplicateUserPrompt(contentSessionId, promptText, windowMs));
  }
  async getPromptNumberFromUserPrompts(contentSessionId: string) {
    return Promise.resolve(this.store.getPromptNumberFromUserPrompts(contentSessionId));
  }
  async getAllRecentUserPrompts(limit?: number) {
    return Promise.resolve(this.store.getAllRecentUserPrompts(limit));
  }
  async getPromptById(id: number) {
    return Promise.resolve(this.store.getPromptById(id));
  }
  async getPromptsByIds(ids: number[]) {
    return Promise.resolve(this.store.getPromptsByIds(ids));
  }
  async getUserPromptsByIds(ids: number[], options?: any): Promise<UserPromptRecord[]> {
    return Promise.resolve(this.store.getUserPromptsByIds(ids, options));
  }
  async getAllProjects(platformSource?: string) {
    return Promise.resolve(this.store.getAllProjects(platformSource));
  }
  async getProjectCatalog() {
    return Promise.resolve(this.store.getProjectCatalog());
  }
  async getTimelineAroundTimestamp(anchorEpoch: number, depthBefore?: number, depthAfter?: number, project?: string) {
    return Promise.resolve(this.store.getTimelineAroundTimestamp(anchorEpoch, depthBefore, depthAfter, project));
  }
  async getTimelineAroundObservation(anchorObservationId: number | null, anchorEpoch: number, depthBefore?: number, depthAfter?: number, project?: string) {
    return Promise.resolve(this.store.getTimelineAroundObservation(anchorObservationId, anchorEpoch, depthBefore, depthAfter, project));
  }
  async getStats() {
    const db = this.store.db;
    const totalObservations = (db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number }).count;
    const totalSessions = (db.prepare('SELECT COUNT(*) as count FROM sdk_sessions').get() as { count: number }).count;
    const totalSummaries = (db.prepare('SELECT COUNT(*) as count FROM session_summaries').get() as { count: number }).count;
    return Promise.resolve({ totalObservations, totalSessions, totalSummaries });
  }
  async getPaginatedObservations(offset: number, limit: number, project?: string, platformSource?: string) {
    // Delegate to raw DB queries mirroring PaginationHelper — keep SQLite path unchanged
    const db = this.store.db;
    const conditions: string[] = [];
    const params: any[] = [];

    if (project) {
      conditions.push('(o.project = ? OR o.merged_into_project = ?)');
      params.push(project, project);
    } else {
      const { OBSERVER_SESSIONS_PROJECT } = await import('../../shared/paths.js');
      conditions.push('o.project != ?');
      params.push(OBSERVER_SESSIONS_PROJECT);
    }
    if (platformSource) {
      conditions.push(`COALESCE(s.platform_source, 'claude') = ?`);
      params.push(platformSource);
    }

    let sql = `
      SELECT o.*, COALESCE(s.platform_source, 'claude') as platform_source
      FROM observations o LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
      ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
      ORDER BY o.created_at_epoch DESC LIMIT ? OFFSET ?
    `;
    params.push(limit + 1, offset);
    const results = db.prepare(sql).all(...params) as any[];
    return Promise.resolve({ items: results.slice(0, limit), hasMore: results.length > limit, offset, limit });
  }
  async getPaginatedSummaries(offset: number, limit: number, project?: string, platformSource?: string) {
    const db = this.store.db;
    const conditions: string[] = [];
    const params: any[] = [];
    if (project) { conditions.push('ss.project = ?'); params.push(project); }
    if (platformSource) { conditions.push(`COALESCE(s.platform_source, 'claude') = ?`); params.push(platformSource); }
    const sql = `
      SELECT ss.*, s.content_session_id as session_id, COALESCE(s.platform_source, 'claude') as platform_source
      FROM session_summaries ss LEFT JOIN sdk_sessions s ON ss.memory_session_id = s.memory_session_id
      ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
      ORDER BY ss.created_at_epoch DESC LIMIT ? OFFSET ?
    `;
    params.push(limit + 1, offset);
    const results = db.prepare(sql).all(...params) as any[];
    return Promise.resolve({ items: results.slice(0, limit), hasMore: results.length > limit, offset, limit });
  }
  async getPaginatedSessions(offset: number, limit: number, project?: string, platformSource?: string) {
    const db = this.store.db;
    const { OBSERVER_SESSIONS_PROJECT } = await import('../../shared/paths.js');
    const conditions: string[] = [`project != ?`];
    const params: any[] = [OBSERVER_SESSIONS_PROJECT];
    if (project) { conditions.push('project = ?'); params.push(project); }
    if (platformSource) { conditions.push(`COALESCE(platform_source, 'claude') = ?`); params.push(platformSource); }
    const sql = `SELECT * FROM sdk_sessions WHERE ${conditions.join(' AND ')} ORDER BY started_at_epoch DESC LIMIT ? OFFSET ?`;
    params.push(limit + 1, offset);
    const results = db.prepare(sql).all(...params) as any[];
    return Promise.resolve({ items: results.slice(0, limit), hasMore: results.length > limit, offset, limit });
  }
  async getPaginatedPrompts(offset: number, limit: number, project?: string, platformSource?: string) {
    const db = this.store.db;
    const conditions: string[] = [];
    const params: any[] = [];
    if (project) { conditions.push('s.project = ?'); params.push(project); }
    if (platformSource) { conditions.push(`COALESCE(s.platform_source, 'claude') = ?`); params.push(platformSource); }
    const sql = `
      SELECT up.*, s.project, COALESCE(s.platform_source, 'claude') as platform_source
      FROM user_prompts up LEFT JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
      ORDER BY up.created_at_epoch DESC LIMIT ? OFFSET ?
    `;
    params.push(limit + 1, offset);
    const results = db.prepare(sql).all(...params) as any[];
    return Promise.resolve({ items: results.slice(0, limit), hasMore: results.length > limit, offset, limit });
  }
  async importSdkSession(session: any) { return Promise.resolve(this.store.importSdkSession(session)); }
  async importSessionSummary(summary: any) { return Promise.resolve(this.store.importSessionSummary(summary)); }
  async importObservation(obs: any) { return Promise.resolve(this.store.importObservation(obs)); }
  async importUserPrompt(prompt: any) { return Promise.resolve(this.store.importUserPrompt(prompt)); }
  async close() { return Promise.resolve(this.store.close()); }
}

export class AsyncSQLiteSessionSearch implements ISessionSearch {
  constructor(private readonly search: SessionSearch) {}
  async searchObservations(query: string | undefined, options?: SearchOptions): Promise<ObservationSearchResult[]> {
    return Promise.resolve(this.search.searchObservations(query, options));
  }
  async searchSessions(query: string | undefined, options?: SearchOptions): Promise<SessionSummarySearchResult[]> {
    return Promise.resolve(this.search.searchSessions(query, options));
  }
  async close() { return Promise.resolve(this.search.close()); }
}
