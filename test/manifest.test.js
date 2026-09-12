'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { newJsonnet } = require('./helpers/jsonnet');

const plugins = require('..');


// Canned answers for the natives that would otherwise call a provider. Every
// other native -- normalizeResourceName, shortHash, enableServices -- is
// registered from the package's own implementation, so these fixtures exercise
// the real code, not a mock of it.
const STUBS = {
    'aws.auth.getCallerIdentity': () => ({
        Account: '111111111111',
        Arn: 'arn:aws:iam::111111111111:user/test',
        UserId: 'AIDATEST',
    }),
    'aws.auth.aws': (clientJson, method) => {
        assert.strictEqual(method, 'describeRegions', `unexpected AWS call: ${method}`);
        return { Regions: [{ RegionName: 'us-east-1' }, { RegionName: 'us-west-2' }] };
    },
    'gcp.auth.getProjectMetadata': () => ({
        projectId: 'test-project',
        organizationId: '123456789',
        organizationDomain: 'example.com',
        directoryId: 'C01test',
        billingAccount: '0X0X0X-0X0X0X-0X0X0X',
        quotaProject: 'test-project',
    }),
    'gcp.auth.getProjectId': () => 'test-project',
    'gcp.auth.api': () => ({ items: [{ name: 'us-central1' }, { name: 'us-west2' }] }),
};

// Registers every native the package publishes, the way SpellFrame does,
// substituting a stub where one exists.
//
// The memo cache is part of "the way SpellFrame does": core caches a native's
// result by (name, arguments) for the life of the frame, and googleOrgProject
// leans on that hard. The GCP fixture below makes ~1400 native calls without it
// -- 26 seconds of shortHash and normalizeResourceName on the same inputs --
// and a handful with it. A harness that skips the cache is not just slower, it
// misrepresents what a render costs.
function harness() {
    let jsonnet = newJsonnet();

    const cache = new Map();

    for (const key of Object.keys(plugins).filter((k) => !k.startsWith('_'))) {
        const value = plugins[key];
        const [fn, ...params] = Array.isArray(value) ? value : [value];
        const impl = STUBS[key] || fn;

        jsonnet = jsonnet.nativeCallback(
            `@c6fc/spellcraft-plugins:${key}`,
            (...args) => {
                const id = JSON.stringify([key, ...args]);
                if (!cache.has(id)) cache.set(id, impl(...args));
                return cache.get(id);
            },
            ...params,
        );
    }

    return jsonnet;
}

const render = async (fixture) =>
    JSON.parse(await harness().evaluateFile(path.join(__dirname, 'fixtures', fixture)));

test('the AWS fixture manifests every leaf under aws/', async () => {
    const out = await render('aws.jsonnet');

    assert.deepStrictEqual(Object.keys(out).sort(), [
        'lambda-custom-iam.tf.json',
        'lambda-defaults.tf.json',
        'providers.tf.json',
        'regions.txt',
        's3_default.tf.json',
        's3_log-storage.tf.json',
        's3_static-site.tf.json',
    ]);

    // providerAliases builds one aliased provider per region plus a default.
    assert.strictEqual(out['providers.tf.json'].provider.length, 3);
    assert.strictEqual(out['regions.txt'], 'us-east-1,us-west-2');

    // s3.bucket composes the resources a configured bucket actually needs, and
    // the three types must not render identically.
    const types = ['s3_default', 's3_static-site', 's3_log-storage'].map((k) =>
        JSON.stringify(out[`${k}.tf.json`]),
    );
    assert.strictEqual(new Set(types).size, 3, 'two bucket types rendered identically');

    // lambda resolves source relative to the *caller's* file, so the fixture's
    // own directory -- not the plugin's -- is what shows up.
    const zip = out['lambda-defaults.tf.json'].data.archive_file.my_test_function;
    assert.ok(zip.source_dir.includes(path.join('test', 'fixtures', 'lambda_functions')), zip.source_dir);

    // The account id threaded through from the stubbed identity.
    assert.ok(
        JSON.stringify(out['lambda-custom-iam.tf.json']).includes('111111111111'),
        'the caller identity did not reach the lambda policy',
    );
});

test('the GCP fixture manifests an org tree through the real name derivation', async () => {
    const out = await render('gcp.jsonnet');
    const resources = {
        ...out['orgTree.tf.json'].resource,
        ...out['projectDetail.tf.json'].resource,
    };

    assert.ok(resources.google_folder, 'folders were built');
    assert.ok(resources.google_project, 'projects were built');
    assert.ok(resources.google_service_account, 'service accounts were built');

    // normalizeResourceName and shortHash ran for real -- these are the derived
    // Terraform names the refs:: convention exists to expose.
    for (const name of Object.keys(resources.google_project)) {
        assert.match(name, /^[a-z0-9_]+$/, `${name} is not a normalized resource name`);
    }
});

test('rendering the fixtures never reached a provider', () => {
    // Belt and braces after both renders above: if a native that should have
    // been stubbed had actually run, it would have loaded an SDK.
    const loaded = (name) =>
        Object.keys(require.cache).some(
            (k) => k.includes(path.join('node_modules', name, path.sep)) && k.endsWith('.js'),
        );

    assert.ok(!loaded('aws-sdk'));
    assert.ok(!loaded('googleapis'));
});
