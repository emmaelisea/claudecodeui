import { sessionsDb } from '@/modules/database/index.js';
import { getClaudeSDKPermissionMode, setClaudeSDKPermissionMode } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { readClaudeDesktopPermissionMode, writeClaudeDesktopPermissionMode } from '@/modules/providers/services/claude-desktop-index.service.js';
import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';
import { AppError } from '@/shared/utils.js';

type Dependencies = {
  sessions: Pick<typeof sessionsDb, 'getSessionById' | 'setSessionPermissionMode'>;
  readDesktop: typeof readClaudeDesktopPermissionMode;
  writeDesktop: typeof writeClaudeDesktopPermissionMode;
  readLive: typeof getClaudeSDKPermissionMode;
  setLive: typeof setClaudeSDKPermissionMode;
};

/** Used by provider routes/runtime and tests to keep one session's live and Desktop permissions in agreement. */
export function createClaudeSessionPermissionsService(overrides: Partial<Dependencies> = {}) {
  const dependencies: Dependencies = { sessions: sessionsDb, readDesktop: readClaudeDesktopPermissionMode,
    writeDesktop: writeClaudeDesktopPermissionMode, readLive: getClaudeSDKPermissionMode, setLive: setClaudeSDKPermissionMode, ...overrides };
  const modes = providerCapabilitiesService.getProviderCapabilities('claude').permissionModes;
  const valid = (mode: unknown): mode is string => typeof mode === 'string' && modes.includes(mode);
  const pending = new Map<string, Promise<unknown>>();
  const requireSession = (id: string) => {
    const session = dependencies.sessions.getSessionById(id);
    if (!session || session.provider !== 'claude') throw new AppError('Claude session not found.', { statusCode: 404, code: 'SESSION_NOT_FOUND' });
    return session;
  };

  const resolveStoredMode = async (id: string, requested?: string): Promise<string | undefined> => {
    const session = dependencies.sessions.getSessionById(id);
    if (session?.provider_session_id) {
      const desktop = await dependencies.readDesktop(session.provider_session_id);
      if (valid(desktop)) return desktop;
    }
    return valid(session?.permission_mode) ? session.permission_mode : valid(requested) ? requested : undefined;
  };

  const recordAppliedMode = async (id: string, mode: string, nativeId?: string): Promise<void> => {
    if (!valid(mode)) throw new AppError('Unsupported permission mode.', { statusCode: 400, code: 'INVALID_PERMISSION_MODE' });
    const session = requireSession(id);
    dependencies.sessions.setSessionPermissionMode(id, mode);
    const native = nativeId || session.provider_session_id;
    if (native) await dependencies.writeDesktop(native, mode);
  };

  return {
    resolveStoredMode,
    recordAppliedMode,
    async read(id: string) {
      requireSession(id);
      const live = dependencies.readLive(id);
      return { permissionMode: live || await resolveStoredMode(id) || 'default', runtimeApplied: Boolean(live) };
    },
    change(id: string, mode: unknown, requireRuntime = false) {
      if (!valid(mode)) return Promise.reject(new AppError('Unsupported permission mode.', { statusCode: 400, code: 'INVALID_PERMISSION_MODE' }));
      // Serializes rapid picks across tabs so an older filesystem write cannot win.
      const operation = (pending.get(id) || Promise.resolve()).catch(() => undefined).then(async () => {
        const session = requireSession(id);
        const previousLive = dependencies.readLive(id);
        const previousDesktop = session.provider_session_id ? await dependencies.readDesktop(session.provider_session_id) : null;
        let applied = false;
        let desktopSynced = false;
        try {
          applied = await dependencies.setLive(id, mode);
          if (requireRuntime && !applied) throw new AppError('This task has no CloudCLI-controlled Claude process. Change permissions in its owning Desktop window.', { statusCode: 409, code: 'LIVE_PERMISSION_MODE_UNAVAILABLE' });
          if (session.provider_session_id) desktopSynced = await dependencies.writeDesktop(session.provider_session_id, mode);
          dependencies.sessions.setSessionPermissionMode(id, mode);
          return { permissionMode: mode, runtimeApplied: applied, desktopSynced };
        } catch (error) {
          // A rejected control request must not leave the UI or Desktop claiming
          // it succeeded. A later save failure also restores the live choice.
          let rollbackFailed = false;
          if (desktopSynced && session.provider_session_id && previousDesktop) {
            try { await dependencies.writeDesktop(session.provider_session_id, previousDesktop); }
            catch { rollbackFailed = true; }
          }
          if (applied && previousLive) {
            try { await dependencies.setLive(id, previousLive); }
            catch { rollbackFailed = true; }
          }
          if (rollbackFailed) throw new AppError('Permission synchronization failed and rollback was incomplete. Reload session state before continuing.', { statusCode: 500, code: 'PERMISSION_ROLLBACK_FAILED' });
          throw error;
        }
      });
      pending.set(id, operation);
      const cleanup = () => { if (pending.get(id) === operation) pending.delete(id); };
      void operation.then(cleanup, cleanup);
      return operation;
    },
  };
}

/** Used by the Claude provider routes and runtime context. */
export const claudeSessionPermissionsService = createClaudeSessionPermissionsService();
