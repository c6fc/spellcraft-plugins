'use strict';

const test = require('node:test');
const assert = require('node:assert');

const auth = require('../aws/auth');
const terraform = require('../aws/terraform');

// The guards below must fire before anything reaches AWS. Swapping the auth seam
// proves that: if a guard ran late, this sentinel would surface instead of the
// guard's own error, and if a call reached the SDK the test would need
// credentials.
const SENTINEL = new Error('reached the provider');

let reached = 0;
auth._internal.ensureAuth = async () => {
    reached++;
    throw SENTINEL;
};

const call = (name, ...args) => terraform[name][0](...args);

test('getArtifact before a project name is set is an ordering error, not a credential one', async () => {
    reached = 0;

    await assert.rejects(() => call('getArtifact', 'thing'), (e) => {
        assert.match(e.message, /before a project name was set/);
        assert.match(e.message, /config\.spellcraftProject/, 'the message names both ways to set it');
        return true;
    });

    assert.strictEqual(reached, 0, 'the guard fired after resolving credentials');
});

test('putArtifact has the same guard', async () => {
    reached = 0;
    await assert.rejects(() => call('putArtifact', 'thing', 'content'), /before a project name was set/);
    assert.strictEqual(reached, 0);
});

test('a conflicting project name is reported without contacting the provider', async () => {
    // Stand in for what config.spellcraftProject does during init().
    terraform._spellcraft_metadata.functionContext.awsterraform.projectName = 'seeded-project';
    reached = 0;

    await assert.rejects(() => call('bootstrap', 'a-different-project'), (e) => {
        assert.match(e.message, /conflicts with "seeded-project"/);
        assert.match(e.message, /getRemoteState/, 'the message points at the right alternative');
        return true;
    });

    assert.strictEqual(reached, 0, 'a configuration error should not need a round trip first');
});

test('a matching project name passes the guards and goes on to authenticate', async () => {
    reached = 0;

    // The same name twice is a no-op, not a conflict -- so this reaches the auth
    // seam, which is where the sentinel stops it. Without the swap it would
    // continue to a real getBucketLocation call.
    await assert.rejects(() => call('bootstrap', 'seeded-project'), (e) => e === SENTINEL);

    assert.strictEqual(reached, 1);
});

test('once a name is set, the artifact guard stops firing', async () => {
    reached = 0;
    await assert.rejects(() => call('getArtifact', 'thing'), (e) => e === SENTINEL);
    assert.strictEqual(reached, 1);
});

test('putArtifact accepts a structure, which the facade has to serialise', async () => {
    // Native arguments must be primitives, so passing `content` straight into
    // std.native() raised "native extensions can only take primitives" -- the
    // facade serialises it and the JS side parses it back. Without that, the
    // function was unusable for anything but a string, which is not what its
    // JSON.stringify/JSON.parse round trip was built for.
    const { newJsonnet } = require('./helpers/jsonnet');

    const seen = [];
    const jsonnet = newJsonnet()
        .nativeCallback('@c6fc/spellcraft-plugins:aws.terraform.putArtifact', (name, contentJson) => {
            seen.push([name, contentJson]);
            return true;
        }, 'name', 'content')
        .nativeCallback('@c6fc/spellcraft-plugins:gcp.terraform.putArtifact', (name, contentJson) => {
            seen.push([name, contentJson]);
            return true;
        }, 'name', 'content');

    const out = JSON.parse(await jsonnet.evaluateSnippet(`
        local p = import "@c6fc/spellcraft-plugins/module.libsonnet";
        {
            aws: p.aws.terraform.putArtifact("network", { subnetId: "subnet-abc123", tags: ["a", "b"] }),
            gcp: p.gcp.terraform.putArtifact("network", { subnetId: "subnet-abc123" }),
        }`));

    assert.deepStrictEqual(out, { aws: true, gcp: true });
    assert.strictEqual(seen.length, 2);

    for (const [name, contentJson] of seen) {
        assert.strictEqual(name, 'network');
        assert.strictEqual(typeof contentJson, 'string', 'the native received a primitive');
        assert.strictEqual(JSON.parse(contentJson).subnetId, 'subnet-abc123');
    }
});

test('a plain string artifact still round-trips, as it did before', async () => {
    // The old facade passed `content` through untouched, so a string worked and
    // an object did not. Serialising means a string arrives JSON-quoted and is
    // parsed back to the same string -- the fix must not have broken the case
    // that used to work. (The old test.jsonnet in spellcraft-aws-terraform
    // called putArtifact with exactly this.)
    const { newJsonnet } = require('./helpers/jsonnet');

    let received;
    const jsonnet = newJsonnet()
        .nativeCallback('@c6fc/spellcraft-plugins:aws.terraform.putArtifact', (name, contentJson) => {
            received = JSON.parse(contentJson);
            return true;
        }, 'name', 'content');

    await jsonnet.evaluateSnippet(`
        local p = import "@c6fc/spellcraft-plugins/module.libsonnet";
        { x: p.aws.terraform.putArtifact("putArtifactTest", "mytest2") }`);

    assert.strictEqual(received, 'mytest2');
});
