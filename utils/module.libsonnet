// A namespace node: no API of its own, only children.
//
// Provider-agnostic building blocks. Nothing here talks to a cloud, and neither
// child has an index.js -- these are pure Jsonnet, so there are no natives to
// register and nothing to appear in the root's _spellcraft_metadata.nodes.
{
	merge: import './merge/module.libsonnet',
	tree: import './tree/module.libsonnet',
}
