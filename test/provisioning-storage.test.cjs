const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { URL } = require('node:url');

const source = fs.readFileSync(require.resolve('../src/server.js'), 'utf8')
    .replace(/^import \{ URL \} from 'node:url';$/m, '')
    .replace(/import \{[\s\S]*?\} from '@cocreate\/utils';/, '')
    .replace(/export async function/g, 'async function')
    .replace(/export default \{[\s\S]*?\};/, '');
const dependencies = Promise.all([
    import('../../CoCreate-utils/src/modules/ast/index.js'),
    import('../../CoCreate-utils/src/modules/objectToSearchParams.js'),
    import('../../CoCreate-utils/src/modules/searchParamsToObject.js'),
    import('../../../CoCreate-app/src/apps/endpoints/config/data.js'),
    import('../../../CoCreate-app/src/apps/servers/configs/config/autoscaler.js')
]);

async function setup({ index = 0, storage, storageError } = {}) {
    const [{ astAsync }, { objectToSearchParams }, { searchParamsToObject }, endpoints, startup] = await dependencies;
    const definitions = endpoints.default.object.filter(record => record.name === 'create-instance');
    const endpoint = definitions[index];
    let currentStorage = storage;
    let returnedStorage;
    const lookups = [];
    const requests = [];
    const context = vm.createContext({
        Buffer, URL, AbortController, setTimeout, clearTimeout,
        console: { log() {}, warn() {}, error() {} },
        objectToSearchParams, searchParamsToObject, astAsync, security: {},
        fetch: async (url, options) => {
            const body = options.body?.startsWith('{')
                ? JSON.parse(options.body)
                : Object.fromEntries(new URLSearchParams(options.body || ''));
            requests.push({ url, body });
            let result;
            if (body.Action === 'DescribeVpcs') result = '<vpcId>vpc-example</vpcId>';
            else if (body.Action === 'DescribeSecurityGroups') result = '<groupId>sg-example</groupId>';
            else if (body.Action === 'RunInstances') result = '<instanceId>i-example</instanceId><imageId>ami-example</imageId><instanceType>small</instanceType><instanceState><name>pending</name></instanceState><availabilityZone>example</availabilityZone><privateIpAddress>127.0.0.1</privateIpAddress>';
            else result = JSON.stringify({ id: 'existing-resource' });
            return new Response(result, { status: 200 });
        }
    });
    vm.runInContext(source, context);
    await context.init({
        organization_id: 'platform',
        crud: { send: async query => {
            lookups.push(query);
            if (query.array === 'endpoints') {
                if (query.filter.query.name === 'create-instance') return { object: [endpoint] };
                if (query.filter.query.name === 'resolve-image') return { object: [{
                    resolved: true, method: 'post', endpoint: '/', data: { Parameter: { Value: 'ami-example' } }
                }] };
                return { object: [] };
            }
            assert.equal(query.array, 'apis');
            if (query.filter.query._id) {
                assert.equal(query.organization_id, 'platform');
                assert.equal(query.filter.query.type, 'storage');
                assert.equal(query.filter.query.enabled, true);
                assert.equal(query.filter.limit, 1);
                if (storageError) return { error: [storageError] };
                const found = currentStorage?._id === query.filter.query._id &&
                    currentStorage.enabled === true && currentStorage.organization_id === query.organization_id;
                // Model a projected CRUD record that retains its internal ID.
                // The endpoint must pass it through without further reshaping.
                returnedStorage = found ? Object.fromEntries(Object.entries(currentStorage)
                    .filter(([key]) => key === '_id' || query.filter.key?.[key] !== 0)) : undefined;
                return { object: found ? [returnedStorage] : [] };
            }
            return { object: [{ _id: endpoint.api_id, name: 'test-cloud', url: 'https://cloud.invalid' }] };
        } }
    });
    return {
        requests, lookups,
        get returnedStorage() { return returnedStorage; },
        setStorage(value) { currentStorage = value; },
        async run(data = {}) {
            const original = {
                storage: 'storage-id', region: 'example', type: 'small', id: 'server-example',
                cluster_id: 'cluster-id', host: 'example.com', binaryUrl: 'https://example.com/runtime.tar.gz',
                environment: 'server_id=server-id\ncluster_id=cluster-id',
                startupScript: startup.default.object[0].config.startupScript,
                ...data
            };
            const result = await context.send({
                api: 'test-cloud', endpoint: 'create-instance', method: endpoint.method,
                organization_id: 'platform', host: 'platform.example.com', region: 'example', data: original
            });
            assert.equal(original.storage, data.storage ?? 'storage-id');
            return result;
        }
    };
}

