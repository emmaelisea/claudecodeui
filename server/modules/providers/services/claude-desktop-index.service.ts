import { randomUUID } from 'node:crypto';
import { access, link, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
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
        permissionMode: 'default',
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
