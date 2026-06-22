import type {
  ObservationRecord,
  SessionSummaryRecord,
  UserPromptRecord,
  LatestPromptResult,
} from '../../types/database.js';
import type {
  ObservationSearchResult,
  SessionSummarySearchResult,
  SearchOptions,
  SearchFilters,
} from '../sqlite/types.js';

export interface StoreObservationInput {
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];
  files_read: string[];
  files_modified: string[];
  agent_type?: string | null;
  agent_id?: string | null;
  metadata?: string | null;
}

export interface StoreSummaryInput {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  notes: string | null;
}

/** Shared async interface implemented by both MongoSessionStore and AsyncSQLiteSessionStore. */
export interface ISessionStore {
  // Session lifecycle
  createSDKSession(
    contentSessionId: string,
    project: string,
    userPrompt: string,
    customTitle?: string,
    platformSource?: string
  ): Promise<number>;

  updateMemorySessionId(sessionDbId: number, memorySessionId: string | null): Promise<void>;
  markSessionCompleted(sessionDbId: number): Promise<void>;
  ensureMemorySessionIdRegistered(sessionDbId: number, memorySessionId: string, workerPort?: number): Promise<void>;
  getOrCreateManualSession(project: string): Promise<string>;

  // Session queries
  getSessionById(id: number): Promise<{
    id: number;
    content_session_id: string;
    memory_session_id: string | null;
    project: string;
    platform_source: string;
    user_prompt: string;
    custom_title: string | null;
    status: string;
  } | null>;

  getSdkSessionsBySessionIds(memorySessionIds: string[]): Promise<{
    id: number;
    content_session_id: string;
    memory_session_id: string;
    project: string;
    platform_source: string;
    user_prompt: string;
    custom_title: string | null;
    started_at: string;
    started_at_epoch: number;
    completed_at: string | null;
    completed_at_epoch: number | null;
    status: string;
  }[]>;

  getRecentSessionsWithStatus(project: string, limit?: number): Promise<Array<{
    memory_session_id: string | null;
    status: string;
    started_at: string;
    user_prompt: string | null;
    has_summary: boolean;
  }>>;

  // Observations
  storeObservation(
    memorySessionId: string,
    project: string,
    observation: StoreObservationInput,
    promptNumber?: number,
    discoveryTokens?: number,
    overrideTimestampEpoch?: number,
    generatedByModel?: string
  ): Promise<{ id: number; createdAtEpoch: number }>;

  storeObservations(
    memorySessionId: string,
    project: string,
    observations: StoreObservationInput[],
    summary: StoreSummaryInput | null,
    promptNumber?: number,
    discoveryTokens?: number,
    overrideTimestampEpoch?: number,
    generatedByModel?: string
  ): Promise<{ observationIds: number[]; summaryId: number | null; createdAtEpoch: number }>;

  getRecentObservations(project: string, limit?: number): Promise<Array<{
    type: string;
    text: string;
    prompt_number: number | null;
    created_at: string;
  }>>;

  getAllRecentObservations(limit?: number): Promise<Array<{
    id: number;
    type: string;
    title: string | null;
    subtitle: string | null;
    text: string;
    project: string;
    platform_source: string;
    prompt_number: number | null;
    created_at: string;
    created_at_epoch: number;
  }>>;

  getObservationById(id: number): Promise<ObservationRecord | null>;
  getObservationsByIds(ids: number[], options?: {
    orderBy?: 'date_desc' | 'date_asc' | 'relevance';
    limit?: number;
    project?: string;
    type?: string | string[];
    concepts?: string | string[];
    files?: string | string[];
  }): Promise<ObservationSearchResult[]>;

  getObservationsForSession(memorySessionId: string): Promise<Array<{
    title: string;
    subtitle: string;
    type: string;
    prompt_number: number | null;
  }>>;

  getFilesForSession(memorySessionId: string): Promise<{ filesRead: string[]; filesModified: string[] }>;

  // Summaries
  storeSummary(
    memorySessionId: string,
    project: string,
    summary: StoreSummaryInput,
    promptNumber?: number,
    discoveryTokens?: number,
    overrideTimestampEpoch?: number
  ): Promise<{ id: number; createdAtEpoch: number }>;

  getRecentSummaries(project: string, limit?: number): Promise<Array<{
    request: string | null;
    investigated: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    files_read: string | null;
    files_edited: string | null;
    notes: string | null;
    prompt_number: number | null;
    created_at: string;
  }>>;

  getRecentSummariesWithSessionInfo(project: string, limit?: number): Promise<Array<{
    memory_session_id: string;
    request: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    prompt_number: number | null;
    created_at: string;
  }>>;

  getAllRecentSummaries(limit?: number): Promise<Array<{
    id: number;
    request: string | null;
    investigated: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    files_read: string | null;
    files_edited: string | null;
    notes: string | null;
    project: string;
    platform_source: string;
    prompt_number: number | null;
    created_at: string;
    created_at_epoch: number;
  }>>;

  getSummaryForSession(memorySessionId: string): Promise<{
    request: string | null;
    investigated: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    files_read: string | null;
    files_edited: string | null;
    notes: string | null;
    prompt_number: number | null;
    created_at: string;
    created_at_epoch: number;
  } | null>;

  getSessionSummariesByIds(ids: number[], options?: {
    orderBy?: 'date_desc' | 'date_asc' | 'relevance';
    limit?: number;
    project?: string;
  }): Promise<SessionSummarySearchResult[]>;

