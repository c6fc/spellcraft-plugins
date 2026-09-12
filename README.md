# @c6fc/spellcraft-plugins

The SpellCraft plugin collection — AWS and GCP credentials, the Terraform
lifecycle, state backends, and resource factories — as one package and one
nested Jsonnet namespace.

[![NPM version](https://img.shields.io/npm/v/@c6fc/spellcraft-plugins.svg?style=flat)](https://www.npmjs.com/package/@c6fc/spellcraft-plugins)
[![License](https://img.shields.io/npm/l/@c6fc/spellcraft-plugins.svg?style=flat)](https://opensource.org/licenses/MIT)

```bash
npm install --save @c6fc/spellcraft-plugins
```

This pulls in `@c6fc/spellcraft`, which compiles Jsonnet from source, so the
install needs Node 18 or newer **and a C++ toolchain** — `build-essential` and
`cmake` on Debian or Ubuntu. A wall of `node-gyp` output during install is
almost always that.

```jsonnet
local plugins = import '@c6fc/spellcraft-plugins/module.libsonnet';

local account = plugins.aws.auth.getCallerIdentity();
local backend = plugins.aws.terraform.bootstrap('myproject');

{
  'backend.tf.json': backend,
  'providers.tf.json': { provider: plugins.aws.terraform.providerAliases('us-east-1') },
  'buckets.tf.json': plugins.aws.terraform.s3.bucket('artifacts', 'us-west-2'),
}
```

## The tree

| Path | What it does |
| --- | --- |
| [`plugins.aws.auth`](aws/auth) | AWS credentials, profiles and role chaining, with the SDK reachable from Jsonnet |
| [`plugins.aws.terraform`](aws/terraform) | S3 state backend, remote state, artifacts, provider aliases |
| [`plugins.aws.terraform.s3`](aws/terraform/s3) | Secure-by-default S3 bucket factory |
| [`plugins.aws.terraform.lambda`](aws/terraform/lambda) | Lambda factory: packaging, environment, and the IAM that goes with it |
| [`plugins.gcp.auth`](gcp/auth) | GCP credentials with impersonation, the googleapis client, service enablement |
| [`plugins.gcp.terraform`](gcp/terraform) | GCS state backend, remote state, artifacts, `googleOrgProject` |
| [`plugins.terraform`](terraform) | Provider-neutral lifecycle: `terraform-apply`, `terraform-destroy`, the events around them |
| [`plugins.utils.tree`](utils/tree) | Walks a nested structure into flat configuration, in one pass |
| [`plugins.utils.merge`](utils/merge) | Deep merge, without the `std.mergePatch` performance trap |

Each module has its own README in the associated directory.

## Native function names

SpellCraft registers a plugin's natives as `"<package-name>:<export>"`, with
dot-delimited names based on its hierarchy:

```
@c6fc/spellcraft-plugins:aws.auth.getCallerIdentity
```

## `config.spellcraftProject`

Since the `bootstrap()` in a manifest isn't always parsed before a call to `getArtifact()` or `putArtifact()`,
this plugin can read the project name from the spell's `package.json` `config.spellcraftProject` setting.
You could also accomplish this by writing your JSonnet to force `bootstrap()` to happen first, but the choice is yours.

```json
{ "config": { "spellcraftProject": "my-project" } }
```

## Lifecycle events

`plugins.terraform` emits, around `terraform-apply` and `terraform-destroy`:

```
@c6fc/spellcraft-plugins:terraform.pre-apply
@c6fc/spellcraft-plugins:terraform.post-apply
@c6fc/spellcraft-plugins:terraform.pre-destroy
@c6fc/spellcraft-plugins:terraform.post-destroy
```

## Testing

```bash
npm test    # no credentials, no network
npm run check  # the plugin contract, the node tree, and the tarball's contents
npm run doc    # regenerates every node's README from its doc comments
```