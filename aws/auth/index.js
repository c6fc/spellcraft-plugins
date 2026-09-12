'use strict';


process.env.AWS_SDK_JS_SUPPRESS_MAINTENANCE_MODE_MESSAGE=1

const fs = require("fs");
const os = require("os");
const ini = require("ini");
const path = require("path");
const readline = require("readline");

// require("aws-sdk") costs ~170ms and unpacks 100MB of client definitions, and
// every node in this package ships together -- so an eager require here is paid
// by a GCP-only spell, and by `spellcraft --help`, for nothing. This proxy defers
// it to first property access and then behaves exactly like the module, so the
// ~40 `aws.config` / `new aws.STS()` call sites below and every consumer reading
// `functionContext.aws` need no special handling.
let sdk = null;
const load = () => (sdk ??= require("aws-sdk"));
const aws = new Proxy({}, {
	get: (_, key) => load()[key],
	set: (_, key, value) => ((load()[key] = value), true),
});

// Credentials resolve once, on first use, rather than from an init() hook.
// Core runs every loaded plugin's init() unconditionally, so resolving at init
// time would make an AWS credential failure fatal to a spell that never touches
// AWS. Memoized on the promise, so concurrent natives share one resolution
// rather than racing, and a failure is not silently retried.
let authPromise = null;
const ensureAuth = () => (authPromise ??= setAwsCredentials());

let cached_caller = null;

// Reachable by sibling nodes, never registered as a native: the aggregator in
// ../../index.js skips every export key beginning with an underscore.
exports._internal = { ensureAuth, verifyCredentials };

exports._spellcraft_metadata = {
	functionContext: { aws },
	cliExtensions: (yargs, spellframe) => {
		yargs
			// Neither command calls spellframe.init(). Core's init() is
			// all-or-nothing across every loaded plugin, so asking for it here runs
			// every other node's hook as well. ensureAuth() is this node's own
			// initialization, and it is all either command needs.
			.command("aws-identity", "Display the AWS IAM identity of the SpellCraft execution context", (yargs) => yargs, async (argv) => {

				await ensureAuth();
				console.log(await verifyCredentials());

			})
			.command("aws-exportcredentials", "Export the current credentials as environment variables", (yargs) => yargs, async (argv) => {

				await ensureAuth();
				exportCredentials();

			});

		console.log(`[+] Imported SpellFrame CLI extensions for @c6fc/spellcraft-plugins:aws.auth`);
	}

	// No init hook. See ensureAuth() above.
}

exports.getCallerIdentity = [async () => {
	await ensureAuth();
	return cached_caller;
}];

exports.aws = [async function (clientObj, method, params) {
		// Through _internal rather than the module-scope const, so the auth seam
		// stays swappable -- the same reason the terraform nodes reach it that
		// way. Identical at runtime; the memoized promise is the same one.
		await exports._internal.ensureAuth();
		clientObj = JSON.parse(clientObj);

		// Both of these used to surface as raw JavaScript -- `TypeError:
		// aws[clientObj.service] is not a constructor` and `TypeError:
		// client[method] is not a function` -- naming neither the service, the
		// method, nor aws.call(). The second is the single most likely mistake
		// against this API: AWS's own documentation, CLI and IAM actions all say
		// GetCallerIdentity, and only SDK v2 wants getCallerIdentity.
		if (typeof aws[clientObj.service] !== "function") {
			throw new Error(
				`[SpellCraft] aws.call(): '${clientObj.service}' is not an aws-sdk v2 client. ` +
				`Client names are PascalCase, as in 'STS', 'S3' or 'Lambda'.`
			);
		}

		const client = new aws[clientObj.service](clientObj.params);

		if (typeof client[method] !== "function") {
			const camel = method.charAt(0).toLowerCase() + method.slice(1);

			throw new Error(
				`[SpellCraft] aws.call(): '${clientObj.service}' has no method '${method}'. ` +
				(typeof client[camel] === "function"
					? `SDK v2 method names are lowerCamelCase -- try '${camel}'.`
					: `SDK v2 method names are lowerCamelCase.`)
			);
		}

		return client[method](JSON.parse(params)).promise();
	}, "clientObj", "method", "params"];

async function exportCredentials() {
	await verifyCredentials();
	['AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'].map(e => {
		if (process.env?.[e]) {
			console.log(`export ${e}=${process.env[e]}`);
		}
	});
}