function readBootstrap(requests) {
    let script;
    for (const { body } of requests) {
        const encoded = body.UserData || body.properties?.osProfile?.customData || body.metadata?.user_data;
        if (encoded) script = Buffer.from(encoded, 'base64').toString('utf8');
        else if (body.user_data) {
            script = body.user_data.startsWith('#!') ? body.user_data : Buffer.from(body.user_data, 'base64').toString('utf8');
        } else if (body.userdata) script = body.userdata;
        else if (body.metadata?.items) script = body.metadata.items.find(item => item.key === 'startup-script')?.value;
    }
    assert.ok(script?.startsWith('#!/usr/bin/env bash'), 'Cloud request must contain the rendered startup script');
    const syntax = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    assert.ok(script.includes('https://example.com/runtime.tar.gz'));
    const match = script.match(/printf '%s' '([^']+)' \| base64 --decode > \/etc\/cocreatews\/storage.json/);
    assert.ok(match, 'Startup script must contain encoded bootstrap storage');
    return JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
}

const record = {
    _id: 'storage-id', organization_id: 'platform', name: 'primary', provider: 'mongodb',
    type: 'storage', enabled: true, connectionString: 'mongodb://example/platform'
};

for (let index = 0; index < 8; index++) {
    test(`create-instance endpoint ${index + 1} resolves the storage ID before rendering cloud user data`, async () => {
        const fixture = await setup({ index, storage: record });
        await fixture.run();
        assert.deepEqual(readBootstrap(fixture.requests), fixture.returnedStorage);
        assert.equal(fixture.returnedStorage.connectionString, record.connectionString);
        assert.equal(fixture.returnedStorage.organization_id, undefined);
        assert.equal(fixture.returnedStorage.enabled, undefined);
        assert.equal(fixture.lookups.filter(query => query.filter?.query?.type === 'storage').length, 1);
    });
}

test('subsequent provisioning reads rotated credentials while keeping the storage ID', async () => {
    const fixture = await setup({ storage: record });
    await fixture.run();
    assert.deepEqual(readBootstrap(fixture.requests), fixture.returnedStorage);
    fixture.requests.length = 0;
    const rotated = { ...record, connectionString: 'mongodb://rotated/平台' };
    fixture.setStorage(rotated);
    await fixture.run();
    assert.deepEqual(readBootstrap(fixture.requests), fixture.returnedStorage);
    assert.equal(fixture.returnedStorage.connectionString, rotated.connectionString);
});

test('endpoint bootstrap keeps arbitrary provider credential fields unchanged', async () => {
    const storage = {
        ...record, provider: 'custom-provider', connectionString: undefined,
        apiKey: 'example-key', credentials: { uri: 'custom://example', options: { region: 'example' } }
    };
    delete storage.connectionString;
    const fixture = await setup({ storage });
    await fixture.run();
    assert.deepEqual(readBootstrap(fixture.requests), fixture.returnedStorage);
    assert.equal(fixture.returnedStorage.apiKey, storage.apiKey);
    assert.deepEqual(fixture.returnedStorage.credentials, storage.credentials);
});

for (const id of [undefined, '', '   ', { name: 'embedded-credentials' }]) {
    test(`invalid storage ID ${JSON.stringify(id)} stops before database lookup or cloud calls`, async () => {
        const fixture = await setup({ storage: record });
        await assert.rejects(fixture.run({ storage: id }), /requires a storage API record ID/);
        assert.equal(fixture.requests.length, 0);
        assert.equal(fixture.lookups.filter(query => query.filter?.query?.type === 'storage').length, 0);
    });
}

for (const unavailable of [null, { ...record, enabled: false }, { ...record, organization_id: 'another-org' }]) {
    test(`unavailable storage ${unavailable?.organization_id || 'missing'} stops before any cloud call`, async () => {
        const fixture = await setup({ storage: unavailable });
        await assert.rejects(fixture.run(), /storage API record is unavailable/);
        assert.equal(fixture.requests.length, 0);
    });
}

test('storage read errors and malformed records stop the endpoint pipeline', async () => {
    const readError = await setup({ storage: record, storageError: 'read failed' });
    await assert.rejects(readError.run(), /Unable to read/);
    assert.equal(readError.requests.length, 0);
    const invalid = await setup({ storage: { ...record, provider: '' } });
    await assert.rejects(invalid.run(), /requires a provider/);
    assert.equal(invalid.requests.length, 0);
});


test('storage lookup requests MongoDB-compatible provider template exclusions', async () => {
    const template = fs.readFileSync(new URL('../../../CoCreate-app/src/apps/apis/components/fields.html', 'file://' + __filename), 'utf8');
    const excluded = template.match(/render-exclude="([^"]+)"/)[1].split(',').map(key => key.trim())
        .filter(key => !['name', 'provider', '_id'].includes(key) && !key.startsWith('$'));
    const fixture = await setup({ storage: record });
    await fixture.run();
    const query = fixture.lookups.find(query => query.filter?.query?.type === 'storage');
    assert.deepEqual(Object.keys(query.filter.key).sort(), excluded.sort());
    assert.ok(Object.values(query.filter.key).every(value => value === 0));
    assert.equal(fixture.returnedStorage.name, record.name);
    assert.equal(fixture.returnedStorage.provider, record.provider);
    assert.equal(readBootstrap(fixture.requests)._id, record._id);
});
