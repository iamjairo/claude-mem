import { MongoClient, Db, Collection, IndexDescription } from 'mongodb';
import { logger } from '../../utils/logger.js';

export const MONGO_DB_NAME = 'claude_mem';

const COLLECTIONS = {
  SESSIONS: 'sdk_sessions',
  OBSERVATIONS: 'observations',
  SESSION_SUMMARIES: 'session_summaries',
  USER_PROMPTS: 'user_prompts',
  PENDING_MESSAGES: 'pending_messages',
  OBSERVATION_FEEDBACK: 'observation_feedback',
  COUNTERS: '_counters',
} as const;

export { COLLECTIONS };

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectMongo(uri: string): Promise<Db> {
  if (db) return db;

  client = new MongoClient(uri, {
    connectTimeoutMS: 10_000,
    serverSelectionTimeoutMS: 10_000,
  });

  await client.connect();
  db = client.db(MONGO_DB_NAME);

  await ensureIndexes(db);

  logger.info('DB', 'MongoDB connected', { uri: uri.replace(/\/\/[^@]+@/, '//***@') });
  return db;
}

export async function closeMongo(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
    logger.info('DB', 'MongoDB connection closed');
  }
}

export function getDb(): Db {
  if (!db) throw new Error('MongoDB not connected — call connectMongo() first');
  return db;
}

async function ensureIndexes(database: Db): Promise<void> {
  const sessions = database.collection(COLLECTIONS.SESSIONS);
  const observations = database.collection(COLLECTIONS.OBSERVATIONS);
  const summaries = database.collection(COLLECTIONS.SESSION_SUMMARIES);
  const prompts = database.collection(COLLECTIONS.USER_PROMPTS);
  const pending = database.collection(COLLECTIONS.PENDING_MESSAGES);
  const feedback = database.collection(COLLECTIONS.OBSERVATION_FEEDBACK);

  const indexOps: Array<{ col: Collection; indexes: IndexDescription[] }> = [
    {
      col: sessions,
      indexes: [
        { key: { content_session_id: 1 }, unique: true, name: 'ux_sessions_content_id' },
        { key: { memory_session_id: 1 }, sparse: true, name: 'idx_sessions_memory_id' },
        { key: { project: 1 }, name: 'idx_sessions_project' },
        { key: { status: 1 }, name: 'idx_sessions_status' },
        { key: { started_at_epoch: -1 }, name: 'idx_sessions_started' },
        { key: { platform_source: 1 }, name: 'idx_sessions_platform' },
      ],
    },
    {
      col: observations,
      indexes: [
        { key: { memory_session_id: 1 }, name: 'idx_obs_memory_id' },
        { key: { project: 1 }, name: 'idx_obs_project' },
        { key: { type: 1 }, name: 'idx_obs_type' },
        { key: { created_at_epoch: -1 }, name: 'idx_obs_created' },
        { key: { content_hash: 1, created_at_epoch: -1 }, name: 'idx_obs_hash' },
        { key: { agent_type: 1 }, name: 'idx_obs_agent_type' },
        { key: { agent_id: 1 }, name: 'idx_obs_agent_id' },
        { key: { memory_session_id: 1, content_hash: 1 }, unique: true, name: 'ux_obs_session_hash' },
        {
          key: { title: 'text', subtitle: 'text', narrative: 'text', facts: 'text', concepts: 'text' },
          name: 'text_obs',
          weights: { title: 10, subtitle: 5, narrative: 3, facts: 2, concepts: 1 },
        } as IndexDescription,
      ],
    },
    {
      col: summaries,
      indexes: [
        { key: { memory_session_id: 1 }, name: 'idx_sum_memory_id' },
        { key: { project: 1 }, name: 'idx_sum_project' },
        { key: { created_at_epoch: -1 }, name: 'idx_sum_created' },
        {
          key: { request: 'text', investigated: 'text', learned: 'text', completed: 'text', next_steps: 'text' },
          name: 'text_summaries',
        } as IndexDescription,
      ],
    },
    {
      col: prompts,
      indexes: [
        { key: { content_session_id: 1 }, name: 'idx_prompts_session' },
        { key: { created_at_epoch: -1 }, name: 'idx_prompts_created' },
        { key: { content_session_id: 1, prompt_number: 1 }, name: 'idx_prompts_lookup' },
      ],
    },
    {
      col: pending,
      indexes: [
        { key: { session_db_id: 1 }, name: 'idx_pending_session' },
        { key: { status: 1 }, name: 'idx_pending_status' },
        { key: { content_session_id: 1 }, name: 'idx_pending_claude_session' },
        {
          key: { content_session_id: 1, tool_use_id: 1 },
          unique: true,
          sparse: true,
          name: 'ux_pending_session_tool',
        },
      ],
    },
    {
      col: feedback,
      indexes: [
        { key: { observation_id: 1 }, name: 'idx_feedback_obs' },
        { key: { signal_type: 1 }, name: 'idx_feedback_signal' },
      ],
    },
  ];

  for (const { col, indexes } of indexOps) {
    try {
      await col.createIndexes(indexes);
    } catch (err) {
      logger.warn('DB', `Failed to create indexes on ${col.collectionName}`, {}, err instanceof Error ? err : new Error(String(err)));
    }
  }

  logger.debug('DB', 'MongoDB indexes ensured');
}

export async function nextId(database: Db, name: string): Promise<number> {
  const counters = database.collection<{ _id: string; seq: number }>(COLLECTIONS.COUNTERS);
  const result = await counters.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return result!.seq;
}
