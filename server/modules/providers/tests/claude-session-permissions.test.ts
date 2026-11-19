import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { readClaudeDesktopPermissionMode, writeClaudeDesktopPermissionMode } from '@/modules/providers/services/claude-desktop-index.service.js';
import { createClaudeSessionPermissionsService } from '@/modules/providers/services/claude-session-permissions.service.js';

test('live permission changes, Desktop persistence, failures and serialized picks agree', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-permissions-'));
  const previousDatabasePath = process.env.DATABASE_PATH;
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
      readDesktop: (native) => readClaudeDesktopPermissionMode(native, directory),
      writeDesktop: (native, mode) => writeClaudeDesktopPermissionMode(native, mode, directory),
    });
    assert.equal((await service.read(id)).permissionMode, 'auto');
    assert.deepEqual(await service.change(id, 'bypassPermissions', true), { permissionMode: 'bypassPermissions', runtimeApplied: true, desktopSynced: true });
    assert.equal(live, 'bypassPermissions');
    assert.equal(sessionsDb.getSessionById(id)?.permission_mode, 'bypassPermissions');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { ...original, permissionMode: 'bypassPermissions' });

    rejectControl = true;
    await assert.rejects(service.change(id, 'default', true), /CLI rejected/);
    assert.equal((await service.read(id)).permissionMode, 'bypassPermissions');
    assert.equal(await readClaudeDesktopPermissionMode(nativeId, directory), 'bypassPermissions');
    assert.equal(sessionsDb.getSessionById(id)?.permission_mode, 'bypassPermissions');
    rejectControl = false;

    const rollback = createClaudeSessionPermissionsService({
      readLive: () => live,
      setLive: async (_id, mode) => { live = mode; return true; },
      readDesktop: async () => 'bypassPermissions',
      writeDesktop: async () => { throw new Error('Desktop save failed'); },
    });
    await assert.rejects(rollback.change(id, 'default', true), /Desktop save failed/);
    assert.equal(live, 'bypassPermissions', 'failed Desktop sync restores the previous live permission');
    assert.equal(sessionsDb.getSessionById(id)?.permission_mode, 'bypassPermissions');

    await Promise.all([service.change(id, 'auto', true), service.change(id, 'default', true)]);
    assert.deepEqual(calls.slice(-2), ['auto', 'default']);
    assert.equal(live, 'default');
    assert.equal(await readClaudeDesktopPermissionMode(nativeId, directory), 'default');
    assert.equal(sessionsDb.getSessionById(id)?.permission_mode, 'default');
    await assert.rejects(service.change(id, 'not-a-mode'), /Unsupported/);

    live = undefined;
    await assert.rejects(service.change(id, 'bypassPermissions', true), /no CloudCLI-controlled/);
    assert.equal(await readClaudeDesktopPermissionMode(nativeId, directory), 'default');
    await service.change(id, 'auto');
    assert.equal(sessionsDb.getSessionById(id)?.permission_mode, 'auto');
    // A later Desktop manual selection must win over the old browser/session default.
    await writeClaudeDesktopPermissionMode(nativeId, 'default', directory);
    assert.equal(await service.resolveStoredMode(id, 'bypassPermissions'), 'default');
    assert.equal((await service.read(id)).permissionMode, 'default');
    // The schema migration preserves the preference on a subsequent startup.
    closeConnection();
    await initializeDatabase();
    assert.equal(sessionsDb.getSessionById(id)?.permission_mode, 'auto');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
});
