// SPDX-License-Identifier: Apache-2.0

import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { betterAuth } from 'better-auth';
import { apiKey } from '@better-auth/api-key';
import { organization } from 'better-auth/plugins';
import { DATA_DIR, ensureDir } from '../../shared/paths.js';

function getOrCreateAuthSecret(dataDir: string): string {
  if (process.env.BETTER_AUTH_SECRET) {
    return process.env.BETTER_AUTH_SECRET;
  }

  const secretPath = join(dataDir, '.auth-secret');

  if (existsSync(secretPath)) {
    try {
      chmodSync(secretPath, 0o600);
    } catch {
      // best-effort permission fix
    }
    return readFileSync(secretPath, 'utf8').trim();
  }

  const secret = randomBytes(32).toString('hex');
  ensureDir(dataDir);
  writeFileSync(secretPath, secret, { mode: 0o600 });
  return secret;
}

export function createAuth(database: Database) {
  ensureDir(DATA_DIR);
  return betterAuth({
    database,
    secret: getOrCreateAuthSecret(DATA_DIR),
    baseURL: process.env.BETTER_AUTH_URL ?? process.env.CLAUDE_MEM_SERVER_URL ?? 'http://127.0.0.1:37777',
    basePath: '/api/auth',
    plugins: [
      apiKey(),
      organization({
        teams: {
          enabled: true,
        },
      }),
    ],
  });
}
