// A namespace node: no API of its own, only children. See aws/module.libsonnet.
{
	auth: import './auth/module.libsonnet',
	terraform: import './terraform/module.libsonnet',
}
