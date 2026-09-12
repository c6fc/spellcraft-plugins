# plugins.gcp.auth

GCP credentials and the googleapis client for
[SpellCraft](https://github.com/c6fc/spellcraft), reachable directly from Jsonnet.

[![NPM version](https://img.shields.io/npm/v/@c6fc/spellcraft-plugins.svg?style=flat)](https://www.npmjs.com/package/@c6fc/spellcraft-plugins)
[![License](https://img.shields.io/npm/l/@c6fc/spellcraft-plugins.svg?style=flat)](https://opensource.org/licenses/MIT)

This is what lets a manifest ask GCP a question while it renders — which project
it is bound to, which organization that project sits under, which services are
live — instead of being handed an answer someone pasted in.

```bash
npm install --save @c6fc/spellcraft-plugins
```

```jsonnet
local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.auth;

{
	"project.json": gcp.getProjectMetadata(),
}
```

## Credentials and the bound project

Authentication uses Application Default Credentials — `gcloud auth
application-default login`, a service account key, or the ambient credentials of
whatever you're running on.

The project is resolved separately, in this order:

1. `GOOGLE_CLOUD_PROJECT`
2. `GCLOUD_PROJECT`
3. the quota project recorded in your ADC file
4. `gcloud config get-value project`

ADC frequently carries no project even when gcloud has one configured, which is
why gcloud's own setting is consulted last rather than not at all. If none of the
four yields a project, the render stops and names all four fixes.

```console
$ npx spellcraft gcp-identity
{
    "identity": "you@example.com",
    "projectId": "my-project-1234",
    "authType": "User/Authorized Account",
    ...
}
```

### Impersonation

Set `SPELLFRAME_GCP_IMPERSONATE` to a service account address and the plugin
wraps the resolved credentials to act as it, for the whole render.

```bash
export SPELLFRAME_GCP_IMPERSONATE="deployer@my-project-1234.iam.gserviceaccount.com"
```

### One identity per process

A process authenticates as exactly one GCP identity, ever. The first
successful resolution locks it in (project id plus impersonation target, if
any); any later attempt — a second `SpellFrame`, or the same environment
resolving differently on a second call — that would authenticate as a
*different* identity throws, rather than silently replacing the credentials
everything else in the process is depending on. The same identity resolving
again is a no-op, not an error.

This isn't a technical ceiling so much as a deliberate one: a spell needing a
different GCP *project* under the same identity should reach for
`providerAliases()` (the same mechanism that already covers multiple
regions), not re-authenticate. A genuinely different identity needs a
separate process — which, for credentials, is the stronger isolation
boundary anyway.

## Enabling services during a render

Terraform cannot enable the API that a resource it is creating depends on — the
provider needs it live before it can plan. `enableServices()` closes that gap by
turning services on while the manifest evaluates.

You mostly won't call it directly. `api()`, and `listBuckets()`/`listInstances()`
built on it, enable their own service internally before making their call:

```jsonnet
local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.auth;

{ "instances.json": gcp.listInstances({ project: gcp.getProjectId(), zone: "us-west1-b" }) }
```

No `enableServices()` call, no threading a return value through — this works
with nothing else in the manifest. Every one of these calls, from every
function, checks a process-wide cache first, so the same service being needed
by ten different calls costs one real check, not ten.

The one real cost, and it's a property of the underlying GCP API rather than
of this plugin: activating a service that's never been enabled before waits
~15 seconds for IAM/quota propagation, once per call that activates something
new. A manifest touching many different never-before-enabled services across
many separate calls pays that wait once per service rather than once overall
— noticeable on a cold first run against a project, free on every run after,
since confirmed services stay confirmed for the life of the process.

For a native function that *doesn't* self-enable this way — a different
plugin's, or a hand-written one — call `enableServices()` yourself first, and
thread the result through, since Jsonnet's evaluation order guarantees
nothing here:

```jsonnet
local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.auth;

// Threading `ready` into the call is what forces the ordering -- Jsonnet will
// not run enableServices() first just because it is written first.
local ready = gcp.enableServices(["compute.googleapis.com"]);

{
	"instances.json":
		if ready
		then gcp.listInstances({ project: gcp.getProjectId(), zone: "us-west1-b" })
		else null,
}
```

For services needed at apply time rather than render time,
[`plugins.gcp.terraform`](../terraform) collects them during evaluation and
flushes them on `@c6fc/spellcraft-plugins:terraform.pre-apply`, so the bootstrap
orders itself.

## Calling any API

`api()` reaches the whole of googleapis by dot-delimited path — service,
version, method:

```jsonnet
local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.auth;

{
	"projects.json": gcp.api("cloudresourcemanager.v1.projects.list", {}),
	"buckets.json": gcp.api("storage.v1.buckets.list", { project: gcp.getProjectId() }),
}
```

`listBuckets()` and `listInstances()` are shorthands over it. All three default
`params` to `{ project: getProjectId() }`, and supplying your own params replaces
that default — so pass `project` alongside anything else the method needs.

<!-- SPELLCRAFT_DOCS_CLI_START -->
## CLI Commands

- **`spellcraft gcp-identity`**
  Display the GCP identity of the SpellCraft execution context

<!-- SPELLCRAFT_DOCS_CLI_END -->

## What it contributes to a SpellFrame

- **No `init()` hook.** The project, the auth client, impersonation and the
  googleapis default are all resolved on the first native call that needs them,
  memoised for the rest of the process. This is deliberate: SpellCraft runs
  *every* loaded plugin's `init()` whether or not a spell uses that plugin, and
  this node raises when no project is bound — so resolving there would fail every
  render in an AWS-only spell.
- **`functionContext.google`** — the authenticated `googleapis` module, available
  as `this.google` inside any plugin's native functions. This is the seam
  `plugins.gcp.terraform` uses to reuse these credentials rather than
  authenticating again. The 196MB `googleapis` module is loaded lazily behind
  that reference, so reading it costs nothing until you use it.
- **One CLI command**, `gcp-identity`, which forces authentication itself since
  it no longer gets it from `init()`.

<!-- SPELLCRAFT_DOCS_API_START -->
## API Reference

### `getProjectId()`

The project this render is bound to.

Resolved on the first call that needs credentials, from
`GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`, the ADC file's quota project, then
gcloud's configured project — so it costs no API call, and a spell that
never touches GCP never resolves it at all.

- returns {string} the project id

**Examples:**

```jsonnet
local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.auth;

{ "project.json": { id: gcp.getProjectId() } }
```

---
### `getProjectMetadata()`

The project's place in the resource hierarchy, and how it is billed.

Enables `cloudbilling.googleapis.com` on the project if it isn't already, so
that the billing account can be read back.

- returns {object} `{ projectId, quotaProject, organizationId, organizationDomain, directoryId, billingAccount }` — the organization and billing fields are false when the project has none

**Examples:**

```jsonnet
local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.auth;

{ "billing.json": gcp.getProjectMetadata() }
```

---
### `getCallerIdentity()`

The identity this render is authenticated as.

- returns {object} `{ identity, projectId, scopes, expiresIn, authType, impersonatedBy }`

**Examples:**

```jsonnet
local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.auth;

{ "identity.json": gcp.getCallerIdentity() }
```

---
### `enableServices(services)`

Enables API services during the render, so they are live before any tool
runs. This is the answer to the stage-zero problem: Terraform cannot enable
the API that a resource it is creating depends on.

`api()`, `listBuckets()` and `listInstances()` already call this
internally for their own service, so you don't need to call it yourself
before using them. Reach for this directly when a manifest calls a native
function from elsewhere -- a different plugin, or a hand-written one --
that doesn't self-enable the way this plugin's own functions do. In that
case, Jsonnet evaluates lazily and in no guaranteed field order, so the
call that needs the service enabled must *depend on* the result rather
than merely follow it -- thread the return value through:

```
local ready = gcp.enableServices(["compute.googleapis.com"]);
{ "instances.json": if ready then someOtherPlugin.rawThing() else null }
```

Already-enabled services are left alone, and confirmed ones are cached
for the life of the process, so calling this -- from as many places as
you like, including indirectly through `api()` -- is cheap and safe to
repeat. The one cost worth knowing: activating a service that's never
been enabled before waits ~15s for IAM/quota propagation, once per call
that activates something new -- so many separate calls each activating
one new service pay that wait separately, rather than once. This only
ever affects the first time a given process touches a given service.

- param {string[]} services - fully qualified service names
- returns {boolean} true once every requested service is enabled

**Examples:**

```jsonnet
local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.auth;

{ "instances.json": gcp.listInstances({
    project: gcp.getProjectId(),
    zone: "us-west1-b",
  }) }
```

---
### `api(fullpath, params={ project: gcp.getProjectId() })`

Calls any googleapis method and returns its response.

The path is dot-delimited: service, version, then the method path — so
`compute.v1.instances.list` or `storage.v1.buckets.list`.

Enables `<service>.googleapis.com` first, best-effort -- that matches
Google's own naming convention for the overwhelming majority of services,
so most calls need nothing else. It isn't guaranteed for every service,
but a wrong or nonexistent guess never blocks the call itself, and a
correct one is free after the first time (see `enableServices()`). Call
`enableServices()` yourself first for anything this guess doesn't cover.

Passing `params` replaces the default entirely, so add `project` back when
the method needs it alongside anything else you supply.

- param {string} fullpath - `<service>.<version>.<...method>`
- param {object} [params={ project: gcp.getProjectId() }] - request parameters
- returns {object} the API response body

**Examples:**

```jsonnet
local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.auth;

{ "projects.json": gcp.api("cloudresourcemanager.v1.projects.list", {}) }
```

---
### `listBuckets(params={ project: gcp.getProjectId() })`

Cloud Storage buckets in the project.

- param {object} [params={ project: gcp.getProjectId() }] - request parameters
- returns {object} a `storage#buckets` response

**Examples:**

```jsonnet
local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.auth;

{ "buckets.json": gcp.listBuckets() }
```

---
### `listInstances(params={ project: gcp.getProjectId() })`

Compute instances in one zone.

A zone is required, and supplying it replaces the default params — so pass
`project` as well. Enables `compute.googleapis.com` itself, via `api()` --
nothing to enable yourself first.

- param {object} [params={ project: gcp.getProjectId() }] - must include `zone`
- returns {object} a `compute#instanceList` response

**Examples:**

```jsonnet
local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.auth;

{ "instances.json": gcp.listInstances({
    project: gcp.getProjectId(),
    zone: "us-west1-b",
  }) }
```

---

<!-- SPELLCRAFT_DOCS_API_END -->

## Development

```bash
npm test        # renders test.jsonnet through a real SpellFrame
npm run cli     # exercises this plugin's CLI commands
npm run doc     # regenerates the two sections above from source comments
```

`npm test` needs GCP credentials and a bound project. It **writes** in one
respect: `getProjectMetadata()` enables `cloudbilling.googleapis.com` so the
billing account can be read, and the fixture enables `compute.googleapis.com`.

## License

MIT © [Brad Woodward](https://github.com/c6fc)
