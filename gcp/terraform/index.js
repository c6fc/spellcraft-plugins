'use strict';

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require('crypto');

// The authenticated googleapis instantiation from the sibling auth node.
const gcpauth = require("../auth");
const { google } = gcpauth._spellcraft_metadata.functionContext;
// Called through the module rather than destructured, so the auth seam stays
// replaceable -- the guard tests swap it to prove the ordering and conflict
// checks fire before anything reaches the provider.
const ensureAuth = () => gcpauth._internal.ensureAuth();

// `google` is a lazy proxy over the 196MB googleapis module (see ../auth), so
// building a client at module scope would defeat that and load it on every
// require of this package. Memoized here instead, built on first real use.
let storageClient = null;
const storage = () => (storageClient ??= google.storage('v1'));

// ~70ms to load, reached only on the interactive "create the bootstrap bucket?"
// prompt. Lazy for the same reason the client above is.
const confirm = (...args) => require("@inquirer/prompts").confirm(...args);

let cachedProject = null;

// Initialize caches
const artifacts = {};
const gcpterraform = { projectName: null, bootstrapBucket: null };
const remoteStates = {};
const serviceRegistry = new Set();

// Where a config-supplied project name came from, for error messages that can
// name the real source of a conflict.
let configuredProject = null;

// Emitted by the terraform node -- the two know nothing about each other, they
// meet on this string. See ../../terraform/index.js.
const PRE_APPLY = '@c6fc/spellcraft-plugins:terraform.pre-apply';

exports._spellcraft_metadata = {
	functionContext: { gcpterraform },
	// Registers a listener and seeds the project name. Neither touches the
	// network -- credentials resolve on first use (see ../auth), and bootstrap()
	// is what creates the bucket and returns the backend block.
	init: async (spellframe) => {
		spellframe.on(PRE_APPLY, async () => {
			if (serviceRegistry.size > 0) {
				const servicesArray = Array.from(serviceRegistry);
				console.log(`[gcp.terraform] Enabling registered GCP services on pre-apply: ${servicesArray.join(', ')}`);
				await ensureAuth();
				await gcpauth._internal.enableServices(servicesArray);
				serviceRegistry.clear();
			}
		});

		// Reads config.spellcraftProject from the *consumer's* package.json (the
		// same convention the terraform node uses for config.tf_version), so
		// getArtifact()/putArtifact() have a namespace to key off even before
		// the manifest's bootstrap() call is forced. File read only.
		const project = readConfiguredProject(spellframe);

		if (project) {
			configuredProject = project;
			gcpterraform.projectName = project;
		}
	}
	// No `requires`. The auth node is a sibling in this package, reached by
	// relative require.
}

function readConfiguredProject(spellframe) {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(spellframe.baseDir, 'package.json'), 'utf-8'));
		return pkg?.config?.spellcraftProject || null;
	} catch (e) {
		return null;
	}
}