async function setAwsCredentials() {

	let valid;
	let profile = process.env.AWS_PROFILE;

	if (!profile) {

		let caller = await verifyCredentials();
		if (!!caller) {

			if (!!process.env.SPELLCRAFT_ASSUMEROLE) {
				caller = await processRoleChain();
			}

			console.log(`[+] Authenticated as ${caller.Arn ?? caller.arn}`);
			return caller;
		}

		console.log(`[!] No profile was specified, and the default credential context is invalid.`);

		process.exit(1);
	}

	delete process.env.AWS_PROFILE;
	delete process.env.AWS_ACCESS_KEY_ID;
	delete process.env.AWS_SECRET_ACCESS_KEY;
	delete process.env.AWS_SESSION_TOKEN;

	if (!fs.existsSync(`${os.homedir()}/.aws/credentials`)) {
		console.log("[!] The default credential file is missing. Have you configured the AWS CLI yet?");
		process.exit(1);
	}

	const credfile = ini.parse(fs.readFileSync(`${os.homedir()}/.aws/credentials`, 'utf-8'));

	if (!credfile[profile]) {
		throw new Error(`AWS Profile [${profile}] isn't set.`);
	}

	const creds = credfile[profile];
	const cacheFile = `${os.homedir()}/.aws/profile_cache.json`;

	// Initialize and test the cache before trying anything else.
	let cache;

	if (fs.existsSync(cacheFile)) {
		try {

			cache = JSON.parse(fs.readFileSync(cacheFile));

			if (!!cache.expireTime && (!!!process.env.SPELLCRAFT_ASSUMEROLE && cache.profile == profile) || cache.profile == process.env.SPELLCRAFT_ASSUMEROLE) {
				if (cache.expireTime > Date.now() + 2700000) {

					aws.config.update({
						credentials: cache
					});

					valid = await verifyCredentials();

					if (!valid) {
						throw new Error("AWS credential cache verification error");
					}

					process.env.AWS_PROFILE = '';
					process.env.AWS_ACCESS_KEY_ID = aws.config.credentials.accessKeyId;
					process.env.AWS_SECRET_ACCESS_KEY = aws.config.credentials.secretAccessKey;
					process.env.AWS_SESSION_TOKEN = aws.config.credentials.sessionToken ?? '';

					console.log(`[+] Successfully resumed session as ${cache.profile}; Valid for ${((cache.expireTime - Date.now()) / 60000).toFixed(0)} minutes.`);

					return valid;
				}

				console.log(`[!] Cache expires in ${((cache.expireTime - Date.now()) / 60000).toFixed(0)} minutes. Skipping.`);
			}

		} catch (e) {
			console.log(e);
			cache = {};
		}
	}

	// Use long-term creds if they're present. Remove the cache if successful.
	if (!!creds.aws_access_key_id && !!creds.aws_secret_access_key) {
		try {
		
			aws.config.update({
				credentials: {
					accessKeyId: creds.aws_access_key_id,
					secretAccessKey: creds.aws_secret_access_key
				}
			});

			process.env.AWS_ACCESS_KEY_ID = creds.aws_access_key_id;
			process.env.AWS_SECRET_ACCESS_KEY = creds.aws_secret_access_key;

			valid = await verifyCredentials();

			if (!valid) {
				throw new Error("AWS profile credential verification error");
			}

			console.log(`[+] Authenticated as ${valid.Arn ?? valid.arn}`);

			if (fs.existsSync(cacheFile)) {
				fs.unlinkSync(cacheFile);
			}

		} catch (e) {
			throw new Error(`Long term credentials for profile [${profile}] are invalid: ${e}`);
		}

		if (!!process.env.SPELLCRAFT_ASSUMEROLE) {
			valid = await processRoleChain();
		}

		return valid;
	}

	if (!!creds.role_arn && !!creds.source_profile) {
		aws.config.update({
			credentials: {
				accessKeyId: credfile[creds.source_profile].aws_access_key_id,
				secretAccessKey: credfile[creds.source_profile].aws_secret_access_key
			}
		});

		const parameters = {
			RoleArn: creds.role_arn,
			RoleSessionName: `spellcraft_assumerole_${Date.now()}`,
			DurationSeconds: creds.duration_seconds || 3600
		}

		if (!!creds.mfa_serial) {
			parameters.SerialNumber = creds.mfa_serial;
			parameters.TokenCode = await getMFAToken(creds.mfa_serial);
		}

		try {
			const sts = new aws.STS();
			const role = await sts.assumeRole(parameters).promise();

			aws.config.update({
				credentials: sts.credentialsFrom(role)
			});

			let valid = await verifyCredentials();

			if (!valid) {
				throw new Error("AWS assumerole credential verification error");
			}

			console.log(`[+] Successfully assumed role [${creds.role_arn}]`);

			fs.writeFileSync(cacheFile, JSON.stringify({
				accessKeyId: aws.config.credentials.accessKeyId,
				secretAccessKey: aws.config.credentials.secretAccessKey,
				sessionToken: aws.config.credentials.sessionToken,
				expireTime: new Date(aws.config.credentials.expireTime).getTime(),
				expired: aws.config.credentials.expired,
				profile
			}), { mode: '600' });

			process.env.AWS_PROFILE = '';
			process.env.AWS_ACCESS_KEY_ID = aws.config.credentials.accessKeyId;
			process.env.AWS_SECRET_ACCESS_KEY = aws.config.credentials.secretAccessKey;
			process.env.AWS_SESSION_TOKEN = aws.config.credentials.sessionToken ?? '';

		} catch(e) {
			throw new Error(`[!] Failed to assume role ${creds.role_arn} via profile ${creds.source_profile}: ${e}`);
		}

		if (!!process.env.SPELLCRAFT_ASSUMEROLE) {
			valid = await processRoleChain();
		}

		return valid;
	}
}

