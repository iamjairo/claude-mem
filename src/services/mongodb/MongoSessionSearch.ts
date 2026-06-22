import { getDb, COLLECTIONS } from './MongoConnection.js';
import type { ISessionSearch } from './ISessionStore.js';
import type { ObservationSearchResult, SessionSummarySearchResult, SearchOptions } from '../sqlite/types.js';
import { DEFAULT_PLATFORM_SOURCE, normalizePlatformSource } from '../../shared/platform-source.js';
import { AppError } from '../server/ErrorHandler.js';
import { logger } from '../../utils/logger.js';

function observations() { return getDb().collection(COLLECTIONS.OBSERVATIONS); }
function summaries() { return getDb().collection(COLLECTIONS.SESSION_SUMMARIES); }

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

function stripId<T extends { _id?: unknown }>(doc: T): Omit<T, '_id'> {
  const { _id, ...rest } = doc;
  return rest;
}

function buildFilter(options: SearchOptions, isObservation = true): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  const { project, type, concepts, files, dateRange } = options;

  if (project) filter.project = project;

  if (type) filter.type = Array.isArray(type) ? { $in: type } : type;

  if (dateRange) {
    const epochFilter: Record<string, number> = {};
    if (dateRange.start) {
      epochFilter.$gte = typeof dateRange.start === 'number' ? dateRange.start : new Date(dateRange.start).getTime();
    }
    if (dateRange.end) {
      epochFilter.$lte = typeof dateRange.end === 'number' ? dateRange.end : new Date(dateRange.end).getTime();
    }
    if (Object.keys(epochFilter).length > 0) filter.created_at_epoch = epochFilter;
  }

  if (isObservation && concepts) {
    const cList = Array.isArray(concepts) ? concepts : [concepts];
    filter.concepts = { $in: cList };
  }

  if (isObservation && files) {
    const fList = Array.isArray(files) ? files : [files];
    const regexes = fList.map(f => new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    filter.$or = [{ files_read: { $in: regexes } }, { files_modified: { $in: regexes } }];
  }

  return filter;
}

function buildPlatformSourcePipeline(platformSource: string | undefined): object[] {
  if (!platformSource) return [];
  return [
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
      $match: {
        $expr: {
          $eq: [
            { $ifNull: [{ $arrayElemAt: ['$_sess.platform_source', 0] }, DEFAULT_PLATFORM_SOURCE] },
            normalizePlatformSource(platformSource),
          ],
        },
      },
    },
  ];
}

export class MongoSessionSearch implements ISessionSearch {

  async searchObservations(
    query: string | undefined,
    options: SearchOptions = {},
  ): Promise<ObservationSearchResult[]> {
    const { limit = 50, offset = 0, orderBy = 'relevance', platformSource, ...filters } = options;

    const baseFilter = buildFilter({ ...filters }, true);
    const platformPipeline = buildPlatformSourcePipeline(platformSource);

    if (!query) {
      if (Object.keys(baseFilter).length === 0 && platformPipeline.length === 0) {
        throw new AppError('Either query or filters required for search', 400, 'INVALID_SEARCH_REQUEST');
      }

      const pipeline: object[] = [
        { $match: baseFilter },
        ...platformPipeline,
        { $sort: { created_at_epoch: -1 } },
        { $skip: offset },
        { $limit: limit },
      ];

      const docs = await observations().aggregate<any>(pipeline).toArray();
      return docs.map(d => normalizeObsOut(stripId(d))) as ObservationSearchResult[];
    }

    try {
      const pipeline: object[] = [
        {
          $match: {
            $text: { $search: query },
            ...baseFilter,
          },
        },
        ...platformPipeline,
      ];

      if (orderBy === 'relevance') {
        pipeline.push({ $addFields: { score: { $meta: 'textScore' } } });
        pipeline.push({ $sort: { score: -1 } });
      } else {
        pipeline.push({ $sort: { created_at_epoch: orderBy === 'date_asc' ? 1 : -1 } });
      }

      pipeline.push({ $skip: offset }, { $limit: limit });

      const docs = await observations().aggregate<any>(pipeline).toArray();
      return docs.map(d => normalizeObsOut(stripId(d))) as ObservationSearchResult[];
    } catch (err) {
      logger.warn('DB', 'MongoDB text search failed for observations', {}, err instanceof Error ? err : undefined);
      throw err;
    }
  }

  async searchSessions(
    query: string | undefined,
    options: SearchOptions = {},
  ): Promise<SessionSummarySearchResult[]> {
    const { limit = 50, offset = 0, orderBy = 'relevance', platformSource, ...filters } = options;

    const baseFilter = buildFilter({ ...filters }, false);
    const platformPipeline = buildPlatformSourcePipeline(platformSource);

    if (!query) {
      if (Object.keys(baseFilter).length === 0 && platformPipeline.length === 0) {
        throw new AppError('Either query or filters required for search', 400, 'INVALID_SEARCH_REQUEST');
      }

      const pipeline: object[] = [
        { $match: baseFilter },
        ...platformPipeline,
        { $sort: { created_at_epoch: -1 } },
        { $skip: offset },
        { $limit: limit },
      ];

      const docs = await summaries().aggregate<any>(pipeline).toArray();
      return docs.map(d => stripId(d)) as SessionSummarySearchResult[];
    }

    try {
      const pipeline: object[] = [
        { $match: { $text: { $search: query }, ...baseFilter } },
        ...platformPipeline,
      ];

      if (orderBy === 'relevance') {
        pipeline.push({ $addFields: { score: { $meta: 'textScore' } } });
        pipeline.push({ $sort: { score: -1 } });
      } else {
        pipeline.push({ $sort: { created_at_epoch: orderBy === 'date_asc' ? 1 : -1 } });
      }

      pipeline.push({ $skip: offset }, { $limit: limit });

      const docs = await summaries().aggregate<any>(pipeline).toArray();
      return docs.map(d => stripId(d)) as SessionSummarySearchResult[];
    } catch (err) {
      logger.warn('DB', 'MongoDB text search failed for sessions', {}, err instanceof Error ? err : undefined);
      throw err;
    }
  }

  async close(): Promise<void> {
    // Connection managed by MongoConnection singleton
  }
}
