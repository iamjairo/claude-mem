
import express, { Request, Response } from 'express';
import { z } from 'zod';
import path from 'path';
import { readFileSync, statSync, existsSync } from 'fs';
import { logger } from '../../../../utils/logger.js';
import { getPackageRoot, paths } from '../../../../shared/paths.js';
import { getWorkerPort } from '../../../../shared/worker-utils.js';
import { PaginationHelper } from '../../PaginationHelper.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import { SessionManager } from '../../SessionManager.js';
import { SSEBroadcaster } from '../../SSEBroadcaster.js';
import type { WorkerService } from '../../../worker-service.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { validateBody } from '../middleware/validateBody.js';
import { normalizePlatformSource } from '../../../../shared/platform-source.js';
import { getObservationsByFilePath } from '../../../sqlite/observations/get.js';
import { getFirstObservationCreatedAt } from '../../../sqlite/observations/recent.js';
import { getUptimeSeconds } from '../../../../shared/uptime.js';

const integerArrayLike = z.preprocess((value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // not JSON, fall through to comma split
    }
    return value.split(',').map((part) => Number(part.trim()));
  }
  return value;
}, z.array(z.number().int()));

const stringArrayLike = z.preprocess((value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // not JSON, fall through to comma split
    }
    return value.split(',').map((part) => part.trim()).filter(Boolean);
  }
  return value;
}, z.array(z.string()));

const observationsBatchSchema = z.object({
  ids: integerArrayLike,
  orderBy: z.enum(['date_desc', 'date_asc']).optional(),
  limit: z.number().int().positive().optional(),
  project: z.string().optional(),
}).passthrough();

const sdkSessionsBatchSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;

  const body = value as Record<string, unknown>;
  if (body.memorySessionIds === undefined && body.sdkSessionIds !== undefined) {
    return { ...body, memorySessionIds: body.sdkSessionIds };
  }

  return value;
}, z.object({
  memorySessionIds: stringArrayLike,
}).passthrough());

const importSchema = z.object({
  sessions: z.array(z.unknown()).optional(),
  summaries: z.array(z.unknown()).optional(),
  observations: z.array(z.unknown()).optional(),
  prompts: z.array(z.unknown()).optional(),
}).passthrough();

export class DataRoutes extends BaseRouteHandler {
  constructor(
    private paginationHelper: PaginationHelper,
    private dbManager: DatabaseManager,
    private sessionManager: SessionManager,
    private sseBroadcaster: SSEBroadcaster,
    private workerService: WorkerService,
    private startTime: number
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/observations', this.handleGetObservations.bind(this));
    app.get('/api/summaries', this.handleGetSummaries.bind(this));
    app.get('/api/prompts', this.handleGetPrompts.bind(this));

    app.get('/api/observation/:id', this.handleGetObservationById.bind(this));
    app.get('/api/observations/by-file', this.handleGetObservationsByFile.bind(this));
    app.post('/api/observations/batch', validateBody(observationsBatchSchema), this.handleGetObservationsByIds.bind(this));
    app.get('/api/session/:id', this.handleGetSessionById.bind(this));
    app.post('/api/sdk-sessions/batch', validateBody(sdkSessionsBatchSchema), this.handleGetSdkSessionsByIds.bind(this));
    app.get('/api/prompt/:id', this.handleGetPromptById.bind(this));

    app.get('/api/stats', this.handleGetStats.bind(this));
    app.get('/api/projects', this.handleGetProjects.bind(this));

    app.get('/api/processing-status', this.handleGetProcessingStatus.bind(this));

    app.post('/api/import', validateBody(importSchema), this.handleImport.bind(this));
  }

