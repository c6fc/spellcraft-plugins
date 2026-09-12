# plugins.terraform

Provider-neutral Terraform lifecycle for
[SpellCraft](https://github.com/c6fc/spellcraft): renders a manifest, then runs
`terraform apply` on the result.

[![NPM version](https://img.shields.io/npm/v/@c6fc/spellcraft-plugins.svg?style=flat)](https://www.npmjs.com/package/@c6fc/spellcraft-plugins)
[![License](https://img.shields.io/npm/l/@c6fc/spellcraft-plugins.svg?style=flat)](https://opensource.org/licenses/MIT)

```bash
npm install --save @c6fc/spellcraft-plugins
```

This plugin knows nothing about any particular cloud. It owns the Terraform
binary, the apply, and the lifecycle events that let provider plugins do their
work at the right moment — `plugins.aws.terraform` and
`plugins.gcp.terraform` build on it.

## Rendering and applying

Terraform reads JSON, so a manifest emits `.tf.json` files and needs no special
handling:

```jsonnet
{
	"main.tf.json": {
		terraform: { required_version: ">= 1.2" },
		resource: {
			aws_s3_bucket: {
				artifacts: { bucket: "my-artifacts" },
			},
		},
	},
}
```

```bash
npx spellcraft terraform-apply manifest.jsonnet
```

That renders the manifest into `render/`, then runs `terraform init` and
`terraform apply` in that directory. `render/` is the Terraform root module —
there is no separate working directory to keep in sync.

| flag | effect |
|---|---|
| `-y`, `--auto-approve` | pass `-auto-approve` to `terraform apply` |
| `-s`, `--skip-init` | skip `terraform init`, for when you manage it yourself |

## Tearing down

```bash
npx spellcraft terraform-destroy manifest.jsonnet
```

This re-renders the manifest — `render/` is cleaned and rewritten on every run,
so the module Terraform destroys is always the one that matches the manifest,
not a stale one left over from the last apply — then runs `terraform init` and
`terraform destroy` in that directory. Same flags as `terraform-apply`:

| flag | effect |
|---|---|
| `-y`, `--auto-approve` | pass `-auto-approve` to `terraform destroy` |
| `-s`, `--skip-init` | skip `terraform init`, for when you manage it yourself |

## Carrying existing HCL forward

Terraform reads every `.tf` and `.tf.json` in a directory as one module, so
hand-written HCL only has to land in `render/` beside the generated JSON. This
plugin registers a handler for `.tf`, and Jsonnet's `importstr` reads a file
verbatim at evaluation time:

```jsonnet
{
	"networking.tf": importstr "./hcl/networking.tf",

	"main.tf.json": {
		output: {
			summary: { value: "${local.network_name} ${var.cidr}" },
		},
	},
}
```

The two are one module to Terraform: the generated JSON above can reference a
`local` or `variable` declared in the carried-forward HCL. Adoption can start
with a directory of existing HCL and move declarations into Jsonnet one at a
time.

The file is written through as-is; **interpolating it is not supported**.

## Choosing a Terraform version

The binary is downloaded on first use, checksum-verified against HashiCorp's
published `SHA256SUMS`, and cached under `node_modules/.cache`. It defaults to
**1.2.5**; set `config.tf_version` in your project's `package.json` to pin
another:

```json
{
	"config": {
		"tf_version": "1.9.8"
	}
}
```

## Lifecycle events

`terraform-apply` and `terraform-destroy` each announce their phases so other
plugins can act at the right moment, without this plugin knowing they exist:

| event | when |
|---|---|
| `@c6fc/spellcraft-plugins:terraform.pre-apply` | after the manifest is rendered and written, before `terraform init` |
| `@c6fc/spellcraft-plugins:terraform.post-apply` | after `terraform apply` returns |
| `@c6fc/spellcraft-plugins:terraform.pre-destroy` | after the manifest is rendered and written, before `terraform init` |
| `@c6fc/spellcraft-plugins:terraform.post-destroy` | after `terraform destroy` returns |

The name is the full `"<package>:<node>.<phase>"` string, not the `plugins.`
prefix a Jsonnet call site uses.

`pre-apply` is the one that matters. It is what solves step zero — the work that
has to happen *before* Terraform can plan, which Terraform cannot do for itself.
`plugins.gcp.terraform` listens on it to enable the GCP services the
rendered configuration is about to need:

```js
exports._spellcraft_metadata = {
	init: async (spellframe) => {
		spellframe.on('@c6fc/spellcraft-plugins:terraform.pre-apply', async () => {
			await enablePendingServices();
		});
	},
};
```

Listeners are awaited in registration order, so a listener that throws stops the
apply before it starts.

<!-- SPELLCRAFT_DOCS_CLI_START -->
## CLI Commands

- **`spellcraft terraform-apply <filename>`**
  Generate files from a configuration and run 'terraform apply' on the output
- **`spellcraft terraform-destroy <filename>`**
  Generate files from a configuration and run 'terraform destroy' on the output

<!-- SPELLCRAFT_DOCS_CLI_END -->

## Development

```bash
npm test        # renders test.jsonnet through a real SpellFrame
npm run cli     # exercises this plugin's CLI commands
npm run doc     # regenerates the section above from source
```

The first run downloads the Terraform binary into `node_modules/.cache`.

## License

MIT © [Brad Woodward](https://github.com/c6fc)
