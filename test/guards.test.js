'use strict';

/*
	Shape and option guards that turn a silent wrong answer, or a message about
	the plugin's own internals, into a sentence naming what the caller did.

	Each case below was executed against the published packages first: every one
	either succeeded with wrong output or failed with a diagnostic pointing
	somewhere other than the mistake.
*/

const test = require('node:test');
const assert = require('node:assert');
const { newJsonnet } = require('./helpers/jsonnet');

const IMPORT = '(import "@c6fc/spellcraft-plugins/module.libsonnet")';

// s3.bucket() reads the account id through a native; nothing here inspects it.
const evaluate = (snippet) =>
    newJsonnet()
        .nativeCallback('@c6fc/spellcraft-plugins:aws.auth.getCallerIdentity', () => ({
            Account: '123456789012',
            Arn: 'arn:aws:iam::123456789012:user/you',
        }))
        .evaluateSnippet(snippet)
        .then(JSON.parse);

const tree = (snippet) => evaluate(`local tree = ${IMPORT}.utils.tree;\n${snippet}`);
const s3 = (snippet) => evaluate(`local s3 = ${IMPORT}.aws.terraform.s3;\n${snippet}`);

test('tree.walk names a missing required hook, even on a single node', async () => {
    // `spec.name` is read through a thunk, so a spec with no name hook -- or a
    // typo'd one -- rendered fine for a single node whose node(ctx) ignored
    // ctx.name, and failed only once a child was added.
    await assert.rejects(
        () => tree('tree.walk({ name: "a" }, { node(ctx):: { x: 1 } })'),
        /tree\.walk: spec requires both a name\(ctx\) and a node\(ctx\) hook/
    );

    await assert.rejects(
        () => tree('tree.walk({ name: "a" }, { nmae(ctx):: ctx.body.name, node(ctx):: { x: 1 } })'),
        /tree\.walk: spec requires both/
    );
});

test('tree.walk names children when they are a map rather than a list', async () => {
    // A map keyed by name is how Terraform's own for_each idiom reads. std.length
    // accepts an object, so this used to reach kids[i] and fail with
    // "object index must be string, got number".
    await assert.rejects(
        () => tree(`tree.walk({ name: "a", children: { b: { name: "b" } } }, {
            name(ctx):: ctx.body.name,
            node(ctx):: { [ctx.name]: 1 },
        })`),
        /tree\.walk: the 'children' field of node 'a' must be an array, got object/
    );
});

test('tree.walk refuses a node(ctx) that does not return an object', async () => {
    // merge.deep returns its right-hand side when either side is not an object,
    // so the fold collapsed to the last node's string and the rendered file read
    // literally `"b{ }"`. Exit 0, no diagnostic anywhere.
    await assert.rejects(
        () => tree(`tree.walk({ name: "a", children: [{ name: "b" }] }, {
            name(ctx):: ctx.body.name,
            node(ctx):: ctx.name,
        })`),
        /tree\.walk: node\(ctx\) must return an object for 'a', got string/
    );
});

test('tree.walk refuses two nodes that derive the same name, naming both paths', async () => {
    // Five nodes in, four out: output is merged, not concatenated, so alice's
    // platform team silently became bob's.
    await assert.rejects(
        () => tree(`tree.walk({
            name: "acme",
            children: [
                { name: "eng", children: [{ name: "platform", owner: "alice" }] },
                { name: "sales", children: [{ name: "platform", owner: "bob" }] },
            ],
        }, {
            name(ctx):: ctx.body.name,
            node(ctx):: { [ctx.name]: { owner: std.get(ctx.body, "owner", null) } },
        })`),
        /'platform' derived by more than one node[\s\S]*acme\.eng\.platform and acme\.sales\.platform/
    );
});

test('tree.walk still walks a correct spec', async () => {
    const built = await tree(`tree.walk({ name: "eng", children: [{ name: "api" }] }, {
        name(ctx):: std.join("_", ctx.path),
        node(ctx):: { [ctx.name]: { depth: ctx.depth } },
    })`);

    assert.deepStrictEqual(built, { eng: { depth: 0 }, eng_api: { depth: 1 } });
});

test('s3.bucket refuses an explicit bucket name, pointing at the README', async () => {
    // The one silent exception to a pass-through contract the README states
    // twice: a caller asking for "my-explicit-name" got "t-<aws-suffix>" and
    // found out by reading the deployed bucket's name.
    await assert.rejects(
        () => s3('s3.bucket("t", "us-west-2", { bucket: "my-explicit-name" })'),
        /the bucket name is derived from `name` through bucket_prefix[\s\S]*Bucket names/
    );
});

test('s3.bucket refuses an unknown type, listing the ones it has', async () => {
    // `static_site` for `static-site` was ignored in silence: a fully locked-down
    // private bucket where a public website was asked for, exit 0.
    await assert.rejects(
        () => s3('s3.bucket("t", "us-west-2", { type: "static_site" })'),
        /unknown type "static_site"\. Valid types are 'log-storage', 'static-site'/
    );
});

test('s3.bucket still passes unlisted options through, and still applies its presets', async () => {
    const built = await s3(`s3.bucket("t", "us-west-2", {
        type: "static-site",
        force_destroy: true,
        tags: { Owner: "platform" },
        timeouts: { create: "5m" },
    })`);

    const bucket = built.resource.aws_s3_bucket.t;

    assert.strictEqual(bucket.force_destroy, true);
    assert.deepStrictEqual(bucket.tags, { Owner: 'platform' });
    assert.deepStrictEqual(bucket.timeouts, { create: '5m' });
    assert.ok(built.resource.aws_s3_bucket_website_configuration, 'the preset stopped applying');
});

test('gcp normalisation substitutes rather than deletes', async () => {
    const normalize = require('../gcp/terraform').normalizeResourceName[0];

    // Deleting was not injective: `Data Platform`, `DataPlatform` and
    // `data.platform` all became `dataplatform`, and that feeds a derived
    // Terraform resource name, so two sibling nodes silently merged.
    assert.strictEqual(normalize('Data Platform'), 'data-platform');
    assert.strictEqual(normalize('DataPlatform'), 'dataplatform');
    assert.strictEqual(normalize('eng/prod'), 'eng-prod');
    assert.strictEqual(normalize('my project #1'), 'my-project-1');

    // A name with nothing invalid in it does not move, which is what keeps this
    // from churning anyone's existing state.
    assert.strictEqual(normalize('data-platform'), 'data-platform');
    assert.strictEqual(normalize('already_fine'), 'already_fine');

    // A substitution at either end is not a legal Terraform identifier.
    assert.strictEqual(normalize('ÜberService'), 'berservice');

    assert.throws(() => normalize('###'), /no characters usable in a resource name/);
});
