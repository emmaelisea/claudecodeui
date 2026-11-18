import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { synchronizeClaudeDesktopIndex } from '@/modules/providers/services/claude-desktop-index.service.js';

test('Desktop indexing registers missing CloudCLI sessions without replacing Desktop state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-desktop-index-'));
  const previousDatabasePath = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  try {
    await initializeDatabase();
    const directory = path.join(root, 'desktop');
    await mkdir(directory);
    const now = new Date().toISOString();
    const seed = async (name: string, nativeId = randomUUID()) => {
      const id = randomUUID();
      const file = path.join(root, `${nativeId}.jsonl`);
      await writeFile(file, '{}\n');
      sessionsDb.createAppSession(id, 'claude', root, name);
      sessionsDb.assignProviderSessionId(id, nativeId);
      sessionsDb.createSession(nativeId, 'claude', root, name, now, now, file);
      return { id, nativeId, file };
    };
    const existing = await seed('Existing');
    const existingRecord = { sessionId: 'local_existing', cliSessionId: existing.nativeId, isArchived: true };
    const existingPath = path.join(directory, 'local_existing.json');
    await writeFile(existingPath, JSON.stringify(existingRecord));
    const deleted = await seed('Deleted');
    await writeFile(path.join(directory, `deleted_${deleted.nativeId}`), '1795000000000');
    const fresh = await seed('New CloudCLI conversation');
    const forkNativeId = randomUUID();
    const forkPath = path.join(root, `${forkNativeId}.jsonl`);
    await writeFile(forkPath, '{}\n');
    sessionsDb.createForkedSession({
      sessionId: randomUUID(),
      provider: 'claude',
      projectPath: root,
      customName: 'Fork',
      providerSessionId: forkNativeId,
      jsonlPath: forkPath,
      forkedFromSessionId: existing.id,
      model: null,
      effort: null,
    });
    const unrelatedId = randomUUID();
    sessionsDb.createSession(unrelatedId, 'claude', root, 'CLI session', now, now, fresh.file);

    const counts = await Promise.all([
      synchronizeClaudeDesktopIndex(undefined, directory),
      synchronizeClaudeDesktopIndex(undefined, directory),
    ]);
    assert.equal(counts.reduce((sum, count) => sum + count, 0), 2);
    const record = JSON.parse(await readFile(path.join(directory, `local_${fresh.nativeId}.json`), 'utf8'));
    assert.equal(record.cliSessionId, fresh.nativeId);
    assert.equal(record.sessionId, `local_${fresh.nativeId}`);
    assert.equal(record.title, 'New CloudCLI conversation');
    assert.equal(record.cwd, root);
    assert.equal(record.isArchived, false);
    assert.equal(record.permissionMode, 'default');
    assert.ok(Number.isFinite(record.createdAt));
    const fork = JSON.parse(await readFile(path.join(directory, `local_${forkNativeId}.json`), 'utf8'));
    assert.equal(fork.forkedFromSessionId, 'local_existing');
    assert.deepEqual(JSON.parse(await readFile(existingPath, 'utf8')), existingRecord);
    assert.equal(await synchronizeClaudeDesktopIndex(undefined, directory), 0);
    assert.equal((await readdir(directory)).length, 4);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
});
