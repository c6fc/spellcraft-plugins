'use strict';

/*
	The `refs::` convention: every resource a call manifested, addressed as
	"<terraform_resource_type>.<the name the caller passed>", valued as the
	*manifested* object plus a hidden `_terraform_id`.

	Nothing tested this before, which is why three defects lived in it at once:
	the value was the call's input rather than its result (so every entry was
	byte-identical and carried no per-resource information); half the manifested
	resources had no entry at all, excluded as an "array/index" scope boundary;
	and five of seven keys embedded this plugin's own derived name, so looking a
	ref up required the knowledge refs exists to hand you.
*/

const test = require('node:test');
const assert = require('node:assert');
const { newJsonnet } = require('./helpers/jsonnet');


// nodejs_function resolves its source relative to the *caller's* file, so a
// literal stands in for std.thisFile -- nothing here reads the source dir.
const PREAMBLE = `
	local lambda = (import "@c6fc/spellcraft-plugins/module.libsonnet").aws.terraform.lambda.config({
		thisFile: "/tmp/spell/manifest.jsonnet",
	});
`;

const evaluate = (snippet) =>
    newJsonnet()
        .evaluateSnippet(PREAMBLE + snippet)
        .then(JSON.parse);

// Every option that produces resources of its own, so a render covers every
// family the plugin can emit.
const EVERY_OPTION = `{
	execution_policy_attachments: ["arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess"],
	arns_allowed_to_invoke: ["arn:aws:iam::123456789012:root"],
	services_allowed_to_invoke: [{ principal: "apigateway.amazonaws.com" }],
	event_triggers: [{ schedule_expression: "cron(0 20 * * ? *)" }],
}`;

// Jsonnet-side helpers the assertions below share: every "<type>.<name>" the
// call manifested, and every _terraform_id anywhere in refs however nested.
const HELPERS = `
	local addresses(fn) = std.flattenArrays([
		["%s.%s" % [t, n] for n in std.objectFields(fn.resource[t])]
		for t in std.objectFields(fn.resource)
	]) + std.flattenArrays([
		["data.%s.%s" % [t, n] for n in std.objectFields(fn.data[t])]
		for t in std.objectFields(fn.data)
	]);

	local ids(v) =
		if std.isObject(v) then
			(if std.objectHasAll(v, "_terraform_id") then [v._terraform_id] else [])
			+ std.flattenArrays([ids(v[k]) for k in std.objectFields(v)])
		else if std.isArray(v) then std.flattenArrays([ids(e) for e in v])
		else [];
`;

test('every manifested resource is addressable through refs', async () => {
    // Was 7 of 14. The excluded half was the worst possible half: the policy
    // attachments are named after a path segment of the policy ARN, and one of
    // them comes from this plugin's own defaults, so a consumer could not know
    // that resource existed at all.
    const out = await evaluate(`${HELPERS}
		local fn = lambda.nodejs_function("s3cache", "us-east-1", ${EVERY_OPTION});

		{
			manifested: addresses(fn),
			uncovered: [a for a in addresses(fn) if !std.member(ids(fn.refs), a)],
		}`);

    assert.strictEqual(out.manifested.length, 14, 'the fixture still exercises every family');
    assert.deepStrictEqual(out.uncovered, [], 'every manifested address appears as some _terraform_id');
});

test('a ref key is built from the caller\'s name, never the derived one', async () => {
    // The point of the convention: looking a ref up must not require knowing
    // that the role is really called "lambda-s3cache".
    const out = await evaluate(`
		local fn = lambda.nodejs_function("s3cache", "us-east-1", ${EVERY_OPTION});
		{ keys: std.objectFields(fn.refs), roleId: fn.refs["aws_iam_role.s3cache"]._terraform_id }`);

    for (const key of out.keys) {
        assert.ok(
            key.endsWith('.s3cache'),
            `${key} is not addressed by the name the caller passed`,
        );
    }

    // ...while _terraform_id still carries the address Terraform actually uses.
    assert.strictEqual(out.roleId, 'aws_iam_role.lambda-s3cache');
});

test('a ref value is the manifested object, not the call\'s input', async () => {
    const out = await evaluate(`
		local fn = lambda.nodejs_function("s3cache", "us-east-1", { timeout: 30 });
		{
			logGroup: fn.refs["aws_cloudwatch_log_group.s3cache"],
			allIdentical: std.length(std.set([
				std.manifestJsonEx(fn.refs[k], "") for k in std.objectFields(fn.refs)
			])) == 1,
		}`);

    // "/aws/lambda/s3cache" is derived inside the plugin and visible nowhere
    // else -- exactly what an input-shaped refs could not expose.
    assert.strictEqual(out.logGroup.name, '/aws/lambda/s3cache');
    assert.strictEqual(out.logGroup.retention_in_days, 30);
    assert.strictEqual(out.logGroup.skip_destroy, true);

    // Every value used to be byte-identical, being the same copy of the input.
    assert.strictEqual(out.allIdentical, false);
});

test('a resource type fed by several options is sub-keyed by the option responsible', async () => {
    // aws_lambda_permission is the one type three different options produce, so
    // an array could not say which produced what.
    const out = await evaluate(`
		local fn = lambda.nodejs_function("s3cache", "us-east-1", ${EVERY_OPTION});
		local perms = fn.refs["aws_lambda_permission.s3cache"];
		{
			groups: std.objectFields(perms),
			triggerId: perms.event_triggers[0]._terraform_id,
			arnId: perms.arns_allowed_to_invoke[0]._terraform_id,
			serviceId: perms.services_allowed_to_invoke[0]._terraform_id,
		}`);

    assert.deepStrictEqual(out.groups, [
        'arns_allowed_to_invoke',
        'event_triggers',
        'services_allowed_to_invoke',
    ]);

    assert.strictEqual(out.triggerId, 'aws_lambda_permission.s3cache-trigger-0');
    assert.strictEqual(out.arnId, 'aws_lambda_permission.s3cache-allowed_arns-0');
    assert.strictEqual(out.serviceId, 'aws_lambda_permission.s3cache-allowed_services-0');
});

test('policy attachments are sub-keyed by policy name, including the one the plugin adds', async () => {
    const out = await evaluate(`
		local fn = lambda.nodejs_function("s3cache", "us-east-1", ${EVERY_OPTION});
		local attachments = fn.refs["aws_iam_role_policy_attachment.s3cache"];
		{
			policies: std.objectFields(attachments),
			xrayId: attachments.AWSXRayDaemonWriteAccess._terraform_id,
		}`);

    assert.deepStrictEqual(out.policies, ['AWSXRayDaemonWriteAccess', 'AmazonS3ReadOnlyAccess']);

    // Appended by the plugin, not asked for -- so refs is the only way to learn
    // this resource exists, let alone what it is called.
    assert.strictEqual(
        out.xrayId,
        'aws_iam_role_policy_attachment.lambda-s3cache-AWSXRayDaemonWriteAccess',
    );
});

test('a family std.prune() removed has no ref either', async () => {
    // prune() drops a resource family whose comprehension produced nothing, so
    // an entry for it would advertise an address that is not in the output.
    const out = await evaluate(`
		local bare = lambda.nodejs_function("s3cache", "us-east-1");
		local full = lambda.nodejs_function("s3cache", "us-east-1", ${EVERY_OPTION});
		{
			bare: std.objectFields(bare.refs),
			bareFamilies: std.objectFields(bare.resource),
			full: std.objectFields(full.refs),
		}`);

    const conditional = [
        'aws_lambda_permission.s3cache',
        'aws_cloudwatch_event_rule.s3cache',
        'aws_cloudwatch_event_target.s3cache',
    ];

    for (const key of conditional) {
        assert.ok(!out.bare.includes(key), `${key} should be absent when nothing produced it`);
        assert.ok(out.full.includes(key), `${key} should be present when something did`);
    }

    // refs and the manifest agree on which families exist.
    assert.ok(!out.bareFamilies.includes('aws_lambda_permission'));
});

test('refs never reaches the output', async () => {
    const out = await evaluate(`
		local fn = lambda.nodejs_function("s3cache", "us-east-1", ${EVERY_OPTION});
		{
			visible: std.objectFields(fn),
			manifestedText: std.manifestJsonEx(fn, ""),
		}`);

    assert.deepStrictEqual(out.visible, ['data', 'resource']);
    assert.ok(!out.manifestedText.includes('refs'), 'refs is hidden');
    assert.ok(!out.manifestedText.includes('_terraform_id'), '_terraform_id is hidden');
});

/*
	aws.terraform.s3's refs follow the same convention with a different
	implementation: every family it builds holds exactly one resource, so the
	entries are derived from the manifested tree rather than hand-listed. The
	key still comes from the caller's own name -- only _terraform_id comes from
	the manifested side, which is what the derivation is allowed to read.
*/

const s3Evaluate = (snippet) =>
    newJsonnet()
        .nativeCallback('@c6fc/spellcraft-plugins:aws.auth.getCallerIdentity', () => ({
            Account: '123456789012',
        }))
        .evaluateSnippet(
            `local s3 = (import "@c6fc/spellcraft-plugins/module.libsonnet").aws.terraform.s3;\n` + snippet,
        )
        .then(JSON.parse);

// Every option that adds a conditional resource family, so one call covers all
// sixteen resources s3 can produce.
const S3_EVERY_OPTION = `{
	versioning: "Enabled",
	acceleration_status: "Enabled",
	logging: "a-log-bucket",
	cors_rule: [{ allowed_methods: ["GET"], allowed_origins: ["*"] }],
	lifecycle_rule: [{ id: "expire", status: "Enabled" }],
	object_lock_configuration: [{ rule: [] }],
	replication_configuration: { role: "a-role", rule: [] },
	website: true,
	acl: "private",
	object_ownership: "ObjectWriter",
}`;

