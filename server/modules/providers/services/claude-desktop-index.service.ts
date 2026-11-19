import { randomUUID } from 'node:crypto';
import { access, link, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';

const SESSION_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/**
 * Used by the Claude transcript synchronizer to register CloudCLI-created
 * conversations in an explicitly selected Desktop account's session folder.
 * Existing Desktop records and deletion markers remain authoritative.
 */
export async function synchronizeClaudeDesktopIndex(
  sessions: ReturnType<typeof sessionsDb.getAllSessions> | undefined = undefined,
  directory = process.env.CLAUDE_DESKTOP_SESSIONS_DIR,
): Promise<number> {
  if (!directory) return 0;

  try {
    const files = await readdir(directory);
    const filenames = new Set(files);
    const desktopIds = new Map<string, string>();
    for (const filename of files) {
      if (!filename.startsWith('local_') || !filename.endsWith('.json')) continue;
      const record = JSON.parse(await readFile(path.join(directory, filename), 'utf8'));
      if (typeof record.cliSessionId === 'string' && typeof record.sessionId === 'string') {
        desktopIds.set(record.cliSessionId, record.sessionId);
      }
    }

    const candidates = (sessions ?? sessionsDb.getAllSessions()).filter((session) => session.provider === 'claude'
      && !session.isArchived && session.provider_session_id
      && SESSION_UUID.test(session.provider_session_id)
      && session.session_id !== session.provider_session_id
      && session.project_path && session.jsonl_path);
    let created = 0;
    for (const session of candidates) {
      const nativeId = session.provider_session_id!;
      const desktopId = `local_${nativeId}`;
      if (desktopIds.has(nativeId) || filenames.has(`${desktopId}.json`)
        || filenames.has(`deleted_${nativeId}`)) continue;
      try {
        await access(session.jsonl_path!);
      } catch {
        continue;
      }
      const parent = session.forked_from_session_id
        ? sessionsDb.getSessionById(session.forked_from_session_id)
        : null;
      const parentNativeId = parent?.provider_session_id;
      const parentDesktopId = parentNativeId
        ? desktopIds.get(parentNativeId)
        : undefined;
      const record = {
        sessionId: desktopId,
        cliSessionId: nativeId,
        cwd: session.project_path,
        originCwd: session.project_path,
        createdAt: Date.parse(session.created_at),
        lastActivityAt: Date.parse(session.updated_at),
        indexedAt: Date.now(),
        isArchived: false,
        title: session.custom_name || 'CloudCLI session',
        ...(session.model && { model: session.model }),
        ...(session.effort && { effort: session.effort }),
        ...(parentDesktopId && { forkedFromSessionId: parentDesktopId }),
        permissionMode: session.permission_mode || 'default',
        adoptedFromOtherSurface: true,
        fromCliTranscript: true,
      };
      const temporaryPath = path.join(directory, `.cloudcli-${randomUUID()}.tmp`);
      try {
        await writeFile(temporaryPath, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
        // Publish a complete record without replacing one Desktop created meanwhile.
        await link(temporaryPath, path.join(directory, `${desktopId}.json`));
        desktopIds.set(nativeId, desktopId);
        created += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }
    }
    return created;
  } catch (error) {
    console.warn('Claude Desktop session index synchronization failed:', error);
    return 0;
  }
}

/** Used by Claude session permissions to read the corresponding Desktop preference. */
export async function readClaudeDesktopPermissionMode(nativeId: string, directory = process.env.CLAUDE_DESKTOP_SESSIONS_DIR): Promise<string | null> {
  if (!directory) return null;
  let files: string[];
  try { files = await readdir(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  for (const name of files) {
    if (!name.startsWith('local_') || !name.endsWith('.json')) continue;
    const record = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
    if (record.cliSessionId === nativeId && typeof record.permissionMode === 'string') return record.permissionMode;
  }
  return null;
}

/** Used only after an explicit permission pick; preserves every other Desktop field. */
export async function writeClaudeDesktopPermissionMode(nativeId: string, mode: string, directory = process.env.CLAUDE_DESKTOP_SESSIONS_DIR): Promise<boolean> {
  if (!directory) return false;
  let files: string[];
  try { files = await readdir(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  for (const name of files) {
    if (!name.startsWith('local_') || !name.endsWith('.json')) continue;
    const file = path.join(directory, name);
    const before = await readFile(file, 'utf8');
    const record = JSON.parse(before);
    if (record.cliSessionId !== nativeId) continue;
    if (record.permissionMode === mode) return true;
    const temporary = path.join(directory, `.cloudcli-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify({ ...record, permissionMode: mode }), { flag: 'wx', mode: (await stat(file)).mode & 0o777 });
      // Do not replace a newer Desktop save with the snapshot read above.
      if (await readFile(file, 'utf8') !== before) throw new Error('Desktop session changed during permission update; retry.');
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return true;
  }
  return false;
}
