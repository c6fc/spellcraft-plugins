'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// require('googleapis') costs ~840ms and unpacks 196MB of generated clients.
// Every node in this package now ships together, so an eager require here would
// be paid by an AWS-only spell -- and by `spellcraft --help` -- for nothing.
// This proxy defers it to first property access and then behaves exactly like
// the module, so every `google.oauth2(...)` / `google.options(...)` call site
// below, and every consumer reading `functionContext.google`, is unchanged.
let googleapis = null;
const google = new Proxy({}, {
    get: (_, key) => (googleapis ??= require('googleapis').google)[key],
    set: (_, key, value) => (((googleapis ??= require('googleapis').google)[key] = value), true),
});

// google-auth-library is only reached through `new`, so it gets a plain lazy
// accessor rather than a proxy -- a proxy of a module namespace is not itself
// constructible.
let authlib = null;
const gal = () => (authlib ??= require('google-auth-library'));

const SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

let auth = null;
let projectId = null;
let client = null;

// Set by the first successful setGcpCredentials() in this process. init()
// runs once per SpellFrame -- not once per process -- so a long-lived process
// constructing several frames calls this more than once even under normal
// use. Every call after the first must resolve to the exact same identity or
// it throws, rather than silently replacing the credentials (and the
// googleapis library's own global auth config) that whatever else is running
// in this process is depending on. SpellCraft permits exactly one
// authentication context per process; a spell needing a different GCP
// *project* under the same identity should use providerAliases(), not a
// second, different identity -- and a genuinely different identity needs a
// separate process.
let lockedIdentity = null;

function identityFingerprint(resolvedProjectId) {
    return {
        projectId: resolvedProjectId,
        impersonate: process.env.SPELLFRAME_GCP_IMPERSONATE || null
    };
}

function describeIdentity({ projectId, impersonate }) {
    return `project=${projectId}` + (impersonate ? `, impersonating ${impersonate}` : '');
}