exports.enableServices = [function (servicesJson) {
	const services = JSON.parse(servicesJson);
	services.forEach(s => serviceRegistry.add(s));
	return true;
}, "services"];

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
	if (gcpterraform.projectName !== null && gcpterraform.projectName !== project) {
		const source = (configuredProject === gcpterraform.projectName)
			? `config.spellcraftProject in package.json`
			: `an earlier bootstrap() call in this process`;

		throw new Error(
			`[!] bootstrap("${project}") conflicts with "${gcpterraform.projectName}", set by ${source}. ` +
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

// Substitutes, rather than deletes. Deleting is not injective: `Data Platform`,
// `DataPlatform` and `data.platform` all collapsed onto `dataplatform`, and this
// feeds projectAnchor()'s derived name -- so two sibling nodes could produce the
// same Terraform resource name and then be silently deep-merged by tree.walk.
// GCP display names routinely carry spaces and capitals, so that is an ordinary
// tree, not a contrived one. (tree.walk now refuses a duplicate derived name
// outright; normalising losslessly is what stops it reaching that point.)
//
// Only names that are *currently* lossy change: one with no invalid characters
// has nothing to substitute, so no existing resource name moves.
exports.normalizeResourceName = [function (name) {
	// Trimmed, because a substitution at either end is a Terraform identifier
	// that does not parse -- one must begin with a letter or an underscore --
	// and because `normalize(body.name)` reaches the front of a project id.
	const normalized = name.replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase().replace(/^-+|-+$/g, "");

	// Everything invalid normalises to "-", which is not a name -- and an empty
	// result used to produce a derived name with an empty component and a
	// trailing underscore, which is worse than a refusal.
	if (normalized === "") {
		throw new Error(
			`[SpellCraft] '${name}' has no characters usable in a resource name ` +
			`(letters, digits, '_' and '-' survive normalisation).`
		);
	}

	return normalized;
}, "name"];

exports.putArtifact = [async function (name, content) {
	// Guard first: calling this before a project name is set is a manifest
	// ordering error, and saying so should not require credentials.
	assertBootstrapped('putArtifact');
	await ensureAuth();
	return await putArtifact(name, content);
}, "name", "content"];

exports.shortHash = [function (text) {
	return crypto.createHash('sha1').update(text).digest('hex').substr(-5);
}, "text"];

async function bootstrap(projectName) {
	cachedProject = await gcpauth.getProjectId[0]();

	// Set env vars so Terraform (a child process, spawned later by
	// the terraform node) picks up the right quota project.
	// USER_PROJECT_OVERRIDE is the same value regardless of which project, so
	// ??= is fine there. GOOGLE_CLOUD_QUOTA_PROJECT is per-project and must be
	// assigned outright: with ??= the first bootstrap() in a process would win
	// permanently, and a second render for a different project on the same
	// process -- no concurrency required, just reuse -- would inherit its quota
	// override.
	process.env.USER_PROJECT_OVERRIDE ??= "true";
	process.env.GOOGLE_CLOUD_QUOTA_PROJECT = cachedProject;

	const targetBucket = `spellcraft-terraform-${cachedProject}`;

	if (!await getBootstrapBucket()) {

		console.log(`No 'spellcraft-terraform' bucket found in project "${cachedProject}".`);

		try {
			const createIt = await confirm({
				message: `Create GCS Bootstrap Bucket in project "${cachedProject}"?`,
				default: true
			});

			if (!createIt) {
				console.log("User cancelled bootstrap bucket creation. Select a different project with `export GOOGLE_CLOUD_PROJECT=<project-id>` and re-run the command.");
				process.exit(0);
			}

			console.log(`[+] Creating GCS Bootstrap Bucket: ${targetBucket}`);
			await storage().buckets.insert({
				project: cachedProject,
				requestBody: {
					name: targetBucket,
					location: 'US', // Defaulting to US multi-region for high availability
					storageClass: 'STANDARD',
					versioning: { enabled: true },
					iamConfiguration: {
						uniformBucketLevelAccess: { enabled: true }
					}
				}
			});
		} catch (e) {
			console.log(e);
			throw new Error(`Failed to discover/create GCS bucket: ${e.message}`);
		}
	}

	gcpterraform.bootstrapBucket = targetBucket;
	gcpterraform.projectName = projectName;

	// Return the Terraform backend configuration object
	return {
		terraform: {
			backend: {
				gcs: {
					bucket: gcpterraform.bootstrapBucket,
					prefix: `spellcraft/${projectName}`
				}
			}
		}
	};
};

async function getBootstrapBucket() {

	if (!!gcpterraform.bootstrapBucket) {
		return gcpterraform.bootstrapBucket;
	}

	if (!cachedProject) {
		cachedProject = await gcpauth.getProjectId[0]();
	}

	try {
		await storage().buckets.get({ bucket: `spellcraft-terraform-${cachedProject}` });
		gcpterraform.bootstrapBucket = `spellcraft-terraform-${cachedProject}`;

		return gcpterraform.bootstrapBucket;
	} catch (e) {
		console.log(`[!] Terraform backend bucket not found in current project: ${cachedProject}`);
		return false
	}
}

async function getRemoteState(project) {

	if (!!!remoteStates[project]) {
		if (!gcpterraform.bootstrapBucket) throw new Error("Module not bootstrapped. Call bootstrap() first.");

		let res;

		try {
			res = await storage().objects.get({
				bucket: gcpterraform.bootstrapBucket,
				object: `spellcraft/${project}/default.tfstate`,
				alt: 'media'
			});
		} catch (e) {
			throw new Error(`Could not find remote state for project: ${project}`);
		}

		const state = JSON.parse(res.data);

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

	// Read back through the cache: `resources` is block-scoped to the branch
	// above and is not in scope here.
	return remoteStates[project];
}

// Both artifact functions key their object off gcpterraform.projectName,
// which only bootstrap() sets. getBootstrapBucket() alone -- called directly,
// or via getRemoteState() -- sets bootstrapBucket without touching
// projectName, so a guard that only checked bootstrapBucket could pass while
// projectName was still null, and the object landed at
// spellcraft/null/artifacts/<name>.json instead of failing.
function assertBootstrapped(fnName) {
	if (!gcpterraform.projectName) {
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

	try {
		const res = await storage().objects.get({
			bucket: gcpterraform.bootstrapBucket,
			object: `spellcraft/${gcpterraform.projectName}/artifacts/${name}.json`,
			alt: 'media'
		});
		return res.data;
	} catch (e) {
		return null;
	}
};

async function putArtifact(name, contentJson) {
	assertBootstrapped('putArtifact');

	// The facade serialises `content`, because a native argument has to be a
	// primitive. Re-serialise it indented for storage rather than writing the
	// compact form straight through, so an artifact read by a human stays
	// readable.
	const content = JSON.parse(contentJson);

	const res = await storage().objects.insert({
		bucket: gcpterraform.bootstrapBucket,
		name: `spellcraft/${gcpterraform.projectName}/artifacts/${name}.json`,
		media: {
			mimeType: 'application/json',
			body: JSON.stringify(content, null, 2)
		}
	});

	return !!res.data;
};