  private handleGetObservations = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { offset, limit, project, platformSource } = this.parsePaginationParams(req);
    const store = this.dbManager.getStore();
    const result = await store.getPaginatedObservations(offset, limit, project, platformSource);
    // Sanitize file paths (mirrors PaginationHelper.sanitizeObservation for SQLite path)
    res.json({
      ...result,
      items: result.items.map((obs: any) => obs)
    });
  });

  private handleGetSummaries = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { offset, limit, project, platformSource } = this.parsePaginationParams(req);
    const store = this.dbManager.getStore();
    const result = await store.getPaginatedSummaries(offset, limit, project, platformSource);
    res.json(result);
  });

  private handleGetPrompts = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { offset, limit, project, platformSource } = this.parsePaginationParams(req);
    const store = this.dbManager.getStore();
    const result = await store.getPaginatedPrompts(offset, limit, project, platformSource);
    res.json(result);
  });

  private handleGetObservationById = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const store = this.dbManager.getStore();
    const observation = await store.getObservationById(id);

    if (!observation) {
      this.notFound(res, `Observation #${id} not found`);
      return;
    }

    res.json(observation);
  });

  private handleGetObservationsByFile = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    // #2691 — `path` may be repeated (?path=abs&path=rel) to carry multiple
    // candidate forms (absolute, project-root-relative, cwd-relative) so the
    // query matches however PostToolUse stored the path. Paths can contain
    // commas, so we rely on repeated query params rather than comma-splitting.
    const rawPath = req.query.path;
    const candidatePaths = (Array.isArray(rawPath) ? rawPath : [rawPath])
      .filter((p): p is string => typeof p === 'string' && p.length > 0);
    if (candidatePaths.length === 0) {
      this.badRequest(res, 'path query parameter is required');
      return;
    }

    const projectsParam = req.query.projects as string | undefined;
    const projects = projectsParam ? projectsParam.split(',').filter(Boolean) : undefined;
    const parsedLimit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const limit = Number.isFinite(parsedLimit) && parsedLimit! > 0 ? parsedLimit : undefined;

    if (process.env.CLAUDE_MEM_DB_BACKEND === 'mongodb') {
      // MongoDB: use getObservationsByIds-style query via file path filter
      const { getDb, COLLECTIONS } = await import('../../../mongodb/MongoConnection.js');
      const db = getDb();
      const regex = candidatePaths.map(p => new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      const filter: any = {
        $or: [{ files_read: { $in: regex } }, { files_modified: { $in: regex } }],
      };
      if (projects?.length) filter.project = { $in: projects };
      const cursor = db.collection(COLLECTIONS.OBSERVATIONS).find(filter).sort({ created_at_epoch: -1 });
      if (limit) cursor.limit(limit);
      const observations = await cursor.toArray();
      const out = observations.map(({ _id, ...d }) => ({
        ...d,
        facts: Array.isArray(d.facts) ? JSON.stringify(d.facts) : d.facts,
        concepts: Array.isArray(d.concepts) ? JSON.stringify(d.concepts) : d.concepts,
        files_read: Array.isArray(d.files_read) ? JSON.stringify(d.files_read) : d.files_read,
        files_modified: Array.isArray(d.files_modified) ? JSON.stringify(d.files_modified) : d.files_modified,
      }));
      res.json({ observations: out, count: out.length });
      return;
    }

    const db = this.dbManager.getSessionStore().db;
    const observations = getObservationsByFilePath(db, candidatePaths, { projects, limit });
    res.json({ observations, count: observations.length });
  });

  private handleGetObservationsByIds = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { ids, orderBy, limit, project } = req.body as z.infer<typeof observationsBatchSchema>;

    if (ids.length === 0) {
      res.json([]);
      return;
    }

    const store = this.dbManager.getStore();
    const observations = await store.getObservationsByIds(ids, { orderBy, limit, project });

    res.json(observations);
  });

  private handleGetSessionById = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const store = this.dbManager.getStore();
    const sessions = await store.getSessionSummariesByIds([id]);

    if (sessions.length === 0) {
      this.notFound(res, `Session #${id} not found`);
      return;
    }

    res.json(sessions[0]);
  });

  private handleGetSdkSessionsByIds = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { memorySessionIds } = req.body as z.infer<typeof sdkSessionsBatchSchema>;

    const store = this.dbManager.getStore();
    const sessions = await store.getSdkSessionsBySessionIds(memorySessionIds);
    res.json(sessions);
  });

  private handleGetPromptById = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const store = this.dbManager.getStore();
    const prompts = await store.getUserPromptsByIds([id]);

    if (prompts.length === 0) {
      this.notFound(res, `Prompt #${id} not found`);
      return;
    }

    res.json(prompts[0]);
  });

  private handleGetStats = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const store = this.dbManager.getStore();
    const { totalObservations, totalSessions, totalSummaries } = await store.getStats();

    const packageRoot = getPackageRoot();
    const packageJsonPath = path.join(packageRoot, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const version = packageJson.version;

    const dbBackend = process.env.CLAUDE_MEM_DB_BACKEND ?? 'sqlite';
    let dbInfo: Record<string, unknown>;
    if (dbBackend === 'mongodb') {
      dbInfo = {
        backend: 'mongodb',
        uri: (process.env.CLAUDE_MEM_MONGODB_URI ?? 'mongodb://localhost:27017').replace(/\/\/[^@]+@/, '//***@'),
        observations: totalObservations,
        sessions: totalSessions,
        summaries: totalSummaries,
      };
    } else {
      const dbPath = paths.database();
      const dbSize = existsSync(dbPath) ? statSync(dbPath).size : 0;
      const db = this.dbManager.getSessionStore().db;
      const firstObservationAt = getFirstObservationCreatedAt(db);
      dbInfo = {
        backend: 'sqlite',
        path: dbPath,
        size: dbSize,
        observations: totalObservations,
        sessions: totalSessions,
        summaries: totalSummaries,
        firstObservationAt,
      };
    }

    const uptime = getUptimeSeconds(this.startTime);
    const activeSessions = this.sessionManager.getActiveSessionCount();
    const sseClients = this.sseBroadcaster.getClientCount();

    res.json({
      worker: {
        version,
        uptime,
        activeSessions,
        sseClients,
        port: getWorkerPort()
      },
      database: dbInfo,
    });
  });

  private handleGetProjects = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const store = this.dbManager.getStore();
    const rawPlatformSource = req.query.platformSource as string | undefined;
    const platformSource = rawPlatformSource ? normalizePlatformSource(rawPlatformSource) : undefined;

    if (platformSource) {
      const projects = await store.getAllProjects(platformSource);
      res.json({
        projects,
        sources: [platformSource],
        projectsBySource: { [platformSource]: projects }
      });
      return;
    }

    res.json(await store.getProjectCatalog());
  });

  private handleGetProcessingStatus = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const isProcessing = await this.sessionManager.isAnySessionProcessing();
    const queueDepth = await this.sessionManager.getTotalActiveWork();
    res.json({ isProcessing, queueDepth });
  });

  private parsePaginationParams(req: Request): { offset: number; limit: number; project?: string; platformSource?: string } {
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100); 
    const project = req.query.project as string | undefined;
    const rawPlatformSource = req.query.platformSource as string | undefined;
    const platformSource = rawPlatformSource ? normalizePlatformSource(rawPlatformSource) : undefined;

    return { offset, limit, project, platformSource };
  }

  private handleImport = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { sessions, summaries, observations, prompts } = req.body;

    const stats = {
      sessionsImported: 0,
      sessionsSkipped: 0,
      summariesImported: 0,
      summariesSkipped: 0,
      observationsImported: 0,
      observationsSkipped: 0,
      promptsImported: 0,
      promptsSkipped: 0
    };

    const store = this.dbManager.getStore();
    const isMongoBackend = process.env.CLAUDE_MEM_DB_BACKEND === 'mongodb';

    if (Array.isArray(sessions)) {
      for (const session of sessions) {
        const result = await store.importSdkSession(session);
        if (result.imported) {
          stats.sessionsImported++;
        } else {
          stats.sessionsSkipped++;
        }
      }
    }

    if (Array.isArray(summaries)) {
      for (const summary of summaries) {
        const result = await store.importSessionSummary(summary);
        if (result.imported) {
          stats.summariesImported++;
        } else {
          stats.summariesSkipped++;
        }
      }
    }

    const importedObservations: Array<{ id: number; obs: typeof observations[0] }> = [];
    if (Array.isArray(observations)) {
      for (const obs of observations) {
        const result = await store.importObservation(obs);
        if (result.imported) {
          stats.observationsImported++;
          importedObservations.push({ id: result.id, obs });
        } else {
          stats.observationsSkipped++;
        }
      }

      if (!isMongoBackend && stats.observationsImported > 0) {
        // SQLite FTS index rebuild (not needed for MongoDB — text indexes are always live)
        const sqliteStore = this.dbManager.getSessionStore();
        sqliteStore.rebuildObservationsFTSIndex();
      }

      const chromaSync = this.dbManager.getChromaSync();
      if (chromaSync && importedObservations.length > 0) {
        const CHROMA_SYNC_CONCURRENCY = 8;
        const safeParseJson = (val: string | null): string[] => {
          if (!val) return [];
          try { return JSON.parse(val); } catch { return []; }
        };

        const syncOne = async ({ id, obs }: { id: number; obs: any }) => {
          const parsedObs = {
            type: obs.type || 'discovery',
            title: obs.title || null,
            subtitle: obs.subtitle || null,
            facts: safeParseJson(obs.facts),
            narrative: obs.narrative || null,
            concepts: safeParseJson(obs.concepts),
            files_read: safeParseJson(obs.files_read),
            files_modified: safeParseJson(obs.files_modified),
          };

          await chromaSync.syncObservation(
            id,
            obs.memory_session_id,
            obs.project,
            parsedObs,
            obs.prompt_number || 0,
            obs.created_at_epoch
          ).catch(err => {
            logger.error('CHROMA', 'Import ChromaDB sync failed', { id }, err as Error);
          });
        };

        (async () => {
          for (let i = 0; i < importedObservations.length; i += CHROMA_SYNC_CONCURRENCY) {
            const batch = importedObservations.slice(i, i + CHROMA_SYNC_CONCURRENCY);
            await Promise.all(batch.map(syncOne));
          }
        })().catch(err => {
          logger.error('CHROMA', 'Import ChromaDB batch sync failed', {}, err as Error);
        });
      }
    }

    if (Array.isArray(prompts)) {
      for (const prompt of prompts) {
        const result = await store.importUserPrompt(prompt);
        if (result.imported) {
          stats.promptsImported++;
        } else {
          stats.promptsSkipped++;
        }
      }
    }

    res.json({
      success: true,
      stats
    });
  });

}
