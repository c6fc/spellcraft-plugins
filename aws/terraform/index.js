'use strict';

process.env.AWS_SDK_JS_SUPPRESS_MAINTENANCE_MODE_MESSAGE=1

const fs = require("fs");
const os = require("os");
const path = require("path");

// The authenticated AWS instantiation from the sibling auth node.
const awsauth = require("../auth");
const { aws } = awsauth._spellcraft_metadata.functionContext;
// Called through the module rather than destructured, so the auth seam stays
// replaceable -- the guard tests swap it to prove the ordering and conflict
// checks fire before anything reaches the provider.
const ensureAuth = () => awsauth._internal.ensureAuth();

// Initialize caches
const artifacts = {};
const awsterraform = { projectName: false, bootstrapBucket: false, bootstrapLocation: false };
const remoteStates = {};

// Where a config-supplied project name came from, for error messages that can
// name the real source of a conflict.
let configuredProject = null;

exports._spellcraft_metadata = {
	functionContext: { awsterraform },

	// Seeds the project name only -- a file read, no network, so merely invoking
	// the CLI costs nothing and both provider nodes can seed independently.
	// bootstrap() is what creates the bucket and returns the backend block.
	init: async (spellframe) => {
		const project = readConfiguredProject(spellframe);

		if (project) {
			configuredProject = project;
			awsterraform.projectName = project;
		}
	}
}

// Reads config.spellcraftProject from the *consumer's* package.json (the same
// convention the terraform node uses for config.tf_version), so
// getArtifact()/putArtifact() have a namespace to key off even before the
// manifest's bootstrap() call is forced. File read only -- no network.
function readConfiguredProject(spellframe) {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(spellframe.baseDir, 'package.json'), 'utf-8'));
		return pkg?.config?.spellcraftProject || null;
	} catch (e) {
		return null;
	}
}

exports.bootstrap = [async function (project) {
	// Checked before ensureAuth(): a name conflict is a configuration error, and
	// reporting it should not require a round trip to the provider first.
	//
	// A spell has one project. A name that disagrees with one already in play --
	// whether it came from config.spellcraftProject or from an earlier
	// bootstrap() call in this process -- would move every later
	// getArtifact()/putArtifact() to a different namespace mid-manifest,
	// silently. The same name twice is a harmless no-op; getBootstrapBucket()'s
	// own cache makes that cheap. Reading another spell's state is what
	// getRemoteState() is for.
	if (awsterraform.projectName !== false && awsterraform.projectName !== project) {
		const source = (configuredProject === awsterraform.projectName)
			? `config.spellcraftProject in package.json`
			: `an earlier bootstrap() call in this process`;

		throw new Error(
			`[!] bootstrap("${project}") conflicts with "${awsterraform.projectName}", set by ${source}. ` +
			`A spell has one project -- use getRemoteState() to read another spell's state instead of ` +
			`a second bootstrap() call.`
		);
	}

	await ensureAuth();

	return await bootstrap(project);
}, "project"];

exports.getArtifact = [async function (name) {
	// Guard first: calling this before a project name is set is a manifest
	// ordering error, and saying so should not require credentials.
	assertBootstrapped('getArtifact');
	await ensureAuth();
	return await getArtifact(name);
}, "name"];

exports.getBootstrapBucket = [async function () {
	await ensureAuth();
	return await getBootstrapBucket();
}];

exports.getRemoteState = [async function (project) {
	await ensureAuth();
	return await getRemoteState(project);
}, "project"];

exports.putArtifact = [async function (name, content) {
	// Guard first: calling this before a project name is set is a manifest
	// ordering error, and saying so should not require credentials.
	assertBootstrapped('putArtifact');
	await ensureAuth();
	return await putArtifact(name, content);
}, "name", "content"];

