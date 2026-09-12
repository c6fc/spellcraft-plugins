# plugins.aws.terraform.lambda

Node.js Lambda functions for [SpellCraft](https://github.com/c6fc/spellcraft), packaging, IAM and log retention included.

[![NPM version](https://img.shields.io/npm/v/@c6fc/spellcraft-plugins.svg?style=flat)](https://www.npmjs.com/package/@c6fc/spellcraft-plugins)
[![License](https://img.shields.io/npm/l/@c6fc/spellcraft-plugins.svg?style=flat)](https://opensource.org/licenses/MIT)

Pure Jsonnet — no native functions of its own. One call produces the function,
its role and policies, its log group and its build artifact.

## Features

`nodejs_function(name, region, options={})` renders a complete, working Lambda deployment from a
single call: the function itself, an execution role with inline and attached policies, a CloudWatch
log group, X-Ray tracing, an `archive_file` data source that zips your source directory, and a
`null_resource` that runs `npm install` in it first.

It's only reachable through `config()`, called once per file:

```jsonnet
local lambda = ((import "@c6fc/spellcraft-plugins/module.libsonnet").aws.terraform.lambda).config({ thisFile: std.thisFile });

lambda.nodejs_function("my_function", "us-east-1")
```

Source for `my_function` is then expected at `lambda_functions/my_function/`, sibling to `thisFile`.

### Why `config()` is required, not optional

An earlier version let `nodejs_function()` work standalone, defaulting `thisFile` to something that
resolved the same way `${path.module}/../lambda_functions/<name>` always had. That default is
indistinguishable, from inside the function, from a plugin author who simply forgot to call
`config()` — and it's worse than just ambiguous: it can look correct during that author's own
standalone testing, because `render/`'s parent happens to *be* their plugin's own root when they're
the ones running it. It only actually breaks once someone else nests that plugin inside a *different*
project, far from wherever the mistake was made, with a confusing `terraform apply`-time "source
directory does not exist" rather than a clear failure at `spellcraft generate` time. Requiring
`config()` closes that off entirely: calling `nodejs_function()` without it fails immediately, by
name, for everyone, every time — plugin author or direct consumer alike.

`thisFile` can't have a default set here, either, for a related reason: `std.thisFile` is
**lexical**, not dynamic — it names whichever file the token is physically written in, regardless of
who calls the function that contains it or how deep the call chain goes. A default written in *this*
file would itself be lexically bound to this plugin's own path, not yours, so it has to come from
your own call site.

### Shared defaults

Anything passed to `config()` besides `thisFile` becomes a default for every `nodejs_function()` call
made through the returned object — any option in the table below, or anything passed through to the
resource. A call's own `options` always wins over a `config()` default for the same key:

```jsonnet
local lambda = (import "@c6fc/spellcraft-plugins/module.libsonnet").aws.terraform.lambda.config({
	thisFile: std.thisFile,
	tracing: "PassThrough",
});

{
	// Inherits tracing: "PassThrough" from config().
	"worker.tf.json": lambda.nodejs_function("worker", "us-east-1"),

	// Overrides it for this call only.
	"scheduler.tf.json": lambda.nodejs_function("scheduler", "us-east-1", { tracing: "Active" }),
}
```

### Nesting this plugin inside another

The same `config()` call is what lets this plugin work correctly when it's not the one being called
directly from a project's manifest:

```jsonnet
// Inside @your-org/some-component/module.libsonnet
local lambda = ((import "@c6fc/spellcraft-plugins/module.libsonnet").aws.terraform.lambda).config({ thisFile: std.thisFile });

{
	build(region):: lambda.nodejs_function("worker", region),
	// -> resolves lambda_functions/worker/ inside @your-org/some-component itself,
	//    not inside whatever project eventually installs it
}
```

Optional keys — all hidden from the rendered resource, and all usable as `config()` defaults too:

| option | default | purpose |
|---|---|---|
| `arns_allowed_to_invoke` | `[]` | ARNs granted `lambda:InvokeFunction` |
| `services_allowed_to_invoke` | `[]` | Objects with `principal` and optionally `source_arn` |
| `event_triggers` | `[]` | `aws_cloudwatch_event_rule` bodies; rule, target and permission are wired up for you |
| `execution_policy_attachments` | `[]` | Managed policy ARNs to attach to the role |
| `execution_policy_statements` | `[]` | Inline IAM statement objects |
| `cloudwatch_log_retention_days` | `30` | Log group retention |
| `retain_logs_on_destroy` | `true` | Keep the log group when the function is destroyed |
| `tracing` | `'Active'` | X-Ray mode: `Active` or `PassThrough` |

Any other key is passed through to the `aws_lambda_function` resource, so `runtime`, `handler`,
`timeout`, `memory_size` and `environment` can all be overridden.

### `refs` — referencing what this call produces, without knowing its naming scheme

`nodejs_function()` builds more than one resource, each with its own derived name (`lambda-my_function`
for the role, for instance) — internal details a caller extending or wiring into them shouldn't have
to already know. The return value's hidden `refs` field makes every one of them addressable as
`"<resource_type>.<the name you passed>"`. Because `refs` belongs to the object this call returned,
the name alone is unambiguous.

```jsonnet
local lambda = (import "@c6fc/spellcraft-plugins/module.libsonnet").aws.terraform.lambda.config({ thisFile: std.thisFile });

local fn = lambda.nodejs_function("my_function", "us-east-1", { timeout: 30 });

{
	"lambda.tf.json": fn,

	// Extend the role this call created, without knowing it's named
	// "lambda-my_function" internally.
	"extra.tf.json": {
		resource: {
			aws_iam_role_policy_attachment: {
				extra: {
					role: "${%s.id}" % fn.refs["aws_iam_role.my_function"]._terraform_id,
					policy_arn: "arn:aws:iam::aws:policy/SomeOtherPolicy",
				},
			},
		},
	},

	// The value is what was manifested, so derived values are readable too --
	// this is "/aws/lambda/my_function", which nothing else exposes.
	"log_group.json": {
		group: fn.refs["aws_cloudwatch_log_group.my_function"].name,
	},
}
```

Each entry's **value is the resource as it was manifested** — not the options you passed, which you
already have — plus one hidden field, `_terraform_id`, holding the exact address to build a reference
from. So `fn.refs["aws_cloudwatch_log_group.my_function"].retention_in_days` reads back what the
resource actually got, and `"${%s.arn}" % fn.refs["..."]._terraform_id` builds a reference to whichever
attribute you need. `refs` never guesses which attribute you want, so it never goes stale as new ones
start to matter.

`refs` is hidden (`::`), so — like `config()`'s internals — it never appears in the rendered
`.tf.json`, only in Jsonnet itself.

The keys for one call, always present:

| key | the resource it addresses |
|---|---|
| `aws_lambda_function.<name>` | the function |
| `aws_iam_role.<name>` | its execution role |
| `aws_iam_role_policy.<name>` | the inline policy on that role |
| `aws_cloudwatch_log_group.<name>` | its log group |
| `local_file.<name>` | the generated `ENVVARS` file |
| `null_resource.<name>` | the `npm install` step |
| `data.archive_file.<name>` | the zip build (a data source's own reference syntax already starts with `data.`, so that's the type prefix here too) |

Where one option produces several resources, the entry holds them for you to index rather than
extending the key:

| key | shape |
|---|---|
| `aws_iam_role_policy_attachment.<name>` | keyed by policy name — `.AmazonS3ReadOnlyAccess` — including `AWSXRayDaemonWriteAccess`, which this plugin attaches itself |
| `aws_cloudwatch_event_rule.<name>` | an array, in `event_triggers` order |
| `aws_cloudwatch_event_target.<name>` | an array, in `event_triggers` order |
| `aws_lambda_permission.<name>` | sub-keyed by the option that produced each one: `.arns_allowed_to_invoke`, `.services_allowed_to_invoke`, `.event_triggers`, each an array in that option's order |

The last four exist only when the options that build them do. An `event_triggers` you never set
produces no event rule, so there is no `aws_cloudwatch_event_rule.<name>` to reference either.

<!-- SPELLCRAFT_DOCS_CLI_START -->

<!-- SPELLCRAFT_DOCS_CLI_END -->

<!-- SPELLCRAFT_DOCS_API_START -->
## API Reference


<!-- SPELLCRAFT_DOCS_API_END -->

## Installation

Install the plugin as a dev dependency in your SpellCraft project:

```bash
npm install --save @c6fc/spellcraft-plugins
```

Once installed, import the module directly by package path:

```jsonnet
local lambda = ((import "@c6fc/spellcraft-plugins/module.libsonnet").aws.terraform.lambda).config({ thisFile: std.thisFile });
local aws = (import "@c6fc/spellcraft-plugins/module.libsonnet").aws.terraform;

{
	'providers.tf.json': {
		provider: aws.providerAliases("us-east-1")
	},

	// Source lives in lambda_functions/my_function/, sibling to this file
	'lambda.tf.json': lambda.nodejs_function("my_function", "us-east-1", {
		timeout: 30,
		memory_size: 512,

		execution_policy_statements: [{
			Effect: "Allow",
			Action: ["s3:GetObject"],
			Resource: "arn:aws:s3:::my-bucket/*"
		}],

		event_triggers: [{
			schedule_expression: "rate(1 hour)"
		}]
	})
}
```

This module renders Terraform only; pair it with
[`plugins.aws.terraform`](..) for the AWS provider definitions and state backend.

One thing to know when you write your own `required_providers` block: this
factory emits `null_resource` and `local_file`, so that block needs the `null`
and `local` providers — and both of those words are **Jsonnet keywords**, so
they have to be quoted:

```jsonnet
{
	"providers.tf.json": {
		terraform: {
			required_providers: {
				aws: { source: "hashicorp/aws" },
				"null": { source: "hashicorp/null" },
				"local": { source: "hashicorp/local" },
			},
		},
	},
}
```

Unquoted, Jsonnet fails with `unexpected: null while parsing field definition`,
pointing at a line that looks perfectly correct if you are reading it as
Terraform. Resource *types* are unaffected — `null_resource` and `local_file`
are ordinary identifiers.

## Documentation

Regenerate the API and CLI sections above with `npx spellcraft doc` from this directory.