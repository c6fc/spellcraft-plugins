'use strict';

/*
	Every "${...}" string the lambda factory builds names a resource, and until
	now nothing checked that the resource exists.

	This is the hole `event_triggers` fell through: the permission's source_arn
	was built as '${aws_cloudwatch_event_rule.%s-%s.arn}' while every other line
	in that block built '%s-trigger-%s', so the option had *never* produced a
	valid configuration. `spellcraft generate` rendered it happily, refs reported
	the rule correctly, and the suite passed -- because the defect is in the
	content of a string, and the suite checks manifestation, which is exactly the
	level at which a wrong string is invisible. `terraform validate` catches it;
	so does this, offline, for the whole class.
*/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { newJsonnet } = require('./helpers/jsonnet');

const scratchDirs = [];

// One directory per call, so the injection test's "did it run?" check cannot be
// satisfied by something another test left behind.
function scratch() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spellcraft-lambda-'));
	scratchDirs.push(dir);
	return dir;
}

test.after(() => {
	for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

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

const fn = (options = '{}') => evaluate(`lambda.nodejs_function("w", "us-west-2", ${options})`);

// "<type>.<name>" for everything a call declared, resources and data sources
// alike, in the form a Terraform reference uses.
function declaredAddresses(built) {
    const addresses = [];

    for (const [type, named] of Object.entries(built.resource || {})) {
        for (const name of Object.keys(named)) addresses.push(`${type}.${name}`);
    }

    for (const [type, named] of Object.entries(built.data || {})) {
        for (const name of Object.keys(named)) addresses.push(`data.${type}.${name}`);
    }

    return new Set(addresses);
}

// Terraform's own built-in scopes address nothing this call declares.
const BUILT_IN = new Set(['path', 'var', 'local', 'each', 'count', 'terraform', 'module']);

// Every managed-resource address referenced from anywhere inside the rendered
// tree, however deeply nested and including references inside JSON-encoded
// policy documents.
function referencedAddresses(value, found = new Set()) {
    if (typeof value === 'string') {
        for (const [, body] of value.matchAll(/\$\{([^}]+)\}/g)) {
            const parts = body.trim().split('.');
            if (BUILT_IN.has(parts[0])) continue;

            found.add(parts[0] === 'data' ? parts.slice(0, 3).join('.') : parts.slice(0, 2).join('.'));
        }
    } else if (Array.isArray(value)) {
        for (const entry of value) referencedAddresses(entry, found);
    } else if (value && typeof value === 'object') {
        for (const entry of Object.values(value)) referencedAddresses(entry, found);
    }

    return found;
}

async function assertReferencesResolve(options) {
    const built = await fn(options);
    const declared = declaredAddresses(built);

    const dangling = [...referencedAddresses(built)].filter((address) => !declared.has(address));

    assert.deepStrictEqual(dangling, [], `references nothing declared: ${dangling.join(', ')}`);
    return built;
}

test('every reference a default call emits names a resource it declared', async () => {
    await assertReferencesResolve('{}');
});

test('an event_triggers call references the rule it declares', async () => {
    // The one that was broken, and it was broken for every caller who ever set
    // it: the permission pointed at "aws_cloudwatch_event_rule.w-0" while the
    // rule was declared as "w-trigger-0".
    await assertReferencesResolve('{ event_triggers: [{ schedule_expression: "rate(5 minutes)" }] }');
});

test('every reference resolves with each option group in play', async () => {
    await assertReferencesResolve(`{
		event_triggers: [
			{ schedule_expression: "rate(5 minutes)" },
			{ schedule_expression: "cron(0 20 * * ? *)" },
		],
		arns_allowed_to_invoke: ["arn:aws:iam::123456789012:root"],
		services_allowed_to_invoke: [{ principal: "apigateway.amazonaws.com" }],
		execution_policy_attachments: ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"],
		execution_policy_statements: [{ Effect: "Deny", Action: "s3:*", Resource: "*" }],
	}`);
});

test('the event target references the rule rather than repeating its name', async () => {
    const built = await fn('{ event_triggers: [{ schedule_expression: "rate(5 minutes)" }] }');
    const target = built.resource.aws_cloudwatch_event_target['w-trigger-0'];

    // The literal was the right *string*, so validate passed either way -- but a
    // literal creates no dependency edge, leaving Terraform free to create the
    // target before the rule exists.
    assert.strictEqual(target.rule, '${aws_cloudwatch_event_rule.w-trigger-0.name}');
});

test('ENVVARS is quoted so that a value containing a quote cannot break out', async () => {
	// The file gets `source`d. Raw single-quoting meant one apostrophe took out
	// the whole file -- the unterminated quote swallows every variable after it
	// -- and a crafted value ran as a command. Values reach here from
	// getArtifact(), getRemoteState() and API responses, so nobody need have
	// typed one.
	const dir = scratch();
	const injected = path.join(dir, 'injected');

	const values = {
		APOSTROPHE: "Bob's config",
		INJECT: `x'; touch ${injected}; echo '`,
		PLAIN: 'ordinary',
	};

	const built = await fn(`{ environment: { variables: ${JSON.stringify(values)} } }`);
	const content = built.resource.local_file['lambda-w_envvars'].content;

	assert.match(content, /declare APOSTROPHE='Bob'\\''s config'/);

	// Asserted by running it, because that is the only thing that settles it:
	// source the file in a real shell and read every value back.
	const file = path.join(dir, 'ENVVARS');
	fs.writeFileSync(file, content);

	const read = spawnSync('bash', ['-c',
		`set -u; source ${JSON.stringify(file)}; printf '%s\\0' "$APOSTROPHE" "$INJECT" "$PLAIN"`,
	], { encoding: 'utf8' });

	assert.strictEqual(read.status, 0, `the file could not be sourced: ${read.stderr}`);
	assert.deepStrictEqual(read.stdout.split('\0').slice(0, 3), Object.values(values));

	// And nothing the value asked for actually happened.
	assert.strictEqual(fs.existsSync(injected), false, 'the value executed as a command');
});

test('a non-string environment value is quoted too', async () => {
	const built = await fn('{ environment: { variables: { N: 42, B: true } } }');
	const content = built.resource.local_file['lambda-w_envvars'].content;

	assert.match(content, /declare N='42'/);
	assert.match(content, /declare B='true'/);
});

test('an attachment is keyed by the policy name, not by a path segment', async () => {
	// AWS-managed *service-role* policies -- the most common thing to attach to a
	// Lambda execution role -- are path-prefixed, and splitting on the second
	// segment named every one of them "service-role".
	const built = await fn(`{
		execution_policy_attachments: [
			"arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
			"arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
			"arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess",
		],
	}`);

	const keys = Object.keys(built.resource.aws_iam_role_policy_attachment).sort();

	assert.deepStrictEqual(keys, [
		'lambda-w-AWSLambdaBasicExecutionRole',
		'lambda-w-AWSLambdaVPCAccessExecutionRole',
		'lambda-w-AWSXRayDaemonWriteAccess',
		'lambda-w-AmazonS3ReadOnlyAccess',
	]);

	// Two service-role policies used to be a hard `duplicate field name:
	// "lambda-w-service-role"` -- naming a key the caller never wrote, from
	// inside the plugin, under twenty std.jsonnet frames.
	assert.ok(!keys.includes('lambda-w-service-role'));
});

test('refs sub-keys a path-prefixed attachment by the name the README promises', async () => {
	const built = await evaluate(`
		lambda.nodejs_function("w", "us-west-2", {
			execution_policy_attachments: ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"],
		}).refs["aws_iam_role_policy_attachment.w"].AWSLambdaBasicExecutionRole._terraform_id
	`);

	assert.strictEqual(built, 'aws_iam_role_policy_attachment.lambda-w-AWSLambdaBasicExecutionRole');
});

test('an ARN that is not a policy ARN is named, with the option that carried it', async () => {
	// `array bounds error: 1 not within [0, 1)` mentioned neither ARN, policy,
	// attachment, nor which option produced it.
	await assert.rejects(
		() => fn('{ execution_policy_attachments: ["arn:aws:iam::aws:policy-AmazonS3ReadOnlyAccess"] }'),
		/execution_policy_attachments entry .* is not an IAM policy ARN/
	);
});

test("a caller's depends_on attaches to the function, not to the archive", async () => {
	const built = await fn('{ depends_on: ["aws_vpc_endpoint.lambda"] }');

	assert.deepStrictEqual(built.resource.aws_lambda_function.w.depends_on, [
		'data.archive_file.w',
		'aws_iam_role_policy.lambda-w',
		'aws_vpc_endpoint.lambda',
	]);

	// depends_on on a *data source* defers its read to apply, so source_code_hash
	// becomes "(known after apply)" and the plan stops showing whether the
	// function changed.
	assert.deepStrictEqual(built.data.archive_file.w.depends_on, ['null_resource.npm_install-w']);
});
