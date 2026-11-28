import { sessionsDb } from '@/modules/database/index.js';
import { getClaudeSDKPermissionMode, setClaudeSDKPermissionMode } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';
import { AppError } from '@/shared/utils.js';

type Dependencies = {
  sessions: Pick<typeof sessionsDb, 'getSessionById' | 'setSessionPermissionMode'>;
  readLive: typeof getClaudeSDKPermissionMode;
  setLive: typeof setClaudeSDKPermissionMode;
};

/** Used by provider routes/runtime and tests to apply and retain the mode acknowledged by Claude's SDK. */
export function createClaudeSessionPermissionsService(overrides: Partial<Dependencies> = {}) {
  const dependencies: Dependencies = {
    sessions: sessionsDb,
    readLive: getClaudeSDKPermissionMode,
    setLive: setClaudeSDKPermissionMode,
    ...overrides,
  };
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
    return valid(session?.permission_mode) ? session.permission_mode : valid(requested) ? requested : undefined;
  };

  const recordAppliedMode = async (id: string, mode: string): Promise<void> => {
    if (!valid(mode)) throw new AppError('Unsupported permission mode.', { statusCode: 400, code: 'INVALID_PERMISSION_MODE' });
    requireSession(id);
    dependencies.sessions.setSessionPermissionMode(id, mode);
  };

  return {
    resolveStoredMode,
    readRuntimeMode: dependencies.readLive,
    recordAppliedMode,
    async read(id: string) {
      requireSession(id);
      const live = dependencies.readLive(id);
      return { permissionMode: live || await resolveStoredMode(id) || 'default', runtimeApplied: Boolean(live) };
    },
    change(id: string, mode: unknown, requireRuntime = false) {
      if (!valid(mode)) return Promise.reject(new AppError('Unsupported permission mode.', { statusCode: 400, code: 'INVALID_PERMISSION_MODE' }));
      // Serializes picks across tabs so a delayed acknowledgment cannot overwrite a newer choice.
      const operation = (pending.get(id) || Promise.resolve()).catch(() => undefined).then(async () => {
        requireSession(id);
        const previousLive = dependencies.readLive(id);
        let applied = false;
        try {
          applied = await dependencies.setLive(id, mode);
          if (requireRuntime && !applied) throw new AppError('This task has no CloudCLI-controlled Claude process. Change permissions in its owning Desktop window.', { statusCode: 409, code: 'LIVE_PERMISSION_MODE_UNAVAILABLE' });
          dependencies.sessions.setSessionPermissionMode(id, mode);
          return { permissionMode: mode, runtimeApplied: applied };
        } catch (error) {
          // If saving fails after the SDK acknowledged the change, restore the
          // previous live mode before reporting failure to the client.
          let rollbackFailed = false;
          if (applied && previousLive) {
            try { await dependencies.setLive(id, previousLive); }
            catch { rollbackFailed = true; }
          }
          if (rollbackFailed) throw new AppError('Saving the permission choice failed and rollback was incomplete. Reload session state before continuing.', { statusCode: 500, code: 'PERMISSION_ROLLBACK_FAILED' });
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