async function processRoleChain() {
	const cacheFile = `${os.homedir()}/.aws/profile_cache.json`;

	if (!!process.env.SPELLCRAFT_ASSUMEROLE) {
		console.log(`[*] SPELLCRAFT_ASSUMEROLE is set, attempting to assume role with arn [ ${process.env.SPELLCRAFT_ASSUMEROLE} ]`);
		const parameters = {
			RoleArn: process.env.SPELLCRAFT_ASSUMEROLE,
			RoleSessionName: `spellcraft_assumerole_${Date.now()}`,
			DurationSeconds: 3600
		}

		try {
			const sts = new aws.STS();
			const role = await sts.assumeRole(parameters).promise();

			aws.config.credentials = sts.credentialsFrom(role);

			let valid = await verifyCredentials();

			if (!valid) {
				throw new Error("AWS assumerole credential verification error");
			}

			console.log(`[+] Successfully assumed role [${process.env.SPELLCRAFT_ASSUMEROLE}]`);

			fs.writeFileSync(cacheFile, JSON.stringify({
				accessKeyId: aws.config.credentials.accessKeyId,
				secretAccessKey: aws.config.credentials.secretAccessKey,
				sessionToken: aws.config.credentials.sessionToken,
				expireTime: new Date(aws.config.credentials.expireTime).getTime(),
				expired: aws.config.credentials.expired,
				profile: process.env.SPELLCRAFT_ASSUMEROLE
			}), { mode: '600' });

			process.env.AWS_PROFILE = '';
			process.env.AWS_ACCESS_KEY_ID = aws.config.credentials.accessKeyId;
			process.env.AWS_SECRET_ACCESS_KEY = aws.config.credentials.secretAccessKey;
			process.env.AWS_SESSION_TOKEN = aws.config.credentials.sessionToken ?? '';

			return valid;

		} catch(e) {
			throw new Error(`[!] Failed to assume chained role ${process.env.SPELLCRAFT_ASSUMEROLE}: [${e}]`);
		}
	}

	return true;
}

function getMFAToken(mfaSerial) {
	return new Promise((success, failure) => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout
		});

		rl.question(`Enter MFA code for ${mfaSerial}: `, function(token) {
			rl.close();

			console.log("");

			if (!token) {
				return getMFAToken(mfaSerial);
			}

			return success(token);
		});

		rl._writeToOutput = function(char) {
			if (char.charCodeAt(0) != 13) {
				rl.output.write('*');
			}
		}
	});
}

async function verifyCredentials() {
	const sts = new aws.STS();

	try {
		const caller = await sts.getCallerIdentity().promise();
		delete caller.ResponseMetadata;
		cached_caller = caller;
		return caller;
	} catch (e) {
		throw new Error(`[!] Credential validation failed with error: ${e}`);
	}
}