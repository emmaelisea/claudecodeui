import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { createClaudeSessionPermissionsService } from '@/modules/providers/services/claude-session-permissions.service.js';

test('permission changes require SDK acknowledgment and persist without touching Desktop', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-permissions-'));
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousDesktopDirectory = process.env.CLAUDE_DESKTOP_SESSIONS_DIR;
  process.env.CLAUDE_DESKTOP_SESSIONS_DIR = path.join(root, 'desktop');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  try {
    await initializeDatabase();
    const directory = path.join(root, 'desktop');
    await mkdir(directory);
    const id = randomUUID();
    const nativeId = randomUUID();
    sessionsDb.createAppSession(id, 'claude', root);
    sessionsDb.assignProviderSessionId(id, nativeId);
    const file = path.join(directory, `local_${nativeId}.json`);
    const original = { sessionId: `local_${nativeId}`, cliSessionId: nativeId, permissionMode: 'auto', model: 'keep-model', effort: 'xhigh', unknownField: { keep: true } };
    await writeFile(file, JSON.stringify(original));
    let live: string | undefined = 'auto';
    let rejectControl = false;
    const calls: string[] = [];
    const service = createClaudeSessionPermissionsService({
      readLive: () => live,
      setLive: async (_id, mode) => { calls.push(mode); if (rejectControl) throw new Error('CLI rejected change'); if (!live) return false; live = mode; return true; },
    });
    assert.equal((await service.read(id)).permissionMode, 'auto');
    assert.deepEqual(await service.change(id, 'bypassPermissions', true), { permissionMode: 'bypassPermissions', runtimeApplied: true });
    assert.equal(live, 'bypassPermissions');
    assert.equal(sessionsDb.getSessionById(id)?.permission_mode, 'bypassPermissions');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), original, 'permission changes leave Desktop metadata unchanged');

    rejectControl = true;
    await assert.rejects(service.change(id, 'default', true), /CLI rejected/);
    assert.equal((await service.read(id)).permissionMode, 'bypassPermissions');
    assert.equal(sessionsDb.getSessionById(id)?.permission_mode, 'bypassPermissions');
    rejectControl = false;

    const rollback = createClaudeSessionPermissionsService({
      readLive: () => live,
      setLive: async (_id, mode) => { live = mode; return true; },
      sessions: {
        getSessionById: sessionsDb.getSessionById,
        setSessionPermissionMode: () => { throw new Error('Database save failed'); },
      },
    });
    await assert.rejects(rollback.change(id, 'default', true), /Database save failed/);
    assert.equal(live, 'bypassPermissions', 'failed persistence restores the previous live permission');
    assert.equal(sessionsDb.getSessionById(id)?.permission_mode, 'bypassPermissions');

    await Promise.all([service.change(id, 'auto', true), service.change(id, 'default', true)]);
    assert.deepEqual(calls.slice(-2), ['auto', 'default']);
    assert.equal(live, 'default');
    assert.equal(sessionsDb.getSessionById(id)?.permission_mode, 'default');
    await assert.rejects(service.change(id, 'not-a-mode'), /Unsupported/);

    live = undefined;
    await assert.rejects(service.change(id, 'bypassPermissions', true), /no CloudCLI-controlled/);
    assert.equal(sessionsDb.getSessionById(id)?.permission_mode, 'default', 'an unavailable live process cannot silently save a different mode');
    assert.deepEqual(await service.change(id, 'auto'), { permissionMode: 'auto', runtimeApplied: false });
    assert.equal(sessionsDb.getSessionById(id)?.permission_mode, 'auto');
    // CloudCLI's next query uses its saved choice, independently of Desktop's display.
    await writeFile(file, JSON.stringify({ ...original, permissionMode: 'default' }));
    assert.equal(await service.resolveStoredMode(id, 'bypassPermissions'), 'auto');
    assert.deepEqual(await service.read(id), { permissionMode: 'auto', runtimeApplied: false });
    await service.recordAppliedMode(id, 'auto');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { ...original, permissionMode: 'default' });
    // The schema migration preserves the preference on a subsequent startup.
    closeConnection();
    await initializeDatabase();
    assert.equal(sessionsDb.getSessionById(id)?.permission_mode, 'auto');
  } finally {
    closeConnection();
    if (previousDesktopDirectory === undefined) delete process.env.CLAUDE_DESKTOP_SESSIONS_DIR;
    else process.env.CLAUDE_DESKTOP_SESSIONS_DIR = previousDesktopDirectory;
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
});
