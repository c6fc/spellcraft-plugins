'use strict';

/*
 * The single SpellCraft plugin entry point for this package.
 *
 * Core registers a plugin's native functions as "<package-name>:<export-key>",
 * flattening everything the plugin exports into one namespace. Names here would
 * collide in that namespace -- `getCallerIdentity` exists in both auth nodes, and
 * `bootstrap`, `getArtifact`, `putArtifact`, `getBootstrapBucket` and
 * `getRemoteState` in both terraform nodes -- so a node's path prefixes its
 * export names.
 *
 * `aws/auth` exports a bare `getCallerIdentity`; this file re-exports it as
 * "aws.auth.getCallerIdentity", which core registers as
 * "@c6fc/spellcraft-plugins:aws.auth.getCallerIdentity". A JS export key may
 * contain dots and std.native() looks its argument up as an opaque string, so the
 * dotted name needs nothing special on either side, and reads as the same path
 * the Jsonnet call site uses.
 */

const path = require('path');

// Every node that has native functions, in init order. Nodes that are pure
// Jsonnet (aws/terraform/s3, aws/terraform/lambda) and pure namespaces (aws,
// gcp) have no index.js and do not appear here.
//
// scripts/check-native-refs.js asserts this list and the filesystem agree in
// both directions, so a new node cannot be added and silently left unwired.
const NODES = [
	'terraform',
	'aws/auth',
	'aws/terraform',
	'gcp/auth',
	'gcp/terraform',
];

const loaded = NODES.map((dir) => ({
	dir,
	prefix: dir.split('/').join('.'),
	mod: require('./' + dir),
}));

for (const { prefix, mod } of loaded) {
	for (const key of Object.keys(mod)) {
		// A leading underscore marks something a sibling node reaches directly --
		// `_internal.ensureAuth`, `_spellcraft_metadata` -- rather than something
		// Jsonnet should be able to call. Without this, core would register every
		// internal helper as a native.
		if (key.startsWith('_')) continue;

		exports[`${prefix}.${key}`] = mod[key];
	}
}

// Core accepts `init` and `cliExtensions` as arrays and processes them in
// order, so NODES order *is* init order -- stated in one place rather than
// emerging from require() order.
//
// `functionContext` is keyed flat (`aws`, `google`, `awsterraform`,
// `gcpterraform`), which is how a consumer reaches them through
// `spellframe.functionContext`.
//
// There is no `requires`: the nodes reach each other by relative require, so
// there is no separately installable package that could go missing.
exports._spellcraft_metadata = {
	functionContext: Object.assign(
		{},
		...loaded.map(({ mod }) => mod._spellcraft_metadata?.functionContext || {}),
	),

	fileTypeHandlers: Object.assign(
		{},
		...loaded.map(({ mod }) => mod._spellcraft_metadata?.fileTypeHandlers || {}),
	),

	cliExtensions: loaded
		.map(({ mod }) => mod._spellcraft_metadata?.cliExtensions)
		.filter(Boolean),

	init: loaded
		.map(({ mod }) => mod._spellcraft_metadata?.init)
		.filter(Boolean),

	// The node list, for the contract check. It lives on the metadata rather
	// than beside the natives because core registers *every* array-valued
	// export as a [fn, ...paramNames] native -- an exported array of node paths
	// would be registered as a native named after nothing, with "aws/auth" as a
	// Jsonnet parameter name.
	nodes: NODES,
};
