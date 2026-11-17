import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { assetsRoutes } from '@/modules/assets/index.js';

test('attachment uploads preserve UTF-8 names and download the original contents', async (t) => {
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-assets-'));
  t.mock.method(os, 'homedir', () => temporaryHome);

  const app = express();
  app.use(assetsRoutes);
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await rm(temporaryHome, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;

  const names = ['PBL 教师试用方案.html', 'Résumé 教师试用 📝.pdf', 'Ã©.txt'];
  const form = new FormData();
  for (const name of names) form.append('files', new Blob(['attachment data']), name);
  const response = await fetch(`${url}/files`, { method: 'POST', body: form });
  assert.equal(response.status, 200);
  const { attachments } = await response.json() as { attachments: { name: string; path: string }[] };
  assert.deepEqual(attachments.map((file) => file.name), names);

  const storedName = path.basename(attachments[0].path);
  assert.match(storedName, /^u8-[a-zA-Z0-9_.-]+\.html$/);
  const download = await fetch(`${url}/files/${encodeURIComponent(storedName)}`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition') ?? '', /^attachment;/);
  assert.equal(await download.text(), 'attachment data');
});