async function bootstrap(project) {
	const s3 = new aws.S3();
	
	let bucketName;
	let bootstrapBucket = await getBootstrapBucket();

	if (!bootstrapBucket) {
		bucketName = `spellcraft-${Math.random().toString(36).replace(/[^a-z]+/g, '')}-${Math.round(Date.now() / 1000)}`;

		try {
			await s3.createBucket({
				Bucket: bucketName
			}).promise();

			await s3.putBucketTagging({
				Bucket: bucketName,
				Tagging: {
					TagSet: [{
						Key: "spellcraft-backend",
						Value: "true"
					}]
				}
			}).promise();

			await s3.putBucketVersioning({
				Bucket: bucketName,
				VersioningConfiguration: {
					MFADelete: "Disabled",
					Status: "Enabled"
				}
			}).promise();

			await s3.putPublicAccessBlock({
				Bucket: bucketName,
				PublicAccessBlockConfiguration: {
					BlockPublicAcls: true,
					BlockPublicPolicy: true,
					IgnorePublicAcls: true,
					RestrictPublicBuckets: true
				}
			}).promise();

			await s3.putBucketPolicy({
				Bucket: bucketName,
				Policy: JSON.stringify({
					Version: "2012-10-17",
					Statement: [{
						Sid: "AllowSSLOnly",
						Principal: "*",
						Action: "s3:*",
						Effect: "Deny",
						Resource: [
							`arn:aws:s3:::${bucketName}`,
							`arn:aws:s3:::${bucketName}/*`
						],
						Condition: {
							Bool: {
								"aws:SecureTransport": false
							}
						}
					}]
				})
			}).promise();
		} catch (e) {
			console.log(`SpellCraft error: Unable to create bucket: ${e}`);
			process.exit(1);
		}

		console.log(`[+] Created bootstrap bucket ${bucketName}`);

		// Store the bare name, not an ARN. Every consumer (getArtifact,
		// putArtifact, getRemoteState) passes this straight to S3 as `Bucket:`,
		// which only accepts a name -- and the discovery path below already
		// returns a name, so an ARN here made the two paths disagree.
		bootstrapBucket = bucketName;
	} else {
		bucketName = bootstrapBucket;
		console.log(`[+] Using bootstrap bucket ${bucketName}`);
	}

	let bootstrapLocation = await s3.getBucketLocation({
		Bucket: bucketName
	}).promise();

	bootstrapLocation = (bootstrapLocation.LocationConstraint == '') ? "us-east-1" : bootstrapLocation.LocationConstraint;

	awsterraform.projectName = project;
	awsterraform.bootstrapBucket = bootstrapBucket;
	awsterraform.bootstrapLocation = bootstrapLocation;

	return {
		terraform: {
			backend: {
				s3: {
					bucket: bucketName,
					key: `spellcraft/${project}/terraform.tfstate`,
					region: bootstrapLocation
				}
			}
		}
	}
}

async function getBootstrapBucket() {

	if (!!awsterraform.bootstrapBucket) {
		return awsterraform.bootstrapBucket;
	}

	const s3 = new aws.S3();
	const buckets = await s3.listBuckets().promise();

	const arns = buckets.Buckets
		.map(e => e.Name)
		.filter(e => /^spellcraft-[a-z]*?-\d{10}$/.test(e));

	if (arns.length == 1) {
		// Cache the discovery. Callers await this function for its side effect
		// and then read awsterraform.bootstrapBucket; without this write that
		// property stays unset unless bootstrap() ran in the same process.
		awsterraform.bootstrapBucket = arns[0];

		return arns[0];
	}

	if (arns.length > 1) {
		throw new Error("[!] More than one bootstrap bucket exists in this account. Fix this before continuing.");
	}

	return false;
}

