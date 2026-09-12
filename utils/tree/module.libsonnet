// The Jsonnet face of this node. Pure Jsonnet -- there is no index.js here and
// no native functions to reach.
//
// This file is the node's whole object -- its own API and, where it has them, its
// children by relative import. Doc comments below are lifted into README.md by
// `npx spellcraft doc`.

local merge = import '../merge/module.libsonnet';

// Default hooks, named so a stack trace says which one was in play.
local passThrough(ctx) = ctx.inherited;
local asWritten(node) = node;
local byName(body) = body.name;
local identity(built) = built;

{
	/**
	 * Walks a nested structure once, handing every node to your hooks and
	 * deep-merging what they return into a single object.
	 *
	 * This is the shape behind `gcp.terraform.googleOrgProject()`: a caller
	 * writes a tree of nodes, and each node becomes some configuration whose
	 * names, parent references and dependency wiring are derived from where it
	 * sits in that tree. `walk()` owns the traversal, the name accumulation and
	 * the assembly; you supply what a node *becomes*.
	 *
	 * Two hooks are required — `name(ctx)` and `node(ctx)`. Everything else has a
	 * default, and the examples below introduce them one at a time.
	 *
	 * `ctx` carries, at every node:
	 *
	 * | field | is |
	 * |---|---|
	 * | `node` | the node exactly as the caller wrote it |
	 * | `body` | that node after `body(node)` — computed once, shared by every hook |
	 * | `label` | this node's caller-facing name, from `label(body)` |
	 * | `path` | `[label, ...]` from the root: the caller's own names, underived |
	 * | `name` | this node's derived name, from `name(ctx)` |
	 * | `parentName` | the parent's derived name |
	 * | `inherited` | whatever the parent's `handoff(ctx)` returned |
	 * | `depth` | `0` at the root |
	 * | `index` | this node's position among its siblings |
	 * | `fragment` | this node's own output — in `refs(ctx)` only |
	 *
	 * Three pairs are easy to confuse, so they are worth separating up front:
	 *
	 * - **`body` and `node`.** `body` transforms a node on the way *in* (applying
	 *   defaults); `node` produces what comes *out*. One normalizes input, the
	 *   other emits output.
	 * - **`label` and `name`.** `label` is the name the *caller* wrote and feeds
	 *   `ctx.path`; `name` is what *you* derived from it and keys your output.
	 *   Both accumulate down the tree, in the same pass, independently. Because
	 *   `name` keys a merged result, it has to be unique tree-wide — derive it
	 *   from `ctx.path` or `ctx.parentName` rather than from the node's own name.
	 * - **`inherited` and `handoff`.** `inherited` seeds the *root node only*;
	 *   `handoff` computes it for every level below.
	 *
	 * Two things worth knowing about how this is built, because both were
	 * measured rather than assumed:
	 *
	 * - Every node is visited exactly once, and the fragments are collected into
	 *   a flat list and merged once at the end. Merging as the recursion unwinds
	 *   stacks a merge layer per level of the tree, which is how the same pattern
	 *   became unusable in `googleOrgProject()` before it was fixed.
	 * - Nothing here prunes. If your fragments contain empty families or nulls
	 *   you do not want, prune inside `node(ctx)` — that keeps the cost visible
	 *   and attributable to the caller that incurs it.
	 *
	 * @param {object} root - the top node of the structure to walk. This is the tree's root *node*; `spec.root` below is a different thing entirely, a hook that runs on the finished result.
	 * @param {object} spec - the hooks and settings below
	 * @param {function} spec.name - **Required.** `name(ctx)` returns this node's derived name, which is what your output is keyed by. Build it from `ctx.parentName` and names accumulate down the tree. Names must be **unique across the whole tree**: every node's output is deep-merged into one object, so two nodes deriving the same name would become one. Deriving from `ctx.path` (or from `ctx.parentName`) gives you that for free; `ctx.body.name` alone does not, since two teams called `platform` under different parents is an ordinary shape. A collision is refused, naming both paths.
	 * @param {function} spec.node - **Required.** `node(ctx)` returns this node's contribution. Every node's return value is deep-merged into one object.
	 * @param {function} [spec.body] - `body(node)` normalizes one node on the way in, usually by applying defaults. Its result becomes `ctx.body`, computed once per node and shared by every other hook. Defaults to the node exactly as the caller wrote it.
	 * @param {function} [spec.handoff] - `handoff(ctx)` returns the value this node's *children* receive as `ctx.inherited` — typically a reference to whatever this node just declared, which is how a child points at its parent. Defaults to passing `ctx.inherited` straight down, so without it every node sees the same value.
	 * @param {function} [spec.label] - `label(body)` returns this node's caller-facing name, the one accumulated into `ctx.path`. Use it when your nodes are not named by a `name` field. Defaults to `body.name`.
	 * @param {function} [spec.refs] - `refs(ctx)` returns address entries for this node, shallow-merged across the tree into a hidden `refs` field on the result. This is the only hook whose `ctx` carries `fragment`, so values can be read out of what the node actually built.
	 * @param {function} [spec.root] - `root(built)` receives the whole assembled tree once every node has merged, and returns the final result. For anything that needs every node at once, such as a resource depending on all the others.
	 * @param {string} [spec.children="children"] - the field on a node holding its children. Read with `std.get`, so a hidden `children::` supplied by `body` resolves too.
	 * @param {*} [spec.inherited=null] - what the *root node* receives as `ctx.inherited`: the value entering the tree from outside it. Every node below receives `handoff(ctx)` instead.
	 * @param {string} [spec.parentName=""] - what the *root node* receives as `ctx.parentName`, seeding the derived-name accumulation. Every node below receives its parent's `name`.
	 * @returns {object} every node's fragment deep-merged into one object, passed through `root(built)` if you gave one, with a hidden `refs` field if you gave `refs(ctx)`
	 * @example
	 * local tree = (import "@c6fc/spellcraft-plugins/module.libsonnet").utils.tree;
	 *
	 * // The two required hooks: what a node is called, and what it becomes.
	 * // Deriving the name from `ctx.path` keeps it unique by construction, which
	 * // is what you want: output is merged, not concatenated.
	 * {
	 *   "flat.json": tree.walk({ name: "eng", children: [{ name: "api" }] }, {
	 *     name(ctx):: std.join("_", ctx.path),
	 *     node(ctx):: { [ctx.name]: { depth: ctx.depth } },
	 *   }),
	 * }
	 *
	 * // Returns { "flat.json": { "eng": { "depth": 0 }, "eng_api": { "depth": 1 } } }
	 * @example
	 * local tree = (import "@c6fc/spellcraft-plugins/module.libsonnet").utils.tree;
	 *
	 * // `inherited` seeds the root node; `handoff` computes it for every level
	 * // below, so a child can reference whatever its parent just declared.
	 * {
	 *   "folders.json": tree.walk({ name: "eng", children: [{ name: "api" }] }, {
	 *     inherited: "organizations/123456789",
	 *     handoff(ctx):: "folders/${google_folder.%s.folder_id}" % ctx.name,
	 *     name(ctx):: ctx.body.name,
	 *     node(ctx):: { [ctx.name]: { parent: ctx.inherited } },
	 *   }),
	 * }
	 *
	 * // "api" gets parent "folders/${google_folder.eng.folder_id}"; the root
	 * // keeps the organization it was seeded with.
	 * @example
	 * local tree = (import "@c6fc/spellcraft-plugins/module.libsonnet").utils.tree;
	 *
	 * // The two accumulations, side by side. ctx.name is derived -- here
	 * // prefixed from parentName and upper-cased -- while ctx.path stays
	 * // exactly what the caller wrote, which is what makes it a usable key.
	 * {
	 *   "names.json": tree.walk({ name: "eng", children: [{ name: "api" }] }, {
	 *     parentName: "acme",
	 *     name(ctx):: std.asciiUpper("%s_%s" % [ctx.parentName, ctx.body.name]),
	 *     node(ctx):: { [std.join(".", ctx.path)]: ctx.name },
	 *   }),
	 * }
	 *
	 * // Returns { "names.json": { "eng": "ACME_ENG", "eng.api": "ACME_ENG_API" } }
	 * @example
	 * local tree = (import "@c6fc/spellcraft-plugins/module.libsonnet").utils.tree;
	 *
	 * // `body` applies defaults once per node, and every hook then reads the
	 * // same ctx.body. Declaring them hidden keeps inputs that are yours, not
	 * // the output format's, from leaking into what you emit. ctx.node stays
	 * // the node exactly as the caller wrote it, so you can still tell what
	 * // they actually supplied and what merely defaulted.
	 * {
	 *   "tiers.json": tree.walk({ name: "root", children: [{ name: "hot", tier: "gold" }] }, {
	 *     body(node):: { tier:: "standard", children:: [] } + node,
	 *     name(ctx):: ctx.body.name,
	 *     node(ctx):: { [ctx.name]: {
	 *       tier: ctx.body.tier,
	 *       explicit: std.objectHas(ctx.node, "tier"),
	 *     } },
	 *   }),
	 * }
	 *
	 * // Returns { "tiers.json": {
	 * //   "root": { "tier": "standard", "explicit": false },
	 * //   "hot":  { "tier": "gold",     "explicit": true } } }
	 * @example
	 * local tree = (import "@c6fc/spellcraft-plugins/module.libsonnet").utils.tree;
	 *
	 * // A structure that names things its own way: `children` says which field
	 * // holds descendants, `label` says which one names a node.
	 * {
	 *   "units.json": tree.walk({ id: "eng", units: [{ id: "api" }] }, {
	 *     children: "units",
	 *     label(body):: body.id,
	 *     name(ctx):: std.join("-", ctx.path),
	 *     node(ctx):: { [ctx.name]: { label: ctx.label } },
	 *   }),
	 * }
	 *
	 * // Keyed by the derived name, carrying the caller's label:
	 * // { "units.json": { "eng": { "label": "eng" }, "eng-api": { "label": "api" } } }
	 * @example
	 * local tree = (import "@c6fc/spellcraft-plugins/module.libsonnet").utils.tree;
	 *
	 * // `root` receives the assembled tree, so a post-pass over everything that
	 * // was built -- here a marker depending on every resource -- is a plain
	 * // expression rather than a second traversal.
	 * {
	 *   "org.tf.json": tree.walk({ name: "eng", children: [{ name: "api" }] }, {
	 *     name(ctx):: ctx.body.name,
	 *     node(ctx):: { resource: { thing: { [ctx.name]: {} } } },
	 *     root(built):: built + {
	 *       resource+: { marker: { all: {
	 *         depends_on: ["thing.%s" % n for n in std.objectFields(built.resource.thing)],
	 *       } } },
	 *     },
	 *   }),
	 * }
	 * @example
	 * local tree = (import "@c6fc/spellcraft-plugins/module.libsonnet").utils.tree;
	 *
	 * // refs keys are the caller's path; values are read out of ctx.fragment --
	 * // this node's own output -- so they cannot drift from what was built.
	 * local built = tree.walk({ name: "eng", children: [{ name: "api" }] }, {
	 *   name(ctx):: std.join("_", ctx.path),
	 *   node(ctx):: { resource: { thing: { [ctx.name]: { id: ctx.name } } } },
	 *   refs(ctx):: {
	 *     ["thing.%s" % std.join(".", ctx.path)]:
	 *       ctx.fragment.resource.thing[ctx.name]
	 *       + { _terraform_id:: "thing.%s" % ctx.name },
	 *   },
	 * });
	 *
	 * {
	 *   // refs is hidden, so it never reaches the rendered file.
	 *   "org.tf.json": built,
	 *   "lookup.json": { api: built.refs["thing.eng.api"]._terraform_id },
	 * }
	 *
	 * // "lookup.json" is { "api": "thing.eng_api" }
	 * @example
	 * local tree = (import "@c6fc/spellcraft-plugins/module.libsonnet").utils.tree;
	 *
	 * // Where a node sits: ctx.depth is 0 at the root, ctx.index is its
	 * // position among its siblings.
	 * {
	 *   "positions.json": tree.walk({ name: "r", children: [{ name: "x" }, { name: "y" }] }, {
	 *     name(ctx):: ctx.body.name,
	 *     node(ctx):: { [ctx.name]: "%d:%d" % [ctx.depth, ctx.index] },
	 *   }),
	 * }
	 *
	 * // Returns { "positions.json": { "r": "0:0", "x": "1:0", "y": "1:1" } }
	 */
	walk(root, spec)::
		// spec.name is read through a thunk below, so a missing -- or misspelled
		// -- required hook was only "required" if something happened to force it:
		// a single-node tree whose node(ctx) ignores ctx.name succeeded outright,
		// and adding one child made the same spec fail. std.objectHasAll, because
		// hooks are conventionally written hidden (`name(ctx)::`).
		assert std.objectHasAll(spec, 'name') && std.objectHasAll(spec, 'node') :
			'tree.walk: spec requires both a name(ctx) and a node(ctx) hook.';

		local childField = std.get(spec, 'children', 'children');
		local bodyFn = std.get(spec, 'body', asWritten);
		local labelFn = std.get(spec, 'label', byName);
		local handoffFn = std.get(spec, 'handoff', passThrough);
		local refsFn = std.get(spec, 'refs', null);
		local rootFn = std.get(spec, 'root', identity);

		// Returns a flat array of { fragment, refs }, one entry per node, so
		// every hook runs exactly once and the merge happens once at the end.
		local visit(node, parentName, parentPath, inherited, depth, index) =
			local body = bodyFn(node);
			local label = labelFn(body);
			local ctx = {
				node: node,
				body: body,
				label: label,
				path: parentPath + [label],
				parentName: parentName,
				inherited: inherited,
				depth: depth,
				index: index,
			};
			local full = ctx + { name: spec.name(ctx) };
			local fragment = spec.node(full);

			// std.get's inc_hidden defaults to true, so a `children::` default
			// applied by body(node) still resolves here.
			local kids = std.get(body, childField, []);

			// A map of children keyed by name is how Terraform's own for_each idiom
			// reads, and how most existing config data is shaped -- and std.length
			// accepts an object, so this used to reach kids[i] and fail with a
			// message about object indexing that never mentioned children at all.
			assert std.isArray(kids) :
				"tree.walk: the '%s' field of node '%s' must be an array, got %s." % [
					childField, label, std.type(kids),
				];

			// merge.deep returns its right-hand side when either side is not an
			// object, so a node(ctx) returning a string collapsed the whole fold to
			// the last node's value and wrote that out -- exit 0, no diagnostic, a
			// rendered file reading literally `"b{ }"`.
			assert std.isObject(fragment) :
				"tree.walk: node(ctx) must return an object for '%s', got %s." % [label, std.type(fragment)];

			[{
				fragment: fragment,
				// Carried so the collision check below can name both the derived name
				// and the caller's own path to it.
				name: full.name,
				path: full.path,
				// refs reads its values out of `fragment` -- the same object that
				// gets merged into the tree, not a rebuilt copy. One thunk, so
				// refs adds no per-node evaluation, and the values cannot drift
				// from what was written.
				refs: if refsFn == null then {} else refsFn(full + { fragment: fragment }),
			}] + (
				if std.length(kids) > 0 then
					local handoff = handoffFn(full);
					std.flattenArrays([
						visit(kids[i], full.name, full.path, handoff, depth + 1, i)
						for i in std.range(0, std.length(kids) - 1)
					])
				else []
			);

		local visited = visit(
			root,
			std.get(spec, 'parentName', ''),
			[],
			std.get(spec, 'inherited', null),
			0,
			0,
		);

		// Derived names key the output, and the output is *merged*, not
		// concatenated -- so two nodes deriving the same name silently become one.
		// Not hypothetical: the obvious name(ctx) is `ctx.body.name`, and two teams
		// called "platform" under different parents is an ordinary tree.
		//
		// The check belongs here rather than in merge.deep, where comparing at every
		// leaf is exactly the per-level cost that node exists to avoid. This is one
		// pass over a list of strings, and the message's own O(n^2) search is lazy,
		// so it runs only when something actually collided.
		local names = [v.name for v in visited];

		assert std.length(std.set(names)) == std.length(names) :
			local collisions = std.set([
				n for n in names if std.length([m for m in names if m == n]) > 1
			]);
			'tree.walk: %s derived by more than one node, so one silently replaces another. Colliding paths: %s.' % [
				std.join(', ', ["'%s'" % n for n in collisions]),
				std.join('; ', [
					'%s <- %s' % [n, std.join(' and ', [std.join('.', v.path) for v in visited if v.name == n])]
					for n in collisions
				]),
			];

		rootFn(merge.all([v.fragment for v in visited])) + (
			// Kept beside the merge rather than inside it: merge.deep builds its
			// result by comprehension, which would make a hidden field visible.
			if refsFn == null then {}
			else { refs:: merge.shallow([v.refs for v in visited]) }
		),
}
