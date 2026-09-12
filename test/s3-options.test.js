'use strict';

/*
	aws.terraform.s3's three-layer option pattern: defaults a caller may
	override, then the caller's options, then values the plugin computes and
	will not let them override.

	Field visibility is what separates "an argument of aws_s3_bucket" from "an
	input to this plugin". Only the former may manifest into the bucket body --
	Terraform rejects an unsupported argument outright, so a plugin input
	leaking there is a hard failure for the consumer.

	The invariant these tests hold: **a caller cannot un-hide a plugin input.**
	In Jsonnet a ':' field inherits the visibility of the field it overrides,
	so declaring the default '::' is sufficient and only ':::' would force it
	visible. An earlier version re-declared ten of these as ':: super.<field>'
	to defend against something the language already guarantees; nothing
	asserted the invariant either way.
*/

const test = require('node:test');
const assert = require('node:assert');
const { newJsonnet } = require('./helpers/jsonnet');


const evaluate = (snippet) =>
    newJsonnet()
        // s3 reads the account id for its bucket policies; stubbed so this
        // needs no credentials.
        .nativeCallback('@c6fc/spellcraft-plugins:aws.auth.getCallerIdentity', () => ({
            Account: '123456789012',
        }))
        .evaluateSnippet(
            `local s3 = (import "@c6fc/spellcraft-plugins/module.libsonnet").aws.terraform.s3;\n` + snippet,
        )
        .then(JSON.parse);

// The only arguments aws_s3_bucket itself should ever receive from this plugin.
const BUCKET_ARGUMENTS = ['bucket_prefix', 'force_destroy', 'object_lock_enabled', 'provider', 'tags'];

// Every option that is a plugin input rather than a bucket argument.
const PLUGIN_INPUTS = {
    type: '"static-site"',
    acl: '"public-read"',
    allow_insecure_access: 'true',
    object_ownership: '"ObjectWriter"',
    public_access_block: 'false',
    server_side_encryption: 'false',
    acceleration_status: '"Enabled"',
    cors_rule: '[]',
    lifecycle_rule: '[]',
    logging: '"a-log-bucket"',
    object_lock_configuration: '[]',
    policy_statements: '[]',
    replication_configuration: '{}',
    request_payer: '"Requester"',
    versioning: '"Enabled"',
    website: '{}',
};

test('a bucket built from defaults carries only real aws_s3_bucket arguments', async () => {
    const fields = await evaluate(
        `std.objectFields(s3.bucket("mybucket", "us-west-2").resource.aws_s3_bucket.mybucket)`,
    );

    assert.deepStrictEqual(fields, BUCKET_ARGUMENTS);
});

test('a caller cannot un-hide a plugin input by passing it with a single colon', async () => {
    // The invariant. Every plugin input, overridden at once with ':' -- none of
    // them may reach the bucket body, where Terraform would reject it.
    const options = Object.entries(PLUGIN_INPUTS)
        .map(([key, value]) => `${key}: ${value}`)
        .join(', ');

    const fields = await evaluate(
        `std.objectFields(s3.bucket("mybucket", "us-west-2", { ${options} }).resource.aws_s3_bucket.mybucket)`,
    );

    assert.deepStrictEqual(fields, BUCKET_ARGUMENTS);
});

test('each plugin input stays hidden on its own, not just in bulk', async () => {
    // Overriding all of them together could mask one that only leaks alone.
    for (const [key, value] of Object.entries(PLUGIN_INPUTS)) {
        const fields = await evaluate(
            `std.objectFields(s3.bucket("mybucket", "us-west-2", { ${key}: ${value} }).resource.aws_s3_bucket.mybucket)`,
        );

        assert.deepStrictEqual(fields, BUCKET_ARGUMENTS, `${key} leaked into the bucket body`);
    }
});

test('a caller-supplied value still reaches the resource it configures', async () => {
    // Hidden must not mean ignored: the input is read to build the separate
    // resource it belongs to.
    const out = await evaluate(`
		local bucket = s3.bucket("mybucket", "us-west-2", {
			versioning: "Enabled",
			request_payer: "Requester",
			acceleration_status: "Enabled",
		});
		{
			versioning: bucket.resource.aws_s3_bucket_versioning.mybucket.versioning_configuration.status,
			payer: bucket.resource.aws_s3_bucket_request_payment_configuration.mybucket.payer,
			acceleration: bucket.resource.aws_s3_bucket_accelerate_configuration.mybucket.status,
		}`);

    assert.deepStrictEqual(out, {
        versioning: 'Enabled',
        payer: 'Requester',
        acceleration: 'Enabled',
    });
});

test('reading `type` is safe whether or not the caller passed one', async () => {
    // `type` had no default, so the third layer's `type:: super.type` referred
    // to a field that does not exist when the caller passes none. Only laziness
    // kept that unreached -- nothing in the plugin reads it.
    const out = await evaluate(`{
		absent: s3.bucket("mybucket", "us-west-2").resource.aws_s3_bucket.mybucket.type,
		present: s3.bucket("mybucket", "us-west-2", { type: "static-site" }).resource.aws_s3_bucket.mybucket.type,
	}`);

    assert.deepStrictEqual(out, { absent: null, present: 'static-site' });
});

test('the built-in types still differ from each other and from the default', async () => {
    // log-storage rendering identically to the default was a real defect once:
    // its ACL was discarded because ownership stayed BucketOwnerEnforced.
    const out = await evaluate(`{
		default: s3.bucket("mybucket", "us-west-2"),
		"static-site": s3.bucket("mybucket", "us-west-2", { type: "static-site" }),
		"log-storage": s3.bucket("mybucket", "us-west-2", { type: "log-storage" }),
	}`);

    const rendered = Object.values(out).map((v) => JSON.stringify(v));
    assert.strictEqual(new Set(rendered).size, 3, 'two bucket types rendered identically');
});