  // User prompts
  saveUserPrompt(contentSessionId: string, promptNumber: number, promptText: string): Promise<number>;
  getUserPrompt(contentSessionId: string, promptNumber: number): Promise<string | null>;
  getLatestUserPrompt(contentSessionId: string): Promise<LatestPromptResult | undefined>;
  findRecentDuplicateUserPrompt(contentSessionId: string, promptText: string, windowMs: number): Promise<LatestPromptResult | undefined>;
  getPromptNumberFromUserPrompts(contentSessionId: string): Promise<number>;
  getAllRecentUserPrompts(limit?: number): Promise<Array<{
    id: number;
    content_session_id: string;
    project: string;
    platform_source: string;
    prompt_number: number;
    prompt_text: string;
    created_at: string;
    created_at_epoch: number;
  }>>;

  getPromptById(id: number): Promise<{
    id: number;
    content_session_id: string;
    prompt_number: number;
    prompt_text: string;
    project: string;
    created_at: string;
    created_at_epoch: number;
  } | null>;

  getPromptsByIds(ids: number[]): Promise<Array<{
    id: number;
    content_session_id: string;
    prompt_number: number;
    prompt_text: string;
    project: string;
    created_at: string;
    created_at_epoch: number;
  }>>;

  getUserPromptsByIds(ids: number[], options?: {
    orderBy?: 'date_desc' | 'date_asc' | 'relevance';
    limit?: number;
    project?: string;
  }): Promise<UserPromptRecord[]>;

  // Projects
  getAllProjects(platformSource?: string): Promise<string[]>;
  getProjectCatalog(): Promise<{
    projects: string[];
    sources: string[];
    projectsBySource: Record<string, string[]>;
  }>;

  // Timeline
  getTimelineAroundTimestamp(
    anchorEpoch: number,
    depthBefore?: number,
    depthAfter?: number,
    project?: string
  ): Promise<{ observations: any[]; sessions: any[]; prompts: any[] }>;

  getTimelineAroundObservation(
    anchorObservationId: number | null,
    anchorEpoch: number,
    depthBefore?: number,
    depthAfter?: number,
    project?: string
  ): Promise<{ observations: any[]; sessions: any[]; prompts: any[] }>;

  // Stats
  getStats(): Promise<{ totalObservations: number; totalSessions: number; totalSummaries: number }>;

  // Pagination helpers (replaces raw .db access)
  getPaginatedObservations(offset: number, limit: number, project?: string, platformSource?: string): Promise<{
    items: any[];
    hasMore: boolean;
    offset: number;
    limit: number;
  }>;

  getPaginatedSummaries(offset: number, limit: number, project?: string, platformSource?: string): Promise<{
    items: any[];
    hasMore: boolean;
    offset: number;
    limit: number;
  }>;

  getPaginatedSessions(offset: number, limit: number, project?: string, platformSource?: string): Promise<{
    items: any[];
    hasMore: boolean;
    offset: number;
    limit: number;
  }>;

  getPaginatedPrompts(offset: number, limit: number, project?: string, platformSource?: string): Promise<{
    items: any[];
    hasMore: boolean;
    offset: number;
    limit: number;
  }>;

  // Import (for data migration)
  importSdkSession(session: {
    content_session_id: string;
    memory_session_id: string;
    project: string;
    platform_source?: string;
    user_prompt?: string;
    custom_title?: string;
    started_at: string;
    started_at_epoch: number;
    completed_at?: string | null;
    completed_at_epoch?: number | null;
    status?: string;
    worker_port?: number | null;
    prompt_counter?: number;
  }): Promise<{ imported: boolean; id: number }>;

  importSessionSummary(summary: {
    memory_session_id: string;
    project: string;
    request?: string;
    investigated?: string;
    learned?: string;
    completed?: string;
    next_steps?: string;
    files_read?: string;
    files_edited?: string;
    notes?: string | null;
    prompt_number?: number;
    discovery_tokens?: number;
    created_at: string;
    created_at_epoch: number;
  }): Promise<{ imported: boolean; id: number }>;

  importObservation(obs: {
    memory_session_id: string;
    project: string;
    type: string;
    title?: string | null;
    subtitle?: string | null;
    text?: string | null;
    facts?: string | null;
    narrative?: string | null;
    concepts?: string | null;
    files_read?: string | null;
    files_modified?: string | null;
    prompt_number?: number | null;
    discovery_tokens?: number;
    content_hash?: string | null;
    agent_type?: string | null;
    agent_id?: string | null;
    merged_into_project?: string | null;
    generated_by_model?: string | null;
    metadata?: string | null;
    created_at: string;
    created_at_epoch: number;
  }): Promise<{ imported: boolean; id: number }>;

  importUserPrompt(prompt: {
    content_session_id: string;
    prompt_number: number;
    prompt_text: string;
    created_at: string;
    created_at_epoch: number;
  }): Promise<{ imported: boolean; id: number }>;

  close(): Promise<void>;
}

/** Thin async search interface for both SQLite and MongoDB. */
export interface ISessionSearch {
  searchObservations(query: string | undefined, options?: SearchOptions): Promise<ObservationSearchResult[]>;
  searchSessions(query: string | undefined, options?: SearchOptions): Promise<SessionSummarySearchResult[]>;
  close(): Promise<void>;
}