test('s3: every manifested resource is addressable through refs', async () => {
    const out = await s3Evaluate(`
		local b = s3.bucket("mybucket", "us-west-2", ${S3_EVERY_OPTION});
		local addresses = ["%s.%s" % [t, n] for t in std.objectFields(b.resource) for n in std.objectFields(b.resource[t])];
		local ids = [b.refs[k]._terraform_id for k in std.objectFields(b.refs)];
		{ manifested: addresses, uncovered: [a for a in addresses if !std.member(ids, a)] }`);

    assert.strictEqual(out.manifested.length, 16, 'the fixture still exercises every family');
    assert.deepStrictEqual(out.uncovered, []);
});

test('s3: the one derived name is what refs translates', async () => {
    // aws_kms_key is the only resource s3 names itself, as s3_<name>. Every
    // other family is keyed by the caller's name, so this is the entry that
    // earns the convention.
    const out = await s3Evaluate(`
		local b = s3.bucket("mybucket", "us-west-2");
		{
			kms: b.refs["aws_kms_key.mybucket"]._terraform_id,
			bucket: b.refs["aws_s3_bucket.mybucket"]._terraform_id,
			keys: std.objectFields(b.refs),
		}`);

    assert.strictEqual(out.kms, 'aws_kms_key.s3_mybucket');
    assert.strictEqual(out.bucket, 'aws_s3_bucket.mybucket');

    // Every key is addressed by the name the caller passed, never s3_mybucket.
    for (const key of out.keys) {
        assert.ok(key.endsWith('.mybucket'), `${key} is not addressed by the caller's name`);
    }
});

test('s3: a ref value is the manifested object', async () => {
    const out = await s3Evaluate(`
		local b = s3.bucket("mybucket", "us-west-2", { versioning: "Enabled" });
		{
			versioning: b.refs["aws_s3_bucket_versioning.mybucket"],
			kmsDescription: b.refs["aws_kms_key.mybucket"].description,
		}`);

    // Read straight off the resource, including what the plugin computed.
    assert.strictEqual(out.versioning.versioning_configuration.status, 'Enabled');
    assert.strictEqual(out.versioning.bucket, '${aws_s3_bucket.mybucket.id}');
    assert.ok(out.kmsDescription.includes('mybucket'), out.kmsDescription);
});

test('s3: a family that was not built has no ref', async () => {
    // Eight of the sixteen families are conditional on an option. s3 builds
    // them with a null-keyed field rather than std.prune, but the requirement
    // is the same: refs describes what was built.
    const out = await s3Evaluate(`
		local bare = s3.bucket("mybucket", "us-west-2");
		local full = s3.bucket("mybucket", "us-west-2", ${S3_EVERY_OPTION});
		{ bare: std.objectFields(bare.refs), full: std.objectFields(full.refs) }`);

    assert.strictEqual(out.bare.length, 8);
    assert.strictEqual(out.full.length, 16);

    for (const key of ['aws_s3_bucket_website_configuration.mybucket', 'aws_s3_bucket_acl.mybucket']) {
        assert.ok(!out.bare.includes(key), `${key} should be absent when nothing built it`);
        assert.ok(out.full.includes(key), `${key} should be present when something did`);
    }
});

test('s3: refs never reaches the output', async () => {
    const out = await s3Evaluate(`
		local b = s3.bucket("mybucket", "us-west-2", ${S3_EVERY_OPTION});
		{ visible: std.objectFields(b), text: std.manifestJsonEx(b, "") }`);

    assert.deepStrictEqual(out.visible, ['resource']);
    assert.ok(!out.text.includes('refs'));
    assert.ok(!out.text.includes('_terraform_id'));
});

test('s3: every family holds exactly one resource, which its refs derivation assumes', async () => {
    // The derivation reads the sole key of each family. Its own assert is a
    // backstop only -- each ref value is a separate lazy thunk, so it fires
    // only when somebody reads the affected entry. This is the check that
    // catches a new family producing several resources, at which point it
    // needs explicit entries the way aws.terraform.lambda's do.
    const out = await s3Evaluate(`
		local counts(b) = {
			[t]: std.length(std.objectFields(b.resource[t]))
			for t in std.objectFields(b.resource)
		};
		{
			bare: counts(s3.bucket("mybucket", "us-west-2")),
			full: counts(s3.bucket("mybucket", "us-west-2", ${S3_EVERY_OPTION})),
		}`);

    for (const [configuration, families] of Object.entries(out)) {
        for (const [type, count] of Object.entries(families)) {
            assert.strictEqual(
                count,
                1,
                `${configuration}: ${type} holds ${count} resources — refs needs an explicit entry for it`,
            );
        }
    }

    assert.strictEqual(Object.keys(out.full).length, 16, 'the fixture still covers every family');
});
