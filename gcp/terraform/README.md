# plugins.gcp.terraform

GCS state backend, remote state, artifacts, provider aliases and whole
organization trees for [SpellCraft](https://github.com/c6fc/spellcraft).

[![NPM version](https://img.shields.io/npm/v/@c6fc/spellcraft-plugins.svg?style=flat)](https://www.npmjs.com/package/@c6fc/spellcraft-plugins)
[![License](https://img.shields.io/npm/l/@c6fc/spellcraft-plugins.svg?style=flat)](https://opensource.org/licenses/MIT)

This is the GCP half of the Terraform story: it decides where state lives, hands
one spell the values another produced, declares the providers that region-aware
plugins bind to, and builds folder and project hierarchies from a single nested
description. `plugins.terraform` runs the apply; this tells it what to
apply against.

```bash
npm install --save @c6fc/spellcraft-plugins
```

## A complete spell

```jsonnet
local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.terraform;

{
	// State backend, and the bucket to hold it. Created on first use.
	"backend.tf.json": gcp.bootstrap("my-project"),

	// One aliased provider per region, plus an unaliased default.
	"providers.tf.json": {
		provider: gcp.providerAliases("us-west2", {}, "us-"),
	},
}
```

```bash
npx spellcraft terraform-apply manifest.jsonnet
```

## Solving stage zero

Terraform cannot enable the API that a resource it is creating depends on — the
provider needs it live before it can plan. That is normally a README step
somebody forgets on the second environment.

This plugin removes the step. As the manifest evaluates, every service the
configuration will need is registered; then it listens for
`@c6fc/spellcraft-plugins:terraform.pre-apply` and enables the whole set in one call,
before Terraform starts. The two plugins know nothing about each other — they
meet on the event.

That handshake is why `googleOrgProject()` can create projects and populate them
in a single apply.

## Organization and project trees

`googleOrgProject(name, region, map)` takes one nested description and emits the
folders, projects, service accounts, IAM bindings and API activations to build
it, with the dependency ordering already wired:

```jsonnet
local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.terraform;

{
	"org.tf.json": gcp.googleOrgProject("platform", "us-west2", {
		type: "folder",
		name: "engineering",
		children: [
			{ type: "folder", name: "production", children: [
				{ type: "project", name: "api" },
			] },
			{ type: "project", name: "sandbox" },
		],
	}),
}
```

The root's parent defaults to the organization your current project belongs to;
set `parent` on the map to place it somewhere else. `test.jsonnet` in this
package is the fully worked example, covering IAM members and per-project
services.

## The bootstrap bucket

`bootstrap(project)` returns the Terraform `backend` block and creates the
bucket behind it if needed. There is one bucket per project —
`spellcraft-terraform-<project-id>` — and `project` becomes the key prefix
separating one spell's state from another's.

`getArtifact()` and `putArtifact()` (below) both key their object off the
project name `bootstrap()` records, so either one throws if it runs before
some `bootstrap()` call has set it. Jsonnet doesn't otherwise guarantee that
order — see the warning under "Sharing values between spells" for how to make
it explicit.

### Setting the project name ahead of time

Not every spell needs its project name computed at render time. If it's
known ahead of time, set it in `package.json`:

```json
{
	"config": {
		"spellcraftProject": "my-project"
	}
}
```

That is read during `init()`, before any Jsonnet evaluation starts, and it
only sets the name — a file read, no network. It removes the ordering hazard
for artifacts: `getArtifact()`/`putArtifact()` have a namespace to key off
without anything being threaded through them first.

It does **not** replace `bootstrap()`. Creating the state bucket and returning
the `backend` block is still that call's job, so a spell that needs a backend
still makes it — it just no longer has to be the thing that learns the name.
Calling it with a name that disagrees with the configured one throws, naming
which source set the other; the same name is a no-op.

It also sidesteps a subtler hazard: `bootstrap()`'s state lives in a
module-level object shared by every `SpellFrame` in the process, so two renders
for two different projects running concurrently (embedding `SpellFrame` as a
library, rather than one process per `spellcraft` CLI invocation) could
otherwise cross-contaminate. A config-driven project name is the same for every
render in that process, so there is nothing left to race on.

## Sharing values between spells

Both resolve while the manifest evaluates, so a value can *shape* the
configuration rather than only appear in it. `getArtifact()`/`putArtifact()`
use *this* spell's own project — the one passed to `bootstrap()` — so
`bootstrap()` has to run first:

```jsonnet
local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.terraform;

local network = gcp.getRemoteState("network");

local backend = gcp.bootstrap("my-project");

{
	"backend.tf.json": backend,
	"meta.json": { ok: if backend != null then gcp.putArtifact("build", { image: "app:1.4.2" }) else null },
}
```

```jsonnet
local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.terraform;

local build = gcp.getArtifact("build");

{ "image.json": { image: build.image } }
```

Jsonnet evaluates lazily and in no guaranteed field order, so merely calling
`bootstrap()` somewhere in the manifest doesn't make it run before
`putArtifact()`/`getArtifact()` elsewhere in the same manifest — the call that
needs it has to *depend on* the result, as `if backend != null then ...` does
above, not merely follow it. Get this wrong and `putArtifact()`/`getArtifact()`
throw naming the fix, rather than silently writing to
`spellcraft/null/artifacts/<name>.json`.

## Provider aliases

`providerAliases(default, options, filter)` emits an aliased `google` provider
per Compute region, with the alias set to the region name, plus an unaliased
default. `options` is merged into every declaration — a shared `project` or
`billing_project` goes there — and `filter` keeps only regions whose name
contains it, which is how you avoid declaring forty providers to use two.

## Reaching the credential helpers

This node has no `auth` passthrough — it was removed once every node shipped in
one package, because the root import already reaches `plugins.gcp.auth` directly
and a second path to the same object was only somewhere for the two to disagree:

```jsonnet
local plugins = import "@c6fc/spellcraft-plugins/module.libsonnet";

{ "org.json": { domain: plugins.gcp.auth.getProjectMetadata().organizationDomain } }
```

## Addressing what a tree built: `refs`

`googleOrgProject()` returns a hidden `refs` map alongside the Terraform it
manifests, so a spell can reference any resource in the tree without
reconstructing the naming scheme. Keys are `"<type>.<your own name path>"` —
the names you wrote, not the normalized-and-hashed ones Terraform sees — and
`_terraform_id` carries the address:

```jsonnet
local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.terraform;

local org = gcp.googleOrgProject("platform", "us-west2", {
	type: "folder",
	name: "engineering",
	children: [{ type: "project", name: "api", services: ["compute.googleapis.com"] }],
});

{
	"org.tf.json": org,
	"extra.tf.json": {
		output: {
			// The project's real id, read from what was actually built.
			api_project: { value: org.refs["google_project.engineering.api"].project_id },
			// Or build your own reference from the address.
			api_number: { value: "${%s.number}" % org.refs["google_project.engineering.api"]._terraform_id },
		},
	},
}
```

Where one node produced several resources of a type, the entry stays at the node
and its value holds them, keyed by whatever you named them:

| entry | keyed by |
|---|---|
| `google_project_service.<path>` | the service name, e.g. `"compute.googleapis.com"` |
| `google_service_account.<path>` | the service account's map key |
| `google_project_iam_custom_role.<path>` | the role name |
| `google_{project,folder}_iam_audit_config.<path>` | the audited service |
| `google_org_policy_policy.<path>` | the constraint's `name` |

IAM members are the exception, because Terraform names them from a hash of their
own content and you never supplied a name for them. Their entry is keyed by the
**option that produced it** — the one place this plugin invents vocabulary
rather than mirroring what you wrote:

```jsonnet
local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.terraform;

local org = gcp.googleOrgProject("platform", "us-west2", {
	type: "project",
	name: "api",
	iam_members: [{ role: "roles/viewer", members: ["user:a@b.c"] }],
});

{
	"members.json": {
		// An array, in the order you gave the option.
		first: org.refs["google_project_iam_member.api"].iam_members[0]._terraform_id,
	},
}
```

A resource that was not built has no entry, so guard with `std.objectHas` if the
tree is shaped by configuration. `refs` is hidden, so it never reaches a rendered
file. The convention is documented in full in `refs-pattern.md` at the repository
root.

<!-- SPELLCRAFT_DOCS_API_START -->
## API Reference

### `bootstrap(project)`

Prepares the GCS backend for a spell, creating the bootstrap bucket if it
does not exist yet, and returns the Terraform `backend` block for it.

This is the one function here that writes: it creates the bucket on first
use. State and artifacts for every spell live in that bucket, keyed by the
name you pass.

`getArtifact()` and `putArtifact()` key their object off the project name
this sets, so either one throws if it runs before this has. Jsonnet does
not guarantee that order on its own -- thread this function's result into
whatever calls them, rather than merely calling both in the same manifest.

Setting `config.spellcraftProject` in `package.json` supplies the project
name ahead of evaluation -- a file read during `init()`, no network -- so
`getArtifact()`/`putArtifact()` have a namespace to key off even before
this call is forced. It does not replace this call: creating the bucket
and returning the backend block is still this function's job. Calling it
with a name that disagrees with the configured one throws, naming both
sources; the same name is a no-op.

A spell has one project. Calling this again with a *different* name in
the same process throws for the same reason -- to read another spell's
state, use `getRemoteState()`, not a second `bootstrap()` call. The
same name twice is a no-op.

- param {string} project - names the state prefix; use one per spell
- returns {object} a Terraform block ready to merge into a `.tf.json` file

**Examples:**

```jsonnet
local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.terraform;

{ "backend.tf.json": gcp.bootstrap("my-project") }

// Returns a terraform.backend.gcs block pointing at the bootstrap bucket,
// prefixed with the project name you passed.
```

---
### `getArtifact(name)`

Reads an artifact previously stored by `putArtifact()`.

Artifacts are how one spell hands a value to another without a Terraform
data source — the value is fetched while the manifest evaluates, so it can
shape the configuration rather than only appear in it.

Throws if `bootstrap()` hasn't set a project name yet -- see `bootstrap()`
for why that ordering isn't automatic.

- param {string} name - the artifact name given to `putArtifact()`
- returns {*} the stored value, parsed back from JSON

**Examples:**

```jsonnet
local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.terraform;

local backend = gcp.bootstrap("my-project");
local shared = if backend != null then gcp.getArtifact("network") else null;

{ "app.tf.json": { output: { subnet: { value: shared.subnet } } } }
```

---
### `getBootstrapBucket()`

The name of the bootstrap bucket for the current project.

- returns {string} the bucket name, `spellcraft-terraform-<project-id>`

**Examples:**

```jsonnet
local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.terraform;

{ "state.json": { bucket: gcp.getBootstrapBucket() } }
```

---
### `getRemoteState(project)`

Reads the Terraform state of another SpellCraft spell in the same GCP
project. Use it to consume another spell's outputs at evaluation time; the
name is the one passed to that spell's `bootstrap()`.

Outputs are flattened to their values, so an output named `subnet` is
`state.outputs.subnet` — there is no `.value` to unwrap. Resources are
keyed by type and name, with `data` sources under `state.data`.

- param {string} project - the other spell's project name
- returns {object} that spell's Terraform state

**Examples:**

```jsonnet
local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.terraform;

local network = gcp.getRemoteState("network");

{ "app.tf.json": { output: { subnet: { value: network.outputs.subnet } } } }
```

---
### `googleOrgProject(name, region, map)`

Builds a whole folder and project tree from one nested description.

Each node is a `{ type: "folder" | "project", name, children }`, and may
carry `iam_members`, `services` and the other per-node settings the tree
understands. The root's parent defaults to the organization the current
project belongs to; set `parent` on the map to place it elsewhere.

Alongside the resources it emits the dependency wiring that makes creation
order correct, and registers the services each project needs so they are
enabled before `terraform apply` runs.

`test.jsonnet` in this package is the fully worked example.

- param {string} name - prefix for the generated Terraform resource names
- param {string} region - region for the providers the tree exposes
- param {object} map - the root node of the folder/project tree
- returns {object} Terraform `resource` and `output` blocks

**Examples:**

```jsonnet
local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.terraform;

{ "org.tf.json": gcp.googleOrgProject("platform", "us-west2", {
    type: "folder",
    name: "engineering",
    children: [{ type: "project", name: "sandbox" }],
  }) }
```

---
### `putArtifact(name, content)`

Stores a value as a JSON artifact in the bootstrap bucket, under this
project's prefix. Read it back with `getArtifact()`.

Throws if `bootstrap()` hasn't set a project name yet -- see `bootstrap()`
for why that ordering isn't automatic.

- param {string} name - the artifact name
- param {*} content - any JSON-serialisable value
- returns {boolean} true

**Examples:**

```jsonnet
local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.terraform;

local backend = gcp.bootstrap("my-project");

{
    "backend.tf.json": backend,
    "meta.json": { stored: if backend != null then gcp.putArtifact("myArtifact", { someData: "a value" }) else null },
}
```

---
### `providerAliases(default, options, filter="")`

Builds the full set of Google provider declarations for a spell.

Returns one aliased provider per Compute region — the alias is the region
name, so resources bind to it as `google.us-west2` — plus an unaliased
default for the region you name. `options` is merged into every provider,
which is where a shared `project` or `billing_project` belongs. Pass a
`filter` to keep only regions whose name contains it.

The region list comes from a live `compute.v1.regions.list` call.

- param {string} default - region for the unaliased default provider
- param {object} options - merged into every provider declaration
- param {string} [filter=""] - substring the region name must contain
- returns {object[]} provider declarations, for the `provider` key of a `.tf.json`

**Examples:**

```jsonnet
local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.terraform;

gcp.providerAliases("us-west2", {}, "us-")

// Returns:
// [
//   { "google": { "alias": "us-east1", "region": "us-east1" } },
//   { "google": { "alias": "us-west2", "region": "us-west2" } },
//   ...
//   { "google": { "region": "us-west2" } }
// ]
```

---

<!-- SPELLCRAFT_DOCS_API_END -->

## Development

```bash
npm test        # renders test.jsonnet through a real SpellFrame
npm run doc     # regenerates the API section above from module.libsonnet
```

`npm test` **writes**: it creates the bootstrap bucket if the project has none,
stores an artifact, and enables APIs on the active project.

## License

MIT © [Brad Woodward](https://github.com/c6fc)
