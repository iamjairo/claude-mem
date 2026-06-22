import type { Db } from 'mongodb';
import { getDb, nextId, COLLECTIONS } from './MongoConnection.js';
import { logger } from '../../utils/logger.js';
import {
  DEFAULT_PLATFORM_SOURCE,
  normalizePlatformSource,
  sortPlatformSources,
} from '../../shared/platform-source.js';
import { OBSERVER_SESSIONS_PROJECT } from '../../shared/paths.js';
import { computeObservationContentHash } from '../sqlite/observations/store.js';
import { parseFileList } from '../sqlite/observations/files.js';
import { normalizeStoredPromptText } from '../sqlite/prompt-storage.js';
import type { ObservationRecord, UserPromptRecord } from '../../types/database.js';
import type { ObservationSearchResult, SessionSummarySearchResult } from '../sqlite/types.js';
import type {
  ISessionStore,
  StoreObservationInput,
  StoreSummaryInput,
} from './ISessionStore.js';

function db(): Db {
  return getDb();
}

function sessions() {
  return db().collection(COLLECTIONS.SESSIONS);
}
function observations() {
  return db().collection(COLLECTIONS.OBSERVATIONS);
}
function summaries() {
  return db().collection(COLLECTIONS.SESSION_SUMMARIES);
}
function prompts() {
  return db().collection(COLLECTIONS.USER_PROMPTS);
}

/** Serialize array fields to JSON string for API compatibility (mirrors SQLite output shape). */
function serializeArrayField(val: string[] | null | undefined): string | null {
  if (!val || val.length === 0) return null;
  return JSON.stringify(val);
}

/** Parse a stored array field — may be JSON string or already an array. */
function parseArrayField(val: unknown): string[] {
  if (!val) return [];
  if (Array.isArray(val)) return val as string[];
  try { return JSON.parse(val as string) as string[]; } catch { return []; }
}

/** Strip MongoDB _id before returning to caller. */
function strip<T extends { _id?: unknown }>(doc: T): Omit<T, '_id'> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, ...rest } = doc;
  return rest;
}

/** Ensure JSON array fields are returned as JSON strings (API shape). */
function normalizeObsOut(doc: any): any {
  if (!doc) return doc;
  return {
    ...doc,
    facts: Array.isArray(doc.facts) ? JSON.stringify(doc.facts) : doc.facts,
    concepts: Array.isArray(doc.concepts) ? JSON.stringify(doc.concepts) : doc.concepts,
    files_read: Array.isArray(doc.files_read) ? JSON.stringify(doc.files_read) : doc.files_read,
    files_modified: Array.isArray(doc.files_modified) ? JSON.stringify(doc.files_modified) : doc.files_modified,
  };
}

export class MongoSessionStore implements ISessionStore {

  // ─── Session lifecycle ───────────────────────────────────────────────────

  async createSDKSession(
    contentSessionId: string,
    project: string,
    userPrompt: string,
    customTitle?: string,
    platformSource?: string,
  ): Promise<number> {
    const now = new Date();
    const normalizedSource = platformSource
      ? normalizePlatformSource(platformSource)
      : DEFAULT_PLATFORM_SOURCE;
    const storedPrompt = normalizeStoredPromptText(userPrompt);

    const existing = await sessions().findOne<{ id: number; platform_source: string }>(
      { content_session_id: contentSessionId },
      { projection: { id: 1, platform_source: 1 } },
    );

    if (existing) {
      const updates: Record<string, unknown> = {};
      if (project) updates['$setOnInsert'] = {};
      // Update project if blank
      await sessions().updateOne(
        { content_session_id: contentSessionId, $or: [{ project: null }, { project: '' }] },
        { $set: { project } },
      );
      if (customTitle) {
        await sessions().updateOne(
          { content_session_id: contentSessionId, custom_title: null },
          { $set: { custom_title: customTitle } },
        );
      }
      if (platformSource) {
        const stored = existing.platform_source?.trim()
          ? normalizePlatformSource(existing.platform_source)
          : undefined;
        if (!stored) {
          await sessions().updateOne(
            { content_session_id: contentSessionId },
            { $set: { platform_source: normalizedSource } },
          );
        } else if (stored !== normalizedSource) {
          throw new Error(
            `Platform source conflict for session ${contentSessionId}: existing=${stored}, received=${normalizedSource}`,
          );
        }
      }
      void updates;
      return existing.id;
    }

    const id = await nextId(db(), 'sdk_sessions');
    await sessions().insertOne({
      id,
      content_session_id: contentSessionId,
      memory_session_id: null,
      project,
      platform_source: normalizedSource,
      user_prompt: storedPrompt,
      custom_title: customTitle ?? null,
      started_at: now.toISOString(),
      started_at_epoch: now.getTime(),
      completed_at: null,
      completed_at_epoch: null,
      status: 'active',
      worker_port: null,
      prompt_counter: 0,
    });

    return id;
  }

  async updateMemorySessionId(sessionDbId: number, memorySessionId: string | null): Promise<void> {
    await sessions().updateOne({ id: sessionDbId }, { $set: { memory_session_id: memorySessionId } });
  }

  async markSessionCompleted(sessionDbId: number): Promise<void> {
    const now = new Date();
    await sessions().updateOne(
      { id: sessionDbId },
      { $set: { status: 'completed', completed_at: now.toISOString(), completed_at_epoch: now.getTime() } },
    );
  }

  async ensureMemorySessionIdRegistered(
    sessionDbId: number,
    memorySessionId: string,
    workerPort?: number,
  ): Promise<void> {
    const session = await sessions().findOne<{ id: number; memory_session_id: string | null; worker_port: number | null }>(
      { id: sessionDbId },
      { projection: { id: 1, memory_session_id: 1, worker_port: 1 } },
    );

    if (!session) throw new Error(`Session ${sessionDbId} not found in sdk_sessions`);

    if (session.memory_session_id !== memorySessionId) {
      await sessions().updateOne({ id: sessionDbId }, { $set: { memory_session_id: memorySessionId } });
      logger.info('DB', 'Registered memory_session_id before storage (FK fix)', {
        sessionDbId,
        oldId: session.memory_session_id,
        newId: memorySessionId,
      });
    }

    if (typeof workerPort === 'number' && session.worker_port !== workerPort) {
      await sessions().updateOne({ id: sessionDbId }, { $set: { worker_port: workerPort } });
    }
  }

  async getOrCreateManualSession(project: string): Promise<string> {
    const memorySessionId = `manual-${project}`;
    const contentSessionId = `manual-content-${project}`;

    const existing = await sessions().findOne({ memory_session_id: memorySessionId });
    if (existing) return memorySessionId;

    const now = new Date();
    const id = await nextId(db(), 'sdk_sessions');
    await sessions().insertOne({
      id,
      memory_session_id: memorySessionId,
      content_session_id: contentSessionId,
      project,
      platform_source: DEFAULT_PLATFORM_SOURCE,
      started_at: now.toISOString(),
      started_at_epoch: now.getTime(),
      completed_at: null,
      completed_at_epoch: null,
      status: 'active',
    });

    logger.info('SESSION', 'Created manual session', { memorySessionId, project });
    return memorySessionId;
  }

  // ─── Session queries ─────────────────────────────────────────────────────

  async getSessionById(id: number) {
    const doc = await sessions().findOne<any>({ id });
    if (!doc) return null;
    return {
      id: doc.id as number,
      content_session_id: doc.content_session_id as string,
      memory_session_id: (doc.memory_session_id ?? null) as string | null,
      project: doc.project as string,
      platform_source: (doc.platform_source ?? DEFAULT_PLATFORM_SOURCE) as string,
      user_prompt: (doc.user_prompt ?? '') as string,
      custom_title: (doc.custom_title ?? null) as string | null,
      status: doc.status as string,
    };
  }

  async getSdkSessionsBySessionIds(memorySessionIds: string[]) {
    if (memorySessionIds.length === 0) return [];
    const docs = await sessions()
      .find<any>({ memory_session_id: { $in: memorySessionIds } })
      .sort({ started_at_epoch: -1 })
      .toArray();

    return docs.map(d => ({
      id: d.id as number,
      content_session_id: d.content_session_id as string,
      memory_session_id: d.memory_session_id as string,
      project: d.project as string,
      platform_source: (d.platform_source ?? DEFAULT_PLATFORM_SOURCE) as string,
      user_prompt: (d.user_prompt ?? '') as string,
      custom_title: (d.custom_title ?? null) as string | null,
      started_at: d.started_at as string,
      started_at_epoch: d.started_at_epoch as number,
      completed_at: (d.completed_at ?? null) as string | null,
      completed_at_epoch: (d.completed_at_epoch ?? null) as number | null,
      status: d.status as string,
    }));
  }

  async getRecentSessionsWithStatus(project: string, limit = 3) {
    const docs = await sessions()
      .find<any>({ project, memory_session_id: { $ne: null } })
      .sort({ started_at_epoch: -1 })
      .limit(limit)
      .toArray();

    // Sort ascending (mirrors SQLite outer ORDER BY started_at_epoch ASC)
    docs.sort((a, b) => a.started_at_epoch - b.started_at_epoch);

    const results = await Promise.all(
      docs.map(async d => {
        const hasSummary = !!(await summaries().countDocuments(
          { memory_session_id: d.memory_session_id },
          { limit: 1 },
        ));
        return {
          memory_session_id: (d.memory_session_id ?? null) as string | null,
          status: d.status as string,
          started_at: d.started_at as string,
          user_prompt: (d.user_prompt ?? null) as string | null,
          has_summary: hasSummary,
        };
      }),
    );

    return results;
  }

  // ─── Observations ────────────────────────────────────────────────────────

  async storeObservation(
    memorySessionId: string,
    project: string,
    observation: StoreObservationInput,
    promptNumber?: number,
    discoveryTokens = 0,
    overrideTimestampEpoch?: number,
    generatedByModel?: string,
  ): Promise<{ id: number; createdAtEpoch: number }> {
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const timestampIso = new Date(timestampEpoch).toISOString();
    const contentHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);

    // Upsert on (memory_session_id, content_hash) — equivalent to ON CONFLICT DO NOTHING
    const existing = await observations().findOne<{ id: number; created_at_epoch: number }>(
      { memory_session_id: memorySessionId, content_hash: contentHash },
      { projection: { id: 1, created_at_epoch: 1 } },
    );
    if (existing) return { id: existing.id, createdAtEpoch: existing.created_at_epoch };

    const id = await nextId(db(), 'observations');
    await observations().insertOne({
      id,
      memory_session_id: memorySessionId,
      project,
      type: observation.type,
      title: observation.title,
      subtitle: observation.subtitle,
      facts: observation.facts,
      narrative: observation.narrative,
      concepts: observation.concepts,
      files_read: observation.files_read,
      files_modified: observation.files_modified,
      prompt_number: promptNumber ?? null,
      discovery_tokens: discoveryTokens,
      agent_type: observation.agent_type ?? null,
      agent_id: observation.agent_id ?? null,
      content_hash: contentHash,
      generated_by_model: generatedByModel ?? null,
      metadata: observation.metadata ?? null,
      created_at: timestampIso,
      created_at_epoch: timestampEpoch,
    });

    return { id, createdAtEpoch: timestampEpoch };
  }

  async storeObservations(
    memorySessionId: string,
    project: string,
    obsArray: StoreObservationInput[],
    summary: StoreSummaryInput | null,
    promptNumber?: number,
    discoveryTokens = 0,
    overrideTimestampEpoch?: number,
    generatedByModel?: string,
  ): Promise<{ observationIds: number[]; summaryId: number | null; createdAtEpoch: number }> {
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();

    const observationIds: number[] = [];
    for (const obs of obsArray) {
      const { id } = await this.storeObservation(
        memorySessionId, project, obs, promptNumber, discoveryTokens, timestampEpoch, generatedByModel,
      );
      observationIds.push(id);
    }

    let summaryId: number | null = null;
    if (summary) {
      const { id } = await this.storeSummary(
        memorySessionId, project, summary, promptNumber, discoveryTokens, timestampEpoch,
      );
      summaryId = id;
    }

    return { observationIds, summaryId, createdAtEpoch: timestampEpoch };
  }

  async getRecentObservations(project: string, limit = 20) {
    const docs = await observations()
      .find<any>({ project })
      .sort({ created_at_epoch: -1 })
      .limit(limit)
      .project({ type: 1, narrative: 1, prompt_number: 1, created_at: 1 })
      .toArray();

    return docs.map(d => ({
      type: d.type as string,
      text: (d.narrative ?? '') as string,
      prompt_number: (d.prompt_number ?? null) as number | null,
      created_at: d.created_at as string,
    }));
  }

  async getAllRecentObservations(limit = 100) {
    const pipeline = [
      { $sort: { created_at_epoch: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: COLLECTIONS.SESSIONS,
          localField: 'memory_session_id',
          foreignField: 'memory_session_id',
          as: '_session',
        },
      },
      { $addFields: { _sess: { $arrayElemAt: ['$_session', 0] } } },
    ];

    const docs = await observations().aggregate<any>(pipeline).toArray();

    return docs.map(d => ({
      id: d.id as number,
      type: d.type as string,
      title: (d.title ?? null) as string | null,
      subtitle: (d.subtitle ?? null) as string | null,
      text: (d.narrative ?? '') as string,
      project: d.project as string,
      platform_source: (d._sess?.platform_source ?? DEFAULT_PLATFORM_SOURCE) as string,
      prompt_number: (d.prompt_number ?? null) as number | null,
      created_at: d.created_at as string,
      created_at_epoch: d.created_at_epoch as number,
    }));
  }

  async getObservationById(id: number): Promise<ObservationRecord | null> {
    const doc = await observations().findOne<any>({ id });
    return doc ? normalizeObsOut(strip(doc)) as ObservationRecord : null;
  }

  async getObservationsByIds(
    ids: number[],
    options: {
      orderBy?: 'date_desc' | 'date_asc' | 'relevance';
      limit?: number;
      project?: string;
      type?: string | string[];
      concepts?: string | string[];
      files?: string | string[];
    } = {},
  ): Promise<ObservationSearchResult[]> {
    if (ids.length === 0) return [];

    const { orderBy = 'date_desc', limit, project, type, concepts, files } = options;
    const filter: Record<string, unknown> = { id: { $in: ids } };

    if (project) filter.project = project;
    if (type) filter.type = Array.isArray(type) ? { $in: type } : type;
    if (concepts) {
      const cList = Array.isArray(concepts) ? concepts : [concepts];
      filter.concepts = { $in: cList };
    }
    if (files) {
      const fList = Array.isArray(files) ? files : [files];
      const regex = fList.map(f => new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      filter.$or = [{ files_read: { $in: regex } }, { files_modified: { $in: regex } }];
    }

    let cursor = observations().find<any>(filter);
    if (orderBy !== 'relevance') {
      cursor = cursor.sort({ created_at_epoch: orderBy === 'date_asc' ? 1 : -1 });
    }
    if (limit) cursor = cursor.limit(limit);

    const docs = await cursor.toArray();
    const rows = docs.map(d => normalizeObsOut(strip(d))) as ObservationSearchResult[];

    if (orderBy === 'relevance') {
      const map = new Map(rows.map(r => [r.id, r]));
      return ids.map(id => map.get(id)).filter((r): r is ObservationSearchResult => !!r);
    }

    return rows;
  }

  async getObservationsForSession(memorySessionId: string) {
    const docs = await observations()
      .find<any>({ memory_session_id: memorySessionId })
      .sort({ created_at_epoch: 1 })
      .project({ title: 1, subtitle: 1, type: 1, prompt_number: 1 })
      .toArray();

    return docs.map(d => ({
      title: (d.title ?? '') as string,
      subtitle: (d.subtitle ?? '') as string,
      type: d.type as string,
      prompt_number: (d.prompt_number ?? null) as number | null,
    }));
  }

  async getFilesForSession(memorySessionId: string): Promise<{ filesRead: string[]; filesModified: string[] }> {
    const docs = await observations()
      .find<any>({ memory_session_id: memorySessionId })
      .project({ files_read: 1, files_modified: 1 })
      .toArray();

    const readSet = new Set<string>();
    const modSet = new Set<string>();

    for (const d of docs) {
      parseArrayField(d.files_read).forEach(f => readSet.add(f));
      parseArrayField(d.files_modified).forEach(f => modSet.add(f));
    }

    return { filesRead: Array.from(readSet), filesModified: Array.from(modSet) };
  }

  // ─── Summaries ───────────────────────────────────────────────────────────

  async storeSummary(
    memorySessionId: string,
    project: string,
    summary: StoreSummaryInput,
    promptNumber?: number,
    discoveryTokens = 0,
    overrideTimestampEpoch?: number,
  ): Promise<{ id: number; createdAtEpoch: number }> {
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const id = await nextId(db(), 'session_summaries');
    await summaries().insertOne({
      id,
      memory_session_id: memorySessionId,
      project,
      request: summary.request,
      investigated: summary.investigated,
      learned: summary.learned,
      completed: summary.completed,
      next_steps: summary.next_steps,
      notes: summary.notes,
      prompt_number: promptNumber ?? null,
      discovery_tokens: discoveryTokens,
      created_at: new Date(timestampEpoch).toISOString(),
      created_at_epoch: timestampEpoch,
    });
    return { id, createdAtEpoch: timestampEpoch };
  }

  async getRecentSummaries(project: string, limit = 10) {
    const docs = await summaries()
      .find<any>({ project })
      .sort({ created_at_epoch: -1 })
      .limit(limit)
      .toArray();

    return docs.map(d => ({
      request: (d.request ?? null) as string | null,
      investigated: (d.investigated ?? null) as string | null,
      learned: (d.learned ?? null) as string | null,
      completed: (d.completed ?? null) as string | null,
      next_steps: (d.next_steps ?? null) as string | null,
      files_read: (d.files_read ?? null) as string | null,
      files_edited: (d.files_edited ?? null) as string | null,
      notes: (d.notes ?? null) as string | null,
      prompt_number: (d.prompt_number ?? null) as number | null,
      created_at: d.created_at as string,
    }));
  }

  async getRecentSummariesWithSessionInfo(project: string, limit = 3) {
    const docs = await summaries()
      .find<any>({ project })
      .sort({ created_at_epoch: -1 })
      .limit(limit)
      .toArray();

    return docs.map(d => ({
      memory_session_id: d.memory_session_id as string,
      request: (d.request ?? null) as string | null,
      learned: (d.learned ?? null) as string | null,
      completed: (d.completed ?? null) as string | null,
      next_steps: (d.next_steps ?? null) as string | null,
      prompt_number: (d.prompt_number ?? null) as number | null,
      created_at: d.created_at as string,
    }));
  }

  async getAllRecentSummaries(limit = 50) {
    const pipeline = [
      { $sort: { created_at_epoch: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: COLLECTIONS.SESSIONS,
          localField: 'memory_session_id',
          foreignField: 'memory_session_id',
          as: '_session',
        },
      },
      { $addFields: { _sess: { $arrayElemAt: ['$_session', 0] } } },
    ];

    const docs = await summaries().aggregate<any>(pipeline).toArray();

    return docs.map(d => ({
      id: d.id as number,
      request: (d.request ?? null) as string | null,
      investigated: (d.investigated ?? null) as string | null,
      learned: (d.learned ?? null) as string | null,
      completed: (d.completed ?? null) as string | null,
      next_steps: (d.next_steps ?? null) as string | null,
      files_read: (d.files_read ?? null) as string | null,
      files_edited: (d.files_edited ?? null) as string | null,
      notes: (d.notes ?? null) as string | null,
      project: d.project as string,
      platform_source: (d._sess?.platform_source ?? DEFAULT_PLATFORM_SOURCE) as string,
      prompt_number: (d.prompt_number ?? null) as number | null,
      created_at: d.created_at as string,
      created_at_epoch: d.created_at_epoch as number,
    }));
  }

  async getSummaryForSession(memorySessionId: string) {
    const doc = await summaries()
      .find<any>({ memory_session_id: memorySessionId })
      .sort({ created_at_epoch: -1 })
      .limit(1)
      .next();

    if (!doc) return null;

    return {
      request: (doc.request ?? null) as string | null,
      investigated: (doc.investigated ?? null) as string | null,
      learned: (doc.learned ?? null) as string | null,
      completed: (doc.completed ?? null) as string | null,
      next_steps: (doc.next_steps ?? null) as string | null,
      files_read: (doc.files_read ?? null) as string | null,
      files_edited: (doc.files_edited ?? null) as string | null,
      notes: (doc.notes ?? null) as string | null,
      prompt_number: (doc.prompt_number ?? null) as number | null,
      created_at: doc.created_at as string,
      created_at_epoch: doc.created_at_epoch as number,
    };
  }

  async getSessionSummariesByIds(
    ids: number[],
    options: { orderBy?: 'date_desc' | 'date_asc' | 'relevance'; limit?: number; project?: string } = {},
  ): Promise<SessionSummarySearchResult[]> {
    if (ids.length === 0) return [];
    const { orderBy = 'date_desc', limit, project } = options;

    const filter: Record<string, unknown> = { id: { $in: ids } };
    if (project) filter.project = project;

    let cursor = summaries().find<any>(filter);
    if (orderBy !== 'relevance') cursor = cursor.sort({ created_at_epoch: orderBy === 'date_asc' ? 1 : -1 });
    if (limit) cursor = cursor.limit(limit);

    const rows = (await cursor.toArray()).map(d => strip(d)) as SessionSummarySearchResult[];
    if (orderBy !== 'relevance') return rows;

    const map = new Map(rows.map(r => [r.id, r]));
    return ids.map(id => map.get(id)).filter((r): r is SessionSummarySearchResult => !!r);
  }

  // ─── User prompts ────────────────────────────────────────────────────────

  async saveUserPrompt(contentSessionId: string, promptNumber: number, promptText: string): Promise<number> {
    const now = new Date();
    const id = await nextId(db(), 'user_prompts');
    await prompts().insertOne({
      id,
      content_session_id: contentSessionId,
      prompt_number: promptNumber,
      prompt_text: normalizeStoredPromptText(promptText),
      created_at: now.toISOString(),
      created_at_epoch: now.getTime(),
    });
    return id;
  }

  async getUserPrompt(contentSessionId: string, promptNumber: number): Promise<string | null> {
    const doc = await prompts().findOne<any>({ content_session_id: contentSessionId, prompt_number: promptNumber });
    return (doc?.prompt_text ?? null) as string | null;
  }

  async getLatestUserPrompt(contentSessionId: string) {
    const pipeline = [
      { $match: { content_session_id: contentSessionId } },
      { $sort: { created_at_epoch: -1 } },
      { $limit: 1 },
      {
        $lookup: {
          from: COLLECTIONS.SESSIONS,
          localField: 'content_session_id',
          foreignField: 'content_session_id',
          as: '_session',
        },
      },
      { $addFields: { _sess: { $arrayElemAt: ['$_session', 0] } } },
    ];

    const doc = await prompts().aggregate<any>(pipeline).next();
    if (!doc) return undefined;

    return {
      id: doc.id as number,
      content_session_id: doc.content_session_id as string,
      memory_session_id: (doc._sess?.memory_session_id ?? '') as string,
      project: (doc._sess?.project ?? '') as string,
      platform_source: (doc._sess?.platform_source ?? DEFAULT_PLATFORM_SOURCE) as string,
      prompt_number: doc.prompt_number as number,
      prompt_text: doc.prompt_text as string,
      created_at_epoch: doc.created_at_epoch as number,
    };
  }

  async findRecentDuplicateUserPrompt(
    contentSessionId: string,
    promptText: string,
    windowMs: number,
  ) {
    const cutoffEpoch = Date.now() - windowMs;
    const normalized = normalizeStoredPromptText(promptText);

    const pipeline = [
      {
        $match: {
          content_session_id: contentSessionId,
          prompt_text: normalized,
          created_at_epoch: { $gte: cutoffEpoch },
        },
      },
      { $sort: { created_at_epoch: -1 } },
      { $limit: 1 },
      {
        $lookup: {
          from: COLLECTIONS.SESSIONS,
          localField: 'content_session_id',
          foreignField: 'content_session_id',
          as: '_session',
        },
      },
      { $addFields: { _sess: { $arrayElemAt: ['$_session', 0] } } },
    ];

    const doc = await prompts().aggregate<any>(pipeline).next();
    if (!doc) return undefined;

    return {
      id: doc.id as number,
      content_session_id: doc.content_session_id as string,
      memory_session_id: (doc._sess?.memory_session_id ?? '') as string,
      project: (doc._sess?.project ?? '') as string,
      platform_source: (doc._sess?.platform_source ?? DEFAULT_PLATFORM_SOURCE) as string,
      prompt_number: doc.prompt_number as number,
      prompt_text: doc.prompt_text as string,
      created_at_epoch: doc.created_at_epoch as number,
    };
  }

  async getPromptNumberFromUserPrompts(contentSessionId: string): Promise<number> {
    return prompts().countDocuments({ content_session_id: contentSessionId });
  }

  async getAllRecentUserPrompts(limit = 100) {
    const pipeline = [
      { $sort: { created_at_epoch: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: COLLECTIONS.SESSIONS,
          localField: 'content_session_id',
          foreignField: 'content_session_id',
          as: '_session',
        },
      },
      { $addFields: { _sess: { $arrayElemAt: ['$_session', 0] } } },
    ];

    const docs = await prompts().aggregate<any>(pipeline).toArray();

    return docs.map(d => ({
      id: d.id as number,
      content_session_id: d.content_session_id as string,
      project: (d._sess?.project ?? '') as string,
      platform_source: (d._sess?.platform_source ?? DEFAULT_PLATFORM_SOURCE) as string,
      prompt_number: d.prompt_number as number,
      prompt_text: d.prompt_text as string,
      created_at: d.created_at as string,
      created_at_epoch: d.created_at_epoch as number,
    }));
  }

  async getPromptById(id: number) {
    const pipeline = [
      { $match: { id } },
      {
        $lookup: {
          from: COLLECTIONS.SESSIONS,
          localField: 'content_session_id',
          foreignField: 'content_session_id',
          as: '_session',
        },
      },
      { $addFields: { _sess: { $arrayElemAt: ['$_session', 0] } } },
      { $limit: 1 },
    ];

    const doc = await prompts().aggregate<any>(pipeline).next();
    if (!doc) return null;

    return {
      id: doc.id as number,
      content_session_id: doc.content_session_id as string,
      prompt_number: doc.prompt_number as number,
      prompt_text: doc.prompt_text as string,
      project: (doc._sess?.project ?? '') as string,
      created_at: doc.created_at as string,
      created_at_epoch: doc.created_at_epoch as number,
    };
  }

  async getPromptsByIds(ids: number[]) {
    if (ids.length === 0) return [];

    const pipeline = [
      { $match: { id: { $in: ids } } },
      {
        $lookup: {
          from: COLLECTIONS.SESSIONS,
          localField: 'content_session_id',
          foreignField: 'content_session_id',
          as: '_session',
        },
      },
      { $addFields: { _sess: { $arrayElemAt: ['$_session', 0] } } },
      { $sort: { created_at_epoch: -1 } },
    ];

    const docs = await prompts().aggregate<any>(pipeline).toArray();

    return docs.map(d => ({
      id: d.id as number,
      content_session_id: d.content_session_id as string,
      prompt_number: d.prompt_number as number,
      prompt_text: d.prompt_text as string,
      project: (d._sess?.project ?? '') as string,
      created_at: d.created_at as string,
      created_at_epoch: d.created_at_epoch as number,
    }));
  }

  async getUserPromptsByIds(
    ids: number[],
    options: { orderBy?: 'date_desc' | 'date_asc' | 'relevance'; limit?: number; project?: string } = {},
  ): Promise<UserPromptRecord[]> {
    if (ids.length === 0) return [];
    const { orderBy = 'date_desc', limit, project } = options;

    const filter: Record<string, unknown> = { id: { $in: ids } };

    const pipeline: object[] = [
      { $match: filter },
      {
        $lookup: {
          from: COLLECTIONS.SESSIONS,
          localField: 'content_session_id',
          foreignField: 'content_session_id',
          as: '_session',
        },
      },
      { $addFields: { _sess: { $arrayElemAt: ['$_session', 0] } } },
    ];

    if (project) pipeline.push({ $match: { '_sess.project': project } });
    if (orderBy !== 'relevance') {
      pipeline.push({ $sort: { created_at_epoch: orderBy === 'date_asc' ? 1 : -1 } });
    }
    if (limit) pipeline.push({ $limit: limit });

    const docs = await prompts().aggregate<any>(pipeline).toArray();
    const rows = docs.map(d => ({
      id: d.id,
      content_session_id: d.content_session_id,
      prompt_number: d.prompt_number,
      prompt_text: d.prompt_text,
      project: d._sess?.project ?? '',
      memory_session_id: d._sess?.memory_session_id ?? null,
      created_at: d.created_at,
      created_at_epoch: d.created_at_epoch,
    })) as UserPromptRecord[];

    if (orderBy === 'relevance') {
      const map = new Map(rows.map(r => [r.id, r]));
      return ids.map(id => map.get(id)).filter((r): r is UserPromptRecord => !!r);
    }

    return rows;
  }

  // ─── Projects ────────────────────────────────────────────────────────────

  async getAllProjects(platformSource?: string): Promise<string[]> {
    const normalized = platformSource ? normalizePlatformSource(platformSource) : undefined;
    const filter: Record<string, unknown> = {
      project: { $ne: null, $nin: ['', OBSERVER_SESSIONS_PROJECT] },
    };
    if (normalized) filter.platform_source = normalized;

    const result = await sessions()
      .distinct('project', filter) as string[];

    return result.sort();
  }

  async getProjectCatalog() {
    const pipeline = [
      {
        $match: {
          project: { $ne: null, $nin: ['', OBSERVER_SESSIONS_PROJECT] },
        },
      },
      {
        $group: {
          _id: {
            platform_source: { $ifNull: ['$platform_source', DEFAULT_PLATFORM_SOURCE] },
            project: '$project',
          },
          latest_epoch: { $max: '$started_at_epoch' },
        },
      },
      { $sort: { latest_epoch: -1 } },
    ];

    const rows = await sessions().aggregate<any>(pipeline).toArray();

    const projects: string[] = [];
    const seenProjects = new Set<string>();
    const projectsBySource: Record<string, string[]> = {};

    for (const row of rows) {
      const source = normalizePlatformSource(row._id.platform_source);
      const project = row._id.project;

      if (!projectsBySource[source]) projectsBySource[source] = [];
      if (!projectsBySource[source].includes(project)) projectsBySource[source].push(project);

      if (!seenProjects.has(project)) {
        seenProjects.add(project);
        projects.push(project);
      }
    }

    const sources = sortPlatformSources(Object.keys(projectsBySource));
    return {
      projects,
      sources,
      projectsBySource: Object.fromEntries(sources.map(s => [s, projectsBySource[s] || []])),
    };
  }

  // ─── Timeline ────────────────────────────────────────────────────────────

  async getTimelineAroundTimestamp(
    anchorEpoch: number,
    depthBefore = 10,
    depthAfter = 10,
    project?: string,
  ) {
    return this.getTimelineAroundObservation(null, anchorEpoch, depthBefore, depthAfter, project);
  }

  async getTimelineAroundObservation(
    anchorObservationId: number | null,
    anchorEpoch: number,
    depthBefore = 10,
    depthAfter = 10,
    project?: string,
  ) {
    const projectFilter = project ? { project } : {};
    let startEpoch: number;
    let endEpoch: number;

    try {
      if (anchorObservationId !== null) {
        const before = await observations()
          .find<any>({ id: { $lte: anchorObservationId }, ...projectFilter })
          .sort({ id: -1 })
          .limit(depthBefore + 1)
          .toArray();

        const after = await observations()
          .find<any>({ id: { $gte: anchorObservationId }, ...projectFilter })
          .sort({ id: 1 })
          .limit(depthAfter + 1)
          .toArray();

        if (before.length === 0 && after.length === 0) return { observations: [], sessions: [], prompts: [] };

        startEpoch = before.length > 0 ? before[before.length - 1].created_at_epoch : anchorEpoch;
        endEpoch = after.length > 0 ? after[after.length - 1].created_at_epoch : anchorEpoch;
      } else {
        const before = await observations()
          .find<any>({ created_at_epoch: { $lte: anchorEpoch }, ...projectFilter })
          .sort({ created_at_epoch: -1 })
          .limit(depthBefore)
          .toArray();

        const after = await observations()
          .find<any>({ created_at_epoch: { $gte: anchorEpoch }, ...projectFilter })
          .sort({ created_at_epoch: 1 })
          .limit(depthAfter + 1)
          .toArray();

        if (before.length === 0 && after.length === 0) return { observations: [], sessions: [], prompts: [] };

        startEpoch = before.length > 0 ? before[before.length - 1].created_at_epoch : anchorEpoch;
        endEpoch = after.length > 0 ? after[after.length - 1].created_at_epoch : anchorEpoch;
      }
    } catch (err) {
      logger.error('DB', 'Error getting timeline boundary', {}, err instanceof Error ? err : new Error(String(err)));
      return { observations: [], sessions: [], prompts: [] };
    }

    const epochFilter = { created_at_epoch: { $gte: startEpoch, $lte: endEpoch } };

    const [obsDocs, sumDocs, promptDocs] = await Promise.all([
      observations().find<any>({ ...epochFilter, ...projectFilter }).sort({ created_at_epoch: 1 }).toArray(),
      summaries().find<any>({ ...epochFilter, ...projectFilter }).sort({ created_at_epoch: 1 }).toArray(),
      prompts().aggregate<any>([
        { $match: { ...epochFilter } },
        {
          $lookup: {
            from: COLLECTIONS.SESSIONS,
            localField: 'content_session_id',
            foreignField: 'content_session_id',
            as: '_sess',
          },
        },
        { $addFields: { _sess: { $arrayElemAt: ['$_sess', 0] } } },
        ...(project ? [{ $match: { '_sess.project': project } }] : []),
        { $sort: { created_at_epoch: 1 } },
      ]).toArray(),
    ]);

    return {
      observations: obsDocs.map(d => normalizeObsOut(strip(d))),
      sessions: sumDocs.map(d => ({
        id: d.id,
        memory_session_id: d.memory_session_id,
        project: d.project,
        request: d.request,
        completed: d.completed,
        next_steps: d.next_steps,
        created_at: d.created_at,
        created_at_epoch: d.created_at_epoch,
      })),
      prompts: promptDocs.map(d => ({
        id: d.id,
        content_session_id: d.content_session_id,
        prompt_number: d.prompt_number,
        prompt_text: d.prompt_text,
        project: d._sess?.project ?? '',
        created_at: d.created_at,
        created_at_epoch: d.created_at_epoch,
      })),
    };
  }

  // ─── Stats ───────────────────────────────────────────────────────────────

  async getStats() {
    const [totalObservations, totalSessions, totalSummaries] = await Promise.all([
      observations().countDocuments(),
      sessions().countDocuments(),
      summaries().countDocuments(),
    ]);
    return { totalObservations, totalSessions, totalSummaries };
  }

  // ─── Pagination helpers ──────────────────────────────────────────────────

  async getPaginatedObservations(offset: number, limit: number, project?: string, platformSource?: string) {
    const filter: Record<string, unknown> = {};

    if (project) {
      filter.$or = [{ project }, { merged_into_project: project }];
    } else {
      filter.project = { $ne: OBSERVER_SESSIONS_PROJECT };
    }

    if (platformSource) {
      // Join via sessions — handled via aggregation
      const pipeline = [
        { $match: filter },
        {
          $lookup: {
            from: COLLECTIONS.SESSIONS,
            localField: 'memory_session_id',
            foreignField: 'memory_session_id',
            as: '_sess',
          },
        },
        { $addFields: { _sess: { $arrayElemAt: ['$_sess', 0] } } },
        { $match: { '_sess.platform_source': platformSource } },
        {
          $addFields: {
            platform_source: { $ifNull: ['$_sess.platform_source', DEFAULT_PLATFORM_SOURCE] },
          },
        },
        { $sort: { created_at_epoch: -1 } },
        { $skip: offset },
        { $limit: limit + 1 },
      ];

      const results = await observations().aggregate<any>(pipeline).toArray();
      return {
        items: results.slice(0, limit).map(d => normalizeObsOut(strip(d))),
        hasMore: results.length > limit,
        offset,
        limit,
      };
    }

    const pipeline = [
      { $match: filter },
      {
        $lookup: {
          from: COLLECTIONS.SESSIONS,
          localField: 'memory_session_id',
          foreignField: 'memory_session_id',
          as: '_sess',
          pipeline: [{ $project: { platform_source: 1 } }],
        },
      },
      {
        $addFields: {
          platform_source: {
            $ifNull: [{ $arrayElemAt: ['$_sess.platform_source', 0] }, DEFAULT_PLATFORM_SOURCE],
          },
        },
      },
      { $sort: { created_at_epoch: -1 } },
      { $skip: offset },
      { $limit: limit + 1 },
    ];

    const results = await observations().aggregate<any>(pipeline).toArray();
    return {
      items: results.slice(0, limit).map(d => normalizeObsOut(strip(d))),
      hasMore: results.length > limit,
      offset,
      limit,
    };
  }

  async getPaginatedSummaries(offset: number, limit: number, project?: string, platformSource?: string) {
    const filter: Record<string, unknown> = {};
    if (project) filter.project = project;

    const pipeline: object[] = [
      { $match: filter },
      {
        $lookup: {
          from: COLLECTIONS.SESSIONS,
          localField: 'memory_session_id',
          foreignField: 'memory_session_id',
          as: '_sess',
          pipeline: [{ $project: { content_session_id: 1, platform_source: 1 } }],
        },
      },
      {
        $addFields: {
          session_id: { $arrayElemAt: ['$_sess.content_session_id', 0] },
          platform_source: {
            $ifNull: [{ $arrayElemAt: ['$_sess.platform_source', 0] }, DEFAULT_PLATFORM_SOURCE],
          },
        },
      },
    ];

    if (platformSource) pipeline.push({ $match: { platform_source: platformSource } });
    pipeline.push({ $sort: { created_at_epoch: -1 } }, { $skip: offset }, { $limit: limit + 1 });

    const results = await summaries().aggregate<any>(pipeline).toArray();
    return {
      items: results.slice(0, limit).map(d => strip(d)),
      hasMore: results.length > limit,
      offset,
      limit,
    };
  }

  async getPaginatedSessions(offset: number, limit: number, project?: string, platformSource?: string) {
    const filter: Record<string, unknown> = {
      project: { $ne: OBSERVER_SESSIONS_PROJECT },
    };
    if (project) filter.project = project;
    if (platformSource) filter.platform_source = platformSource;

    const docs = await sessions()
      .find<any>(filter)
      .sort({ started_at_epoch: -1 })
      .skip(offset)
      .limit(limit + 1)
      .toArray();

    return {
      items: docs.slice(0, limit).map(d => strip(d)),
      hasMore: docs.length > limit,
      offset,
      limit,
    };
  }

  async getPaginatedPrompts(offset: number, limit: number, project?: string, platformSource?: string) {
    const pipeline: object[] = [
      {
        $lookup: {
          from: COLLECTIONS.SESSIONS,
          localField: 'content_session_id',
          foreignField: 'content_session_id',
          as: '_sess',
          pipeline: [{ $project: { project: 1, platform_source: 1 } }],
        },
      },
      {
        $addFields: {
          project: { $arrayElemAt: ['$_sess.project', 0] },
          platform_source: {
            $ifNull: [{ $arrayElemAt: ['$_sess.platform_source', 0] }, DEFAULT_PLATFORM_SOURCE],
          },
        },
      },
    ];

    if (project) pipeline.push({ $match: { project } });
    if (platformSource) pipeline.push({ $match: { platform_source: platformSource } });
    pipeline.push(
      { $sort: { created_at_epoch: -1 } },
      { $skip: offset },
      { $limit: limit + 1 },
    );

    const results = await prompts().aggregate<any>(pipeline).toArray();
    return {
      items: results.slice(0, limit).map(d => strip(d)),
      hasMore: results.length > limit,
      offset,
      limit,
    };
  }

  // ─── Import ──────────────────────────────────────────────────────────────

  async importSdkSession(session: any): Promise<{ imported: boolean; id: number }> {
    const existing = await sessions().findOne<{ id: number }>({ content_session_id: session.content_session_id }, { projection: { id: 1 } });
    if (existing) return { imported: false, id: existing.id };

    const id = await nextId(db(), 'sdk_sessions');
    await sessions().insertOne({ id, ...session });
    return { imported: true, id };
  }

  async importSessionSummary(summary: any): Promise<{ imported: boolean; id: number }> {
    const id = await nextId(db(), 'session_summaries');
    await summaries().insertOne({ id, ...summary });
    return { imported: true, id };
  }

  async importObservation(obs: any): Promise<{ imported: boolean; id: number }> {
    if (obs.content_hash && obs.memory_session_id) {
      const existing = await observations().findOne<{ id: number }>(
        { memory_session_id: obs.memory_session_id, content_hash: obs.content_hash },
        { projection: { id: 1 } },
      );
      if (existing) return { imported: false, id: existing.id };
    }

    const doc = {
      ...obs,
      facts: obs.facts ? parseArrayField(obs.facts) : [],
      concepts: obs.concepts ? parseArrayField(obs.concepts) : [],
      files_read: obs.files_read ? parseArrayField(obs.files_read) : [],
      files_modified: obs.files_modified ? parseArrayField(obs.files_modified) : [],
    };

    const id = await nextId(db(), 'observations');
    await observations().insertOne({ id, ...doc });
    return { imported: true, id };
  }

  async importUserPrompt(prompt: any): Promise<{ imported: boolean; id: number }> {
    const id = await nextId(db(), 'user_prompts');
    await prompts().insertOne({ id, ...prompt });
    return { imported: true, id };
  }

  async close(): Promise<void> {
    // Connection is managed by MongoConnection singleton — no-op here
  }
}
