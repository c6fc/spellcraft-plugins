// The single Jsonnet entry point for @c6fc/spellcraft-plugins.
//
//   local plugins = import '@c6fc/spellcraft-plugins/module.libsonnet';
//
//   local account = plugins.aws.auth.getCallerIdentity();
//   local backend = plugins.aws.terraform.bootstrap('myproject');
//
// Every directory below is a node, and its module.libsonnet is that node's whole
// object -- its own API plus its children. So `plugins.aws.terraform` and
// `import '@c6fc/spellcraft-plugins/aws/terraform/module.libsonnet'` are the same
// object; there is no partial view depending on how you reached it.
//
// Jsonnet imports are thunks, so naming a node here costs nothing until a field
// of it is actually forced. Importing this file does not authenticate to
// anything.
{
	aws: import './aws/module.libsonnet',
	gcp: import './gcp/module.libsonnet',
	terraform: import './terraform/module.libsonnet',
	utils: import './utils/module.libsonnet',
}
