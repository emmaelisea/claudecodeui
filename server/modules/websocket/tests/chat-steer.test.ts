import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionDraftsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { AnyRecord } from '@/shared/types.js';

const SESSION_ID = 'steer-session';
const MESSAGE_ID = '0b5c3f8e-6d1a-4c2b-9e7f-1a2b3c4d5e6f';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: Array<Record<string, unknown>>;
    send: (data: string) => void;
  };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

type SteerCall = { provider: string; sessionId: string; command: string; options: AnyRecord };

/**
 * A gateway whose runtime accepts or refuses every steer as `accepts` says.
 * `running` decides whether the session has a chat run in progress.
 */
async function withGateway(
  { accepts, running }: { accepts: boolean | Error; running: boolean },
  runTest: (context: { socket: ReturnType<typeof createFakeSocket>; steers: SteerCall[] }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-steer-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  userDb.createUser('steer-test', 'unused');

  const steers: SteerCall[] = [];
  const socket = createFakeSocket();

  try {
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory);
    if (running) {
      chatRunRegistry.startRun({
        appSessionId: SESSION_ID,
        provider: 'claude',
        providerSessionId: null,
        connection: null,
        userId: 1,
      });
    }

    handleChatConnection(
      socket as never,
      { user: { id: 1 } } as never,
      {
        runtime: {
          hasRuntime: () => true,
          steer: async (provider: string, sessionId: string, command: string, options: AnyRecord) => {
            steers.push({ provider, sessionId, command, options });
            if (accepts instanceof Error) throw accepts;
            return accepts;
          },
        } as never,
      },
    );

    await runTest({ socket, steers });
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** The handler is async and the socket listener does not await it. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

test('moving a queued card to steering claims it once even with duplicate clicks', async () => {
  await withGateway({ accepts: true, running: true }, async ({ socket, steers }) => {
    sessionDraftsDb.appendQueuedMessage(1, SESSION_ID, { content: 'change course', attachments: [] });
    const frame = { type: 'chat.steer', sessionId: SESSION_ID, messageId: MESSAGE_ID, content: 'change course', fromQueue: true, options: { attachments: [] } };
    socket.emit('message', JSON.stringify(frame));
    socket.emit('message', JSON.stringify(frame));
    await settle();
    assert.equal(steers.length, 1);
    assert.equal(steers[0].options.priority, 'now');
    assert.equal(sessionDraftsDb.listQueuedMessages(SESSION_ID).length, 0);
    assert.ok(socket.frames.some((frame) => frame.kind === 'chat_steer_accepted'));
  });
});

test('refused steering restores the queued card and never starts a replacement turn', async () => {
  await withGateway({ accepts: false, running: true }, async ({ socket, steers }) => {
    sessionDraftsDb.appendQueuedMessage(1, SESSION_ID, { content: 'keep this', attachments: [] });
    socket.emit('message', JSON.stringify({ type: 'chat.steer', sessionId: SESSION_ID, messageId: MESSAGE_ID, content: 'keep this', fromQueue: true }));
    await settle();
    assert.equal(steers.length, 1);
    assert.equal(sessionDraftsDb.listQueuedMessages(SESSION_ID).length, 1);
    assert.equal(socket.frames.at(-1)?.code, 'STEER_UNAVAILABLE');
  });
});

test('an old card cannot consume messages appended from another tab', async () => {
  await withGateway({ accepts: true, running: true }, async ({ socket, steers }) => {
    sessionDraftsDb.appendQueuedMessage(1, SESSION_ID, { content: 'old', attachments: [] });
    sessionDraftsDb.appendQueuedMessage(1, SESSION_ID, { content: 'new', attachments: [] });
    socket.emit('message', JSON.stringify({ type: 'chat.steer', sessionId: SESSION_ID, messageId: MESSAGE_ID, content: 'old', fromQueue: true }));
    await settle();
    assert.equal(steers.length, 0);
    assert.equal(sessionDraftsDb.listQueuedMessages(SESSION_ID).length, 1);
  });
});

test('a runtime failure restores the queued message and identifies the refused steer', async () => {
  await withGateway({ accepts: new Error('input closed'), running: true }, async ({ socket }) => {
    sessionDraftsDb.appendQueuedMessage(1, SESSION_ID, { content: 'keep this', attachments: [] });
    socket.emit('message', JSON.stringify({ type: 'chat.steer', sessionId: SESSION_ID, messageId: MESSAGE_ID, content: 'keep this', fromQueue: true }));
    await settle();
    assert.equal(sessionDraftsDb.listQueuedMessages(SESSION_ID).length, 1);
    assert.equal(socket.frames.at(-1)?.code, 'STEER_UNAVAILABLE');
    assert.equal(socket.frames.at(-1)?.messageId, MESSAGE_ID);
  });
});

test('chat.steer hands the message to the session\'s provider runtime', async () => {
  await withGateway({ accepts: true, running: true }, async ({ socket, steers }) => {
    socket.emit('message', JSON.stringify({
      type: 'chat.steer',
      sessionId: SESSION_ID,
      messageId: MESSAGE_ID,
      content: 'change course',
    }));
    await settle();

    assert.equal(steers.length, 1);
    // The provider comes from the session row, never from the frame.
    assert.equal(steers[0].provider, 'claude');
    assert.equal(steers[0].sessionId, SESSION_ID);
    assert.equal(steers[0].command, 'change course');
    assert.equal(steers[0].options.messageId, MESSAGE_ID);
    assert.deepEqual(steers[0].options.images, []);
    assert.deepEqual(steers[0].options.files, []);
    // The sender learns it was taken; the echo comes later on the run stream.
    assert.equal(socket.frames.length, 1);
    assert.equal(socket.frames[0].kind, 'chat_steer_accepted');
    assert.equal(socket.frames[0].messageId, MESSAGE_ID);
    assert.equal(socket.frames[0].sessionId, SESSION_ID);
  });
});

test('a steer with no running turn is refused with STEER_UNAVAILABLE, naming the message', async () => {
  await withGateway({ accepts: true, running: false }, async ({ socket, steers }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.steer', sessionId: SESSION_ID, messageId: MESSAGE_ID, content: 'hi' }));
    await settle();

    assert.equal(steers.length, 0, 'never reaches the runtime');
    assert.equal(socket.frames.at(-1)?.code, 'STEER_UNAVAILABLE');
    assert.equal(socket.frames.at(-1)?.messageId, MESSAGE_ID);
    assert.equal(socket.frames.at(-1)?.sessionId, SESSION_ID);
  });
});

test('a steer the runtime refuses (the turn just ended) is reported the same way', async () => {
  await withGateway({ accepts: false, running: true }, async ({ socket, steers }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.steer', sessionId: SESSION_ID, messageId: MESSAGE_ID, content: 'hi' }));
    await settle();

    assert.equal(steers.length, 1);
    assert.equal(socket.frames.at(-1)?.code, 'STEER_UNAVAILABLE');
    assert.equal(socket.frames.at(-1)?.messageId, MESSAGE_ID);
  });
});

test('a message id that is not a UUID is replaced, since it becomes the transcript uuid', async () => {
  await withGateway({ accepts: true, running: true }, async ({ steers, socket }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.steer', sessionId: SESSION_ID, messageId: '../etc', content: 'hi' }));
    await settle();

    assert.equal(steers.length, 1);
    assert.match(String(steers[0].options.messageId), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

test('an empty steer is refused before it reaches the runtime', async () => {
  await withGateway({ accepts: true, running: true }, async ({ socket, steers }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.steer', sessionId: SESSION_ID, messageId: MESSAGE_ID, content: '   ' }));
    await settle();

    assert.equal(steers.length, 0);
    assert.equal(socket.frames.at(-1)?.code, 'MESSAGE_REQUIRED');
  });
});