async function getRemoteState(project) {

	if (!!!remoteStates[project]) {
		await getBootstrapBucket();

		const s3 = new aws.S3({ region: awsterraform.bootstrapLocation });

		let stateJson;

		try {
			stateJson = await s3.getObject({
				Bucket: awsterraform.bootstrapBucket,
				Key: `spellcraft/${project}/terraform.tfstate`
			}).promise();

		} catch(e) {
			throw new Error(`[!] Unable to retrieve remote state for project [ ${project} ]: ${e}`);
		}

		const state = JSON.parse(stateJson.Body);

		const resources = state.resources.reduce((a, c) => {
			let path;

			if (c.mode == "data") {
				a.data = (!a.data) ? {} : a.data;
				a.data[c.type] = (!a.data[c.type]) ? {} : a.data[c.type];

				path = a.data[c.type];
			} else {
				a[c.type] = (!a[c.type]) ? {} : a[c.type];

				path = a[c.type];
			}

			path[c.name] = (c.instances.length == 1) ? c.instances[0].attributes : c.instances.map(e => e.attributes);

			return a;
		}, {});

		resources.outputs = Object.keys(state.outputs).reduce((a, c) => {
			a[c] = state.outputs[c].value;

			return a;
		}, {});

		// console.log(resources.outputs);

		remoteStates[project] = resources;
	}

	// Read back through the cache. `resources` is block-scoped to the branch
	// above, so returning it directly threw a ReferenceError on every call.
	return remoteStates[project];
}

// Both artifact functions key their S3 object off `awsterraform.projectName`,
// which is set either by config.spellcraftProject during init() or by
// bootstrap(). Jsonnet's laziness means a manifest that calls bootstrap()
// without threading its result into whatever calls getArtifact/putArtifact can
// still evaluate this first -- and without this guard, `projectName` was
// silently `false`, so the object landed at `spellcraft/false/artifacts/<name>`
// instead of failing.
function assertBootstrapped(fnName) {
	if (!awsterraform.projectName) {
		throw new Error(
			`[!] ${fnName}() was called before a project name was set. Either set ` +
			`config.spellcraftProject in package.json, or call bootstrap(project) first and ` +
			`thread its return value into whatever calls ${fnName}() so evaluation order is ` +
			`forced -- Jsonnet does not otherwise guarantee bootstrap() runs first.`
		);
	}
}

async function getArtifact(name) {
	assertBootstrapped('getArtifact');

	if (!!!artifacts[name]) {
		await getBootstrapBucket();

		const s3 = new aws.S3({ region: (awsterraform.bootstrapLocation || 'us-east-1') });

		const object = await s3.getObject({
			Bucket: awsterraform.bootstrapBucket,
			Key: `spellcraft/${awsterraform.projectName}/artifacts/${name}`
		}).promise();

		// putArtifact stores JSON, so decode it back into the value that was
		// stored. Returning the raw Body handed Jsonnet a Buffer, which
		// serialises as {"type":"Buffer","data":[...]} rather than the artifact
		// -- and disagreed with the warm-cache path, which returns the original
		// object. Fall back to the plain string for artifacts written by hand.
		const body = object?.Body?.toString();

		try {
			artifacts[name] = JSON.parse(body);
		} catch (e) {
			artifacts[name] = body;
		}
	}

	return artifacts[name];
}

async function putArtifact(name, contentJson) {
	assertBootstrapped('putArtifact');

	// The facade serialises `content`, because a native argument has to be a
	// primitive. Parse it back so the cache holds the same shape getArtifact()
	// returns -- the two disagreeing on that is the bug getArtifact()'s own
	// comment describes.
	const content = JSON.parse(contentJson);

	// Skip the write only when this exact content is already stored. The
	// comparison is on the serialised form deliberately -- the parsed value is a
	// fresh reference on every call and would never compare equal.
	if (JSON.stringify(artifacts[name]) !== contentJson) {
		await getBootstrapBucket();

		const s3 = new aws.S3({ region: (awsterraform.bootstrapLocation || 'us-east-1') });

		const object = await s3.putObject({
			Body: Buffer.from(contentJson),
			Bucket: awsterraform.bootstrapBucket,
			Key: `spellcraft/${awsterraform.projectName}/artifacts/${name}`
		}).promise();

		artifacts[name] = content;
	}

	return true;
}