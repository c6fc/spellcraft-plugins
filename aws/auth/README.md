# plugins.aws.auth

AWS credentials, role chaining and profile handling for
[SpellCraft](https://github.com/c6fc/spellcraft), with the AWS SDK reachable
directly from Jsonnet.

[![NPM version](https://img.shields.io/npm/v/@c6fc/spellcraft-plugins.svg?style=flat)](https://www.npmjs.com/package/@c6fc/spellcraft-plugins)
[![License](https://img.shields.io/npm/l/@c6fc/spellcraft-plugins.svg?style=flat)](https://opensource.org/licenses/MIT)

This is what lets a manifest ask AWS a question while it renders — an account
number, the regions you can see, whether a bucket already exists — instead of
being handed an answer someone pasted in.

```bash
npm install --save @c6fc/spellcraft-plugins
```

```jsonnet
local aws = (import "@c6fc/spellcraft-plugins/module.libsonnet").aws.auth;

{
	"identity.json": aws.getCallerIdentity(),
}
```

SpellCraft finds the plugin through your dependencies, so there is nothing to
register.

## Credentials

Whatever the plugin authenticates as becomes the render's identity, and
`getCallerIdentity()` reports it:

```console
$ npx spellcraft aws-identity
{
    "UserId": "AIDAEXAMPLEAAAAA",
    "Account": "123456789012",
    "Arn": "arn:aws:iam::123456789012:user/you"
}
```

With `AWS_PROFILE` set, the named profile is used, including profiles that
assume a role. You are prompted for an MFA token when the profile needs one, and
the resulting session is cached so later renders don't ask again. Without it,
the AWS SDK's own credential resolution applies.

### Role chaining

Set `SPELLCRAFT_ASSUMEROLE` to an ARN and the plugin assumes that role with
whatever it just authenticated as, then renders as the assumed identity:

```console
$ export SPELLCRAFT_ASSUMEROLE="arn:aws:iam::345678901234:role/deployment"
$ npx spellcraft aws-identity
{
    "UserId": "AROAEXAMPLEBBBB:spellcraft_assumerole_1756900000000",
    "Account": "345678901234",
    "Arn": "arn:aws:iam::345678901234:assumed-role/deployment/spellcraft_assumerole_1756900000000"
}
```

The session name is `spellcraft_assumerole_<epoch-milliseconds>`, which is worth
knowing when you write the role's trust policy.

## Cost and caching

`getCallerIdentity()` is resolved on the first call that needs credentials and
cached for the rest of the process, so it costs one request no matter how many
times you call it — and nothing at all in a spell that never touches AWS. Everything else is a live API call, memoised per
`(function, arguments)` for the life of a render — so calling `aws.call('STS',
'getCallerIdentity')` in forty places is one request, but forty *different*
calls are forty requests.

`getAvailabilityZones()` is the expensive one: `describeRegions` plus a
`describeAvailabilityZones` for every region it returns. Useful, but not
something to reach for casually.

<!-- SPELLCRAFT_DOCS_CLI_START -->
## CLI Commands

- **`spellcraft aws-identity`**
  Display the AWS IAM identity of the SpellCraft execution context
- **`spellcraft aws-exportcredentials`**
  Export the current credentials as environment variables

<!-- SPELLCRAFT_DOCS_CLI_END -->

## What it contributes to a SpellFrame

- **No `init()` hook.** Credentials resolve on the first native call that needs
  them — resolving the profile, performing the optional `AssumeRole`, prompting
  for MFA if required — memoised for the rest of the process. This is deliberate:
  SpellCraft runs *every* loaded plugin's `init()` whether or not a spell uses
  that plugin, so resolving here would make an AWS credential failure fatal to a
  spell that never touches AWS.
- **`functionContext.aws`** — the authenticated AWS-SDK v2 module, available as
  `this.aws` inside any plugin's native functions. This is the seam other
  plugins use to reuse these credentials rather than authenticating again:

  ```js
  const { aws } = require('@c6fc/spellcraft-plugins')._spellcraft_metadata.functionContext;
  ```

  The SDK itself is loaded lazily behind that reference, so reading it costs
  nothing until you use it.
- **Two CLI commands**, `aws-identity` and `aws-exportcredentials`, which force
  authentication themselves since they no longer get it from `init()`.

- **Native functions** — `getCallerIdentity` and `aws`, the latter being the
  generic SDK passthrough that `api()` and `call()` below are built on.

<!-- SPELLCRAFT_DOCS_API_START -->
## API Reference

### `client(service, params={})`

Describes an AWS service client. Pass the result to `aws.api()`.

This does not instantiate anything on its own — it is a plain object naming
the service and the constructor parameters, which `aws.api()` hands to the
SDK. Reach for it when a call needs non-default client options such as a
region; otherwise `aws.call()` is shorter.

- param {string} service - an AWS-SDK v2 client name, e.g. 'STS' or 'EC2'
- param {object} [params={}] - constructor options, e.g. { region: "us-west-2" }
- returns {object} a client descriptor

**Examples:**

```jsonnet
local aws = (import "@c6fc/spellcraft-plugins/module.libsonnet").aws.auth;
local ec2 = aws.client('EC2', { region: "us-west-2" });

{ "zones.json": aws.api(ec2, 'describeAvailabilityZones') }
```

---
### `api(clientObj, method, params={})`

Calls an AWS API method and returns its response.

The client and parameters are serialised on the way out because Jsonnet
cannot pass objects into a native function, and parsed again on the
JavaScript side. The response comes back as an ordinary Jsonnet object.

- param {object} clientObj - a descriptor from `aws.client()`
- param {string} method - the SDK method name, e.g. 'describeRegions'
- param {object} [params={}] - request parameters
- returns {object} the API response, with ResponseMetadata left intact

**Examples:**

```jsonnet
local aws = (import "@c6fc/spellcraft-plugins/module.libsonnet").aws.auth;
local s3 = aws.client('S3', { region: "us-west-2" });

{ "buckets.json": aws.api(s3, 'listBuckets') }
```

---
### `call(name, method, params={})`

Shorthand for `aws.api(aws.client(name, { region: "us-east-1" }), method, params)`.

Note the pinned region: this is for global endpoints such as STS and IAM.
For anything regional, build the client yourself with `aws.client()` so the
call reaches the region you mean.

- param {string} name - an AWS-SDK v2 client name
- param {string} method - the SDK method name
- param {object} [params={}] - request parameters
- returns {object} the API response

**Examples:**

```jsonnet
local aws = (import "@c6fc/spellcraft-plugins/module.libsonnet").aws.auth;

{ "identity.json": aws.call('STS', 'getCallerIdentity') }
```

---
### `getCallerIdentity()`

The identity the render is authenticated as.

Resolved on the first call that needs credentials and cached for the rest
of the process, so calling it repeatedly costs one request. It is the
identity *after* any `SPELLCRAFT_ASSUMEROLE` chaining has happened.

- returns {object} `{ UserId, Account, Arn }`

**Examples:**

```jsonnet
local aws = (import "@c6fc/spellcraft-plugins/module.libsonnet").aws.auth;

{ "account.json": { account: aws.getCallerIdentity().Account } }
```

---
### `getRegionsList()`

Every region name the current credentials can see.

One `describeRegions` call against us-east-1, mapped down to the names.

- returns {string[]} region names, e.g. `["us-east-1", "us-west-2", ...]`

**Examples:**

```jsonnet
local aws = (import "@c6fc/spellcraft-plugins/module.libsonnet").aws.auth;

{ "regions.json": aws.getRegionsList() }
```

---
### `getAvailabilityZones()`

Availability zone names, keyed by region.

Be aware of the cost: this is one `describeRegions` call plus one
`describeAvailabilityZones` per region, so it makes tens of API calls and
takes a while. Memoisation makes it once per render, not once per use.

- returns {object} region name to an array of zone names

**Examples:**

```jsonnet
local aws = (import "@c6fc/spellcraft-plugins/module.libsonnet").aws.auth;

{ "zones.json": aws.getAvailabilityZones() }

// Returns:
// { "us-east-1": ["us-east-1a", "us-east-1b", ...], ... }
```

---

<!-- SPELLCRAFT_DOCS_API_END -->

## The SDK surface

This plugin wraps the **AWS SDK for JavaScript v2**. Method names are passed
through untouched, so anything in the
[v2 API reference](https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/) is
callable — every service, every method, no per-service wrappers to wait for.

## Development

```bash
npm test        # renders test.jsonnet through a real SpellFrame
npm run cli     # exercises this plugin's CLI commands
npm run doc     # regenerates the two sections above from source comments
```

`npm test` needs real AWS credentials and is read-only, but it calls
`getAvailabilityZones()` — expect it to take a while and make a lot of
describes.

## License

MIT © [Brad Woodward](https://github.com/c6fc)
