import test from 'node:test';
import assert from 'node:assert/strict';
import { init, send } from '../src/server.js';

test('API responses and errors enter server.send instead of raw socket delivery', async t => {
    const sent = [];
    await init({ organization_id: 'platform', crud: {},
        send: data => { sent.push(data); return data; },
        wsManager: { send() { assert.fail('API must use server.send'); } } });
    t.mock.method(globalThis, 'fetch', async () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }));
    const data = { method: 'get', url: 'https://example.test', organization_id: 'tenant',
        socketId: 'trusted-socket', clientId: 'trusted-client', host: 'tenant.test',
        socket: { organization_id: 'forged-org', host: 'forged.test' } };
    assert.equal(await send(data), data);
    assert.deepEqual(data.data, { ok: true });
    assert.notEqual(sent[0], data);
    assert.equal(sent[0].socket, undefined);
    assert.equal(sent[0].socketId, 'trusted-socket');
    assert.equal(sent[0].clientId, 'trusted-client');
    const missing = { organization_id: 'tenant', host: 'tenant.test' };
    assert.equal(await send(missing), missing);
    assert.match(missing.error[0], /endpoint.*url/);
    assert.equal(sent[1].socket, undefined);
    assert.equal(sent[1].organization_id, 'tenant');
});

test('API AST socket operators retain tenant scope while entering server.send', async () => {
    const sent = [];
    await init({ organization_id: 'platform',
        crud: { send: async request => ({ object: request.array === 'apis'
            ? [{ _id: 'provider', url: 'https://example.test' }]
            : [{ resolved: true, data: { '$socket.send': { method: 'notification', organization_id: 'forged', host: 'forged' } } }] }) },
        send: data => { sent.push({ ...data }); return data; },
        wsManager: { send() { assert.fail('AST must use server.send'); } } });
    const data = { method: 'post', api: 'provider', endpoint: 'notify', organization_id: 'tenant',
        socketId: 'trusted-socket', clientId: 'trusted-client', host: 'tenant.test',
        socket: { organization_id: 'forged-org', host: 'forged.test' } };
    await send(data);
    assert.equal(data.error, undefined);
    assert.equal(sent[0].method, 'notification');
    assert.equal(sent[0].organization_id, 'tenant');
    assert.equal(sent[0].host, 'tenant.test');
    assert.equal(sent[0].socket, undefined);
    assert.equal(sent[1].socket, undefined);
    assert.equal(sent[1].socketId, 'trusted-socket');
    assert.equal(sent.length, 2);
});