// Application Default Credentials frequently carry no project, even when gcloud
// itself has one configured -- and google-auth-library throws from getClient()
// rather than returning a usable client without one. Resolving the project here
// keeps the ordinary local setup working with no extra environment variable,
// and lets failure name the specific fixes instead of surfacing a raw
// googleapis stack trace.
function resolveProjectId() {
    if (process.env.GOOGLE_CLOUD_PROJECT) return process.env.GOOGLE_CLOUD_PROJECT;
    if (process.env.GCLOUD_PROJECT) return process.env.GCLOUD_PROJECT;

    const adcPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
        || path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');

    try {
        const adc = JSON.parse(fs.readFileSync(adcPath, 'utf-8'));

        if (adc.quota_project_id) return adc.quota_project_id;
        if (adc.project_id) return adc.project_id;
    } catch (e) { }

    try {
        const configured = execFileSync('gcloud', ['config', 'get-value', 'project'], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();

        if (configured && configured !== '(unset)') return configured;
    } catch (e) { }

    return null;
}

// Credentials resolve once, on first use, rather than from an init() hook.
// Core runs every loaded plugin's init() unconditionally, and setGcpCredentials()
// *throws* when no project is bound -- so resolving at init time would make an
// AWS-only spell fail on GCP on every render. Memoized on the promise, so
// concurrent natives share one resolution rather than racing.
let authPromise = null;
const ensureAuth = () => (authPromise ??= setGcpCredentials());

// Reachable by sibling nodes, never registered as a native: the aggregator in
// ../../index.js skips every export key beginning with an underscore.
exports._internal = { ensureAuth, verifyCredentials, enableServices };

exports._spellcraft_metadata = {
	functionContext: { google },

	// Extend the SpellCraft `yargs` to include whatever custom interactions with `spellframe` you want.
	cliExtensions: (yargs, spellframe) => {
		yargs
		// No spellframe.init(): core's init() is all-or-nothing across every
		// loaded plugin, and ensureAuth() is this node's own initialization. See
		// the same note in aws/auth.
		.command("gcp-identity", "Display the GCP identity of the SpellCraft execution context", (yargs) => yargs, async (argv) => {

			await ensureAuth();
			console.log(await verifyCredentials());

		});

		console.log(`[+] Imported SpellFrame CLI extensions for @c6fc/spellcraft-plugins:gcp.auth`);
	}

	// No init hook. See ensureAuth() above.
};

async function verifyCredentials() {
    try {
        // Initialize the OAuth2 client
        const oauth2 = google.oauth2({ version: 'v2', auth: client });
        
        // This endpoint verifies the current token and returns details about the holder
        const res = await oauth2.tokeninfo();
        const data = res.data;

        return {
            identity: data.email || process.env.SPELLFRAME_GCP_IMPERSONATE,
            projectId,
            scopes: data.scope.split(' '),
            expiresIn: data.expires_in,
            // Determine type based on properties or envvars
            authType: process.env.SPELLFRAME_GCP_IMPERSONATE ? 'Impersonated Service Account' :
                      (data?.email?.endsWith('.gserviceaccount.com') ? 'Service Account' : 'User/Authorized Account'),
            impersonatedBy: process.env.SPELLFRAME_GCP_IMPERSONATE ? 'Local ADC/Key' : null
        };
    } catch (e) {
        throw new Error(`Failed to verify GCP credentials: ${e.message}`);
    }
}

exports.getCallerIdentity = [async () => {
    await ensureAuth();
    return verifyCredentials();
}];

exports.getProjectMetadata = [async () => {
    await ensureAuth();
    return getProjectMetadata();
}];

exports.enableServices = [async function(services) {
    await ensureAuth();
    return await enableServices(JSON.parse(services))
}, "services"];

async function setGcpCredentials() {
	const resolvedProjectId = resolveProjectId();

	if (!resolvedProjectId) {
		throw new Error(
			`[SpellCraft] No GCP project is bound to the current credentials.\n` +
			`    Bind one with any of:\n` +
			`      export GOOGLE_CLOUD_PROJECT=<project-id>\n` +
			`      gcloud config set project <project-id>\n` +
			`      gcloud auth application-default set-quota-project <project-id>`
		);
	}

	const requested = identityFingerprint(resolvedProjectId);

	if (lockedIdentity) {
		if (requested.projectId === lockedIdentity.projectId && requested.impersonate === lockedIdentity.impersonate) {
			// Same identity as what's already active -- credentials are
			// already configured for it, nothing to redo.
			return;
		}

		throw new Error(
			`[SpellCraft] This process already authenticated as a different GCP identity:\n` +
			`    active:    ${describeIdentity(lockedIdentity)}\n` +
			`    requested: ${describeIdentity(requested)}\n` +
			`SpellCraft permits exactly one authentication context per process. For a different ` +
			`GCP project under the same identity, use providerAliases() instead of re-authenticating; ` +
			`a genuinely different identity needs a separate process.`
		);
	}

	projectId = resolvedProjectId;
	auth = new (gal().GoogleAuth)({ projectId, scopes: SCOPES });

	const initialClient = await auth.getClient();

    // If this envvar is set, we wrap the credentials to act as another identity
    const targetAccount = process.env.SPELLFRAME_GCP_IMPERSONATE;

    if (targetAccount) {
        console.log(`[+] Impersonating GCP Service Account: ${targetAccount}`);
        client = new (gal().Impersonated)({
            sourceClient: initialClient,
            targetPrincipal: targetAccount,
            lifetime: 3600,
            delegates: [],
            targetScopes: ['https://www.googleapis.com/auth/cloud-platform']
        });
    } else {
        client = initialClient;
    }

    google.options({ auth: client });

    // Locked only now that credentials actually resolved -- a failed first
    // attempt (bad ADC, no permissions) must not permanently poison the
    // identity a retry would otherwise correctly resolve.
    lockedIdentity = requested;
};

// Confirmed-enabled services, process-wide. enableServices() is called from
// several independent places with no shared knowledge of each other --
// getProjectMetadata()'s own fixed need, api()'s best-effort auto-enable
// (below), a manifest's own explicit call -- so without this, the same
// service gets a fresh live .get() check, and its own console output, from
// every single caller. A service, once confirmed, stays enabled for the life
// of the process; nothing disables one out from under a running SpellFrame.
const confirmedEnabled = new Set();

async function enableServices(services) {
    const pending = services.filter(s => !confirmedEnabled.has(s));

    if (pending.length === 0) return true;

    const serviceusage = google.serviceusage('v1');
    const parent = `projects/${projectId}`;

    // console.log(`[+] Checking/Enabling APIs for: ${projectId}`);

    const enablementPromises = pending.map(async (serviceName) => {
        const resourceName = `${parent}/services/${serviceName}`;

        // console.log(resourceName);

        try {
            // 1. Check current state (Get)
            const { data: service } = await serviceusage.services.get({ name: resourceName });

            if (service.state === 'ENABLED') {
                // console.log(` ✅ Already Active: ${serviceName}`);
                return null;
            }

            // 2. If not enabled, trigger enablement (Enable)
            console.log(`[*] Activating ${serviceName}...`);
            const { data: operation } = await serviceusage.services.enable({ name: resourceName });

            // 3. Poll the Operation (LRO) until done
            let opName = operation.name;
            let isDone = false;

            while (!isDone) {
                // Wait 2 seconds between polls
                await new Promise(resolve => setTimeout(resolve, 2000));

                const { data: currentOp } = await serviceusage.operations.get({ name: opName });

                if (currentOp.done) {
                    if (currentOp.error) {
                        throw new Error(`Failed to enable ${serviceName}: ${currentOp.error.message}`);
                    }
                    isDone = true;
                    console.log(`[+] Enabled ${serviceName}`);
                }
            }

            // Report back that this one was newly activated, so the caller
            // knows whether it needs to wait for propagation.
            return serviceName;
        } catch (err) {
            console.error(`[!] Error with ${serviceName}: ${err.message}`);
            throw err;
        }
    });

    // Services that were already enabled resolve to null; only newly
    // activated ones come back named.
    const activated = (await Promise.all(enablementPromises)).filter(s => s !== null);

    if (activated.length > 0) {
        console.log(`[+] Services enabled. Waiting 15s for IAM/Quota propagation...`);
        await new Promise(resolve => setTimeout(resolve, 15000));
    } else {
        console.log(`[*] Requested GCP services were already enabled: [${pending.join(', ')}]`);
    }

    // Only reached on full success -- a thrown enable error above skips this,
    // so a failure is never cached as confirmed.
    pending.forEach(s => confirmedEnabled.add(s));

    return true
}

async function getProjectMetadata() {

    await enableServices(["cloudbilling.googleapis.com"]);

    // Initialize API clients
    const resourcemanager = google.cloudresourcemanager('v3');
    const billing = google.cloudbilling('v1');

    try {
    // 1. Get the Project details to find the immediate parent
    const projectResponse = await resourcemanager.projects.get({
        name: `projects/${projectId}`
    });

    let projectData = projectResponse.data;
    let orgId = false;
    let currentParent = projectData.parent;

    // 2. Traverse the Hierarchy to find the Organization ID
    // A parent can be 'folders/123' or 'organizations/456'
    while (currentParent) {
        if (currentParent.startsWith('organizations/')) {
            orgId = currentParent.split('/')[1];
            break;
        } else if (currentParent.startsWith('folders/')) {
            // If parent is a folder, look up that folder to see its parent
            const folderResponse = await resourcemanager.folders.get({
                name: currentParent
            });
            currentParent = folderResponse.data.parent;
        } else {
            // No organization found (e.g., project lives outside an Org)
            break;
        }
    }

    // 3. Get Billing Account Info
    const billingResponse = await billing.projects.getBillingInfo({
        name: `projects/${projectId}`
    });

    // 4. Get organization domain name
    const orgDetails = await resourcemanager.organizations.get({ name: `organizations/${orgId}` });

    return {
        projectId: projectId,
        organizationId: orgId,
        organizationDomain: orgDetails?.data?.displayName || false,
        directoryId: orgDetails?.data?.directoryCustomerId,
        // billingAccountName is usually in the format "billingAccounts/0X0X0X-0X0X0X-0X0X0X"
        billingAccount: billingResponse.data?.billingAccountName?.split('/')?.[1] || false,
        // In GCP, the 'Quota Project' is technically the project context 
        // used for the API call, which in this case is the project itself.
        quotaProject: projectId
    };

    } catch (error) {
        console.error(`[!] Error fetching metadata for project ${projectId}:`, error.message);
        throw error;
    }
}

exports.api = [async (fullPath, paramsJson) => {
    await ensureAuth();

    const parts = fullPath.split('.');
    if (parts.length < 2) {
        throw new Error(`Invalid GCP path: ${fullPath}. Expected format: service.version.path`);
    }

    const [serviceName, version, ...remainingPath] = parts;
    const params = JSON.parse(paramsJson);

    // Initialize the specific API and version
    if (!google[serviceName]) {
        throw new Error(`GCP Service "${serviceName}" not found in googleapis library.`);
    }

    // Best-effort: enable the service this call almost certainly needs,
    // before making it -- the same way getProjectMetadata() already does for
    // its own fixed dependency -- so a manifest can call api() (and
    // listInstances()/listBuckets(), which are built on it) with no separate
    // enableServices() call of its own. "<serviceName>.googleapis.com"
    // matches Google's own naming convention for the overwhelming majority of
    // services, but it isn't guaranteed, so a wrong or nonexistent derivation
    // must never block the real call -- only speed up the common case.
    // enableServices()'s own cache makes every call after the first for a
    // given service free.
    try {
        await enableServices([`${serviceName}.googleapis.com`]);
    } catch (e) {
        console.warn(`[!] Could not confirm ${serviceName}.googleapis.com is enabled (${e.message}); continuing anyway.`);
    }

    // Pass the module-level client explicitly. `this.client` does not work here:
    // the enclosing arrow function has no SpellCraft function context, so `this`
    // carries nothing, and the call would fall through to whatever global default
    // google.options() last set in setGcpCredentials().
    const api = google[serviceName]({ version, auth: client });

    // Traverse the remaining path
    let current = api;
    let parent = api;

    for (const segment of remainingPath) {
        parent = current;
        current = current[segment];
        
        if (current === undefined || current === null) {
            throw new Error(`Path segment "${segment}" not found in "${fullPath}"`);
        }
    }

    // Check if the resolved path is a function or a property
    if (typeof current === 'function') {
        // Call the function, ensuring 'this' is bound to the parent object
        const res = await current.call(parent, params);
        // Google API responses usually wrap data in a 'data' property
        return res.data || res;
    } else {
        // Return the property/object directly
        // return current;
        throw new Error(`"${fullPath}" is not a function.`);
    }
}, "fullPath", "paramsJson"];

exports.getProjectId = [async () => {
    await ensureAuth();
    return projectId;
}];