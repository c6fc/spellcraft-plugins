// A namespace node: no API of its own, only children.
//
// There is nothing special about this file compared to `aws/terraform/module.libsonnet`,
// which has both -- a directory's module.libsonnet is always that node's whole
// object, and a pure namespace is just a node whose own half is empty.
{
	auth: import './auth/module.libsonnet',
	terraform: import './terraform/module.libsonnet',
}
