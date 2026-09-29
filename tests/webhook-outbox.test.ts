import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { world } from './support/world.ts';
import { ledgerWebhook, appendLedger } from '../src/db/index.ts';
import { publicWebhookAddress, resolveWebhookAddress } from '../src/db/webhook-transport.ts';

test('webhook transport rejects private, mapped, transition and special-purpose IPs', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '198.18.0.1', '::1', '::ffff:127.0.0.1',
    'fc00::1', 'fe80::1', '2002:7f00:1::', '2001:db8::1', '2001::1', '3fff::1']) {
    assert.equal(publicWebhookAddress(address), false, address);
    await assert.rejects(resolveWebhookAddress(address));
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(publicWebhookAddress(address), true);
    assert.equal((await resolveWebhookAddress(address)).address, address);
  }
});

test('outbox commits with ledger, rolls back with ledger, and retains failures across dispatcher restart', async () => {
  const w = world();
  const dir = mkdtempSync(join(tmpdir(), 'manak-outbox-'));
  try {
    let fail = false;
    const options = { db: w.db, eventId: w.event.id, url: 'https://receiver.example/hook', secret: 'x'.repeat(32),
      checkpoint: join(dir, 'cursor.json'), send: (async () => new Response(null, { status: fail ? 503 : 204 })) as typeof fetch };
    const hook = ledgerWebhook(options);
    while (await hook.flush()) { /* drain historical notifications */ }
    const count = () => w.db.one<{ n: number }>('select count(*) n from webhook_delivery').n;
    const before = count();
    assert.throws(() => w.db.tx(() => {
      appendLedger(w.db, w.clock.now(), { eventId: w.event.id, action: 'test.rollback' });
      assert.equal(count(), before + 1);
      throw new Error('rollback');
    }));
    assert.equal(count(), before);
    w.db.tx(() => appendLedger(w.db, w.clock.now(), { eventId: w.event.id, action: 'test.commit', payload: { private: 'never sent' } }));
    assert.equal(count(), before + 1);
    fail = true;
    await assert.rejects(hook.flush());
    assert.equal(w.db.one<{ attempts: number }>("select attempts from webhook_delivery where status = 'queued'").attempts, 1);
    fail = false;
    const restored = ledgerWebhook(options);
    assert.equal(await restored.flush(), 1);
    assert.equal(w.db.one<{ n: number }>("select count(*) n from webhook_delivery where status = 'queued'").n, 0);
  } finally { w.db.close(); rmSync(dir, { recursive: true, force: true }); }
});
