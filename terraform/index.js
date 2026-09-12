'use strict';

// require("@c6fc/terraform") pulls in 81 modules -- axios, unzip-stream,
// form-data, find-cache-dir and their trees -- for about 80ms. Core require()s
// every installed plugin's entry point to discover it, so eagerly requiring it
// here charges that to every `spellcraft` command, `--help` included, and to
// every spell that never runs Terraform. Measured: this node's entry point alone
// is 0.04s and 7 modules; with the require it is 0.12s and 88. Same reasoning
// that defers `aws-sdk` in aws/auth and `googleapis` in gcp/auth, and a bigger
// proportional saving than either, since there is so little else here.
//
// The general rule, which is what this is an instance of: a plugin's entry point
// must be side-effect-free at require() time, and that includes whatever it
// requires.
//
// A plain accessor rather than the Proxy the auth nodes use: two call sites here,
// both ordinary property reads, so there is nothing to disguise.
let tf = null;
const terraform = () => (tf ??= require("@c6fc/terraform"));

// Lifecycle events other nodes hook, so they can act at the right moment without
// this node knowing they exist. The name carries the package and the node because
// a bare 'pre-apply' collides with the second plugin that has a notion of
// applying.
const event = (phase) => `@c6fc/spellcraft-plugins:terraform.${phase}`;

async function emitLifecycle(spellframe, phase) {
	await spellframe.emitAsync(event(phase));
}

exports._spellcraft_metadata = {

	// Terraform reads every .tf and .tf.json in one directory, so HCL you already
	// have has to land in the render directory as raw text beside the generated
	// JSON. Pair this with Jsonnet's importstr, which reads a file verbatim at
	// evaluation time:
	//
	//   { "legacy.tf": importstr "./hcl/networking.tf" }
	//
	// The imported string is written through as-is; interpolating it is not
	// supported.
	fileTypeHandlers: {
		'.*?\\.tf$': (content) => (typeof content === "string" ? content : JSON.stringify(content, null, 4))
	},

	cliExtensions: (yargs, spellframe) => {
		yargs.command("terraform-apply <filename>", "Generate files from a configuration and run 'terraform apply' on the output", (yargs) => {
			return yargs.positional('filename', {
				describe: 'Jsonnet configuration file to consume'
			}).option('skip-init', {
				alias: 's',
				type: 'boolean',
				description: 'Skip provider initialization.'
			}).option('auto-approve', {
				alias: 'y',
				type: 'boolean',
				description: 'Skip the apply confirmation. YOLO.'
			});
		}, async (argv) => {

			// No `await terraform().isReady` here. exec() installs the binary
			// itself, and this command always reaches it -- --skip-init skips only
			// `terraform init`, not the apply below it. Awaiting up front would fetch
			// tens of megabytes before the render that decides whether Terraform
			// runs at all, so a manifest that fails to render, or a pre-apply
			// listener that throws, would pay for a binary nothing goes on to use.

			await spellframe.init();
			await spellframe.render(argv.filename);
			await spellframe.write();

			await emitLifecycle(spellframe, 'pre-apply');

			if (!argv['skip-init']) {
				await terraform().exec(["init"], {
					cwd: spellframe.renderPath,
					stdio: [process.stdin, process.stdout, process.stderr]
				});
			}

			const args = (argv['auto-approve']) ? ['apply', '-auto-approve'] : ['apply'];

			await terraform().exec(args, {
				cwd: spellframe.renderPath,
				stdio: [process.stdin, process.stdout, process.stderr]
			});

			await emitLifecycle(spellframe, 'post-apply');
		});

		yargs.command("terraform-destroy <filename>", "Generate files from a configuration and run 'terraform destroy' on the output", (yargs) => {
			return yargs.positional('filename', {
				describe: 'Jsonnet configuration file to consume'
			}).option('skip-init', {
				alias: 's',
				type: 'boolean',
				description: 'Skip provider initialization.'
			}).option('auto-approve', {
				alias: 'y',
				type: 'boolean',
				description: 'Skip the destroy confirmation. YOLO.'
			});
		}, async (argv) => {

			// See terraform-apply above: exec() installs the binary, after the
			// render has decided there is anything to destroy.

			await spellframe.init();
			await spellframe.render(argv.filename);
			await spellframe.write();

			await emitLifecycle(spellframe, 'pre-destroy');

			if (!argv['skip-init']) {
				await terraform().exec(["init"], {
					cwd: spellframe.renderPath,
					stdio: [process.stdin, process.stdout, process.stderr]
				});
			}

			const args = (argv['auto-approve']) ? ['destroy', '-auto-approve'] : ['destroy'];

			await terraform().exec(args, {
				cwd: spellframe.renderPath,
				stdio: [process.stdin, process.stdout, process.stderr]
			});

			await emitLifecycle(spellframe, 'post-destroy');
		});

		console.log(`[+] Imported SpellFrame CLI extensions for @c6fc/spellcraft-plugins:terraform`);
	}

	// No init hook. Core runs every loaded plugin's init() on any command that
	// renders, so awaiting the Terraform binary belongs in the two commands that
	// actually run Terraform -- see terraform-apply above.
};