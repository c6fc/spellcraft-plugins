'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { newJsonnet } = require('./helpers/jsonnet');

const ROOT = '@c6fc/spellcraft-plugins/module.libsonnet';

// The tree is pure Jsonnet until a native is called, so it can be evaluated
// with no natives registered at all -- provided nothing forces a field that
// calls one. std.objectFieldsAll() forces field *names* only.
const evaluate = (snippet) =>
    newJsonnet()
        .evaluateSnippet(snippet)
        .then(JSON.parse);

test('the root resolves through jpath and carries every top-level node', async () => {
    const fields = await evaluate(`std.objectFields(import "${ROOT}")`);
    assert.deepStrictEqual(fields, ['aws', 'gcp', 'terraform', 'utils']);
});

test('a namespace node and a node with its own API behave identically', async () => {
    const shape = await evaluate(`
        local p = import "${ROOT}";
        {
            // aws/ has no API of its own -- only children.
            aws: std.objectFields(p.aws),
            // aws/terraform/ has both, in one object.
            awsTerraform: std.objectFieldsAll(p.aws.terraform),
        }`);

    assert.deepStrictEqual(shape.aws, ['auth', 'terraform']);

    for (const own of ['bootstrap', 'getArtifact', 'providerAliases']) {
        assert.ok(shape.awsTerraform.includes(own), `aws.terraform kept its own ${own}`);
    }
    for (const child of ['s3', 'lambda']) {
        assert.ok(shape.awsTerraform.includes(child), `aws.terraform exposes its child ${child}`);
    }
});

test('reaching a node through the root and importing it directly give the same object', async () => {
    // The whole point of putting a node's own API and its children in one file:
    // there is no partial view depending on which way you got there.
    const same = await evaluate(`
        local viaRoot = (import "${ROOT}").aws.terraform;
        local direct = import "@c6fc/spellcraft-plugins/aws/terraform/module.libsonnet";
        std.objectFieldsAll(viaRoot) == std.objectFieldsAll(direct)`);

    assert.strictEqual(same, true);
});

test('every leaf exposes the API its old package did', async () => {
    const fields = await evaluate(`
        local p = import "${ROOT}";
        {
            awsAuth: std.objectFieldsAll(p.aws.auth),
            s3: std.objectFieldsAll(p.aws.terraform.s3),
            lambda: std.objectFieldsAll(p.aws.terraform.lambda),
            gcpAuth: std.objectFieldsAll(p.gcp.auth),
            gcpTerraform: std.objectFieldsAll(p.gcp.terraform),
        }`);

    assert.ok(fields.awsAuth.includes('getCallerIdentity'));
    assert.deepStrictEqual(fields.s3, ['bucket']);
    assert.deepStrictEqual(fields.lambda, ['config', 'nodejs_function']);
    assert.ok(fields.gcpAuth.includes('getProjectMetadata'));
    assert.ok(fields.gcpTerraform.includes('googleOrgProject'));
});

test('the terraform node is a manifestable object', async () => {
    // It used to be a bare native call returning the @c6fc/terraform Node
    // module, which could not be manifested and could not be a node here.
    const value = await evaluate(`(import "${ROOT}").terraform`);
    assert.deepStrictEqual(value, {});
});

test('importing the root authenticates to nothing', async () => {
    // Jsonnet imports are thunks, so naming every node in the root costs nothing
    // until a field is forced. If this were eager, an AWS-only spell would make
    // GCP calls just by importing the package.
    let called = 0;

    let jsonnet = newJsonnet();
    for (const name of ['aws.auth.getCallerIdentity', 'gcp.auth.getProjectId', 'gcp.auth.getProjectMetadata']) {
        jsonnet = jsonnet.nativeCallback(`@c6fc/spellcraft-plugins:${name}`, () => {
            called++;
            return {};
        });
    }

    await jsonnet.evaluateSnippet(`std.objectFields(import "${ROOT}")`);
    assert.strictEqual(called, 0, 'a native ran while merely importing the tree');
});
