# plugins.utils.tree

Turn a nested structure into flat configuration, in one pass, for
[SpellCraft](https://github.com/c6fc/spellcraft).

[![NPM version](https://img.shields.io/npm/v/@c6fc/spellcraft-plugins.svg?style=flat)](https://www.npmjs.com/package/@c6fc/spellcraft-plugins)
[![License](https://img.shields.io/npm/l/@c6fc/spellcraft-plugins.svg?style=flat)](https://opensource.org/licenses/MIT)

Pure Jsonnet — no native functions, nothing to authenticate, no network.

```bash
npm install --save @c6fc/spellcraft-plugins
```

## The shape this generalises

A caller writes a tree. Each node becomes some configuration whose names, parent
references and dependency wiring are derived from *where it sits* in that tree.
That is `gcp.terraform.googleOrgProject()`, and it is the shape of most
hierarchy-to-configuration problems: org units, account structures, network
hierarchies, anything where a child needs to point at what its parent declared.

`walk()` owns the traversal, the name accumulation and the assembly. You supply
what a node *becomes*.

```jsonnet
local tree = (import "@c6fc/spellcraft-plugins/module.libsonnet").utils.tree;

{
	"org.tf.json": tree.walk({
		name: "engineering",
		children: [
			{ name: "production", children: [{ name: "api" }] },
			{ name: "staging" },
		],
	}, {
		parentName: "acme",
		inherited: "organizations/123456789",

		// Names accumulate down the tree: acme_engineering,
		// acme_engineering_production, acme_engineering_production_api.
		name(ctx):: "%s_%s" % [ctx.parentName, ctx.body.name],

		// What this node's children inherit -- here, a reference to the folder
		// this node just declared, which is how a child points at its parent.
		handoff(ctx):: "folders/${google_folder.%s.folder_id}" % ctx.name,

		node(ctx):: {
			resource: { google_folder: { [ctx.name]: {
				display_name: ctx.body.name,
				parent: ctx.inherited,
			} } },
		},
	}),
}
```

## The four hooks

Each corresponds to a decision the traversal cannot make for you.

| hook | decides |
|---|---|
| `name(ctx)` | what this node is called, usually built from `ctx.parentName` |
| `node(ctx)` | what this node emits |
| `handoff(ctx)` | what this node's children inherit |
| `root(built)` | anything computable only once the whole tree is assembled |

`root(built)` is the one that is easy to overlook and hard to live without. It
receives the merged tree, so a post-pass over everything that was built — a
completion marker that depends on every resource, an index, a summary — is a
plain expression rather than a second traversal:

```jsonnet
local tree = (import "@c6fc/spellcraft-plugins/module.libsonnet").utils.tree;

{
	"org.tf.json": tree.walk({ name: "a", children: [{ name: "b" }] }, {
		name(ctx):: std.join("_", ctx.path),
		node(ctx):: { resource: { thing: { [ctx.name]: { id: ctx.name } } } },

		root(built):: built + {
			resource+: { marker: { all: {
				depends_on: ["thing.%s" % n for n in std.objectFields(built.resource.thing)],
			} } },
		},
	}),
}
```

## Two names, one pass

Every node gets both an accumulated **derived** name and the accumulated
**caller-facing** path:

- `ctx.name` is whatever `name(ctx)` built — normalized, prefixed, hashed.
- `ctx.path` is an array of exactly what the caller typed, underived.

Keeping both is the point. `ctx.name` is what Terraform sees; `ctx.path` is what
a *caller* can construct without knowing your naming scheme, which is what makes
it usable as a `refs` key. See `refs-pattern.md` in the repository root.

```jsonnet
local tree = (import "@c6fc/spellcraft-plugins/module.libsonnet").utils.tree;

local built = tree.walk({ name: "engineering", children: [{ name: "api" }] }, {
	name(ctx):: std.asciiUpper(std.join("_", ctx.path)),
	node(ctx):: { resource: { thing: { [ctx.name]: { id: ctx.name } } } },

	// The key is the caller's; the value is read out of what was actually
	// built, with the address they could not have derived.
	refs(ctx):: {
		["thing.%s" % std.join(".", ctx.path)]:
			ctx.fragment.resource.thing[ctx.name]
			+ { _terraform_id:: "thing.%s" % ctx.name },
	},
});

{
	// refs is hidden, so it never reaches the rendered file.
	"out.json": built,
	"lookup.json": { api: built.refs["thing.engineering.api"]._terraform_id },
}
```

## Performance

Two properties, both measured rather than assumed, and both worth preserving if
you change this file:

**Every node is visited exactly once.** Fragments are collected into a flat list
and merged once at the end. Merging as the recursion unwinds stacks a merge
layer per level of the tree, which is precisely how this pattern became
unusable in `googleOrgProject()` before it was fixed — a three-node tree cost
21.3s. `test/utils-tree.test.js` counts evaluations through a native callback to
keep that honest.

**Nothing here prunes.** If your fragments contain empty families or nulls you
do not want, prune inside `node(ctx)`. Deciding a subtree is empty means forcing
it, so pruning is not free; keeping it in the caller means the cost is visible
and attributable rather than imposed on every consumer.

`refs(ctx)` reads its values out of `ctx.fragment` — the same object that gets
merged into the tree, not a rebuilt copy. One thunk, so adding `refs` costs no
extra per-node evaluation, and the values cannot drift from what was written.

<!-- SPELLCRAFT_DOCS_API_START -->
## API Reference

### `walk(root, spec)`

Walks a nested structure once, handing every node to your hooks and
deep-merging what they return into a single object.

This is the shape behind `gcp.terraform.googleOrgProject()`: a caller
writes a tree of nodes, and each node becomes some configuration whose
names, parent references and dependency wiring are derived from where it
sits in that tree. `walk()` owns the traversal, the name accumulation and
the assembly; you supply what a node *becomes*.

Two hooks are required — `name(ctx)` and `node(ctx)`. Everything else has a
default, and the examples below introduce them one at a time.

`ctx` carries, at every node:

| field | is |
|---|---|
| `node` | the node exactly as the caller wrote it |
| `body` | that node after `body(node)` — computed once, shared by every hook |
| `label` | this node's caller-facing name, from `label(body)` |
| `path` | `[label, ...]` from the root: the caller's own names, underived |
| `name` | this node's derived name, from `name(ctx)` |
| `parentName` | the parent's derived name |
| `inherited` | whatever the parent's `handoff(ctx)` returned |
| `depth` | `0` at the root |
| `index` | this node's position among its siblings |
| `fragment` | this node's own output — in `refs(ctx)` only |

Three pairs are easy to confuse, so they are worth separating up front:

- **`body` and `node`.** `body` transforms a node on the way *in* (applying
  defaults); `node` produces what comes *out*. One normalizes input, the
  other emits output.
- **`label` and `name`.** `label` is the name the *caller* wrote and feeds
  `ctx.path`; `name` is what *you* derived from it and keys your output.
  Both accumulate down the tree, in the same pass, independently. Because
  `name` keys a merged result, it has to be unique tree-wide — derive it
  from `ctx.path` or `ctx.parentName` rather than from the node's own name.
- **`inherited` and `handoff`.** `inherited` seeds the *root node only*;
  `handoff` computes it for every level below.

Two things worth knowing about how this is built, because both were
measured rather than assumed:

- Every node is visited exactly once, and the fragments are collected into
  a flat list and merged once at the end. Merging as the recursion unwinds
  stacks a merge layer per level of the tree, which is how the same pattern
  became unusable in `googleOrgProject()` before it was fixed.
- Nothing here prunes. If your fragments contain empty families or nulls
  you do not want, prune inside `node(ctx)` — that keeps the cost visible
  and attributable to the caller that incurs it.

- param {object} root - the top node of the structure to walk. This is the tree's root *node*; `spec.root` below is a different thing entirely, a hook that runs on the finished result.
- param {object} spec - the hooks and settings below
- param {function} spec.name - **Required.** `name(ctx)` returns this node's derived name, which is what your output is keyed by. Build it from `ctx.parentName` and names accumulate down the tree. Names must be **unique across the whole tree**: every node's output is deep-merged into one object, so two nodes deriving the same name would become one. Deriving from `ctx.path` (or from `ctx.parentName`) gives you that for free; `ctx.body.name` alone does not, since two teams called `platform` under different parents is an ordinary shape. A collision is refused, naming both paths.
- param {function} spec.node - **Required.** `node(ctx)` returns this node's contribution. Every node's return value is deep-merged into one object.
- param {function} [spec.body] - `body(node)` normalizes one node on the way in, usually by applying defaults. Its result becomes `ctx.body`, computed once per node and shared by every other hook. Defaults to the node exactly as the caller wrote it.
- param {function} [spec.handoff] - `handoff(ctx)` returns the value this node's *children* receive as `ctx.inherited` — typically a reference to whatever this node just declared, which is how a child points at its parent. Defaults to passing `ctx.inherited` straight down, so without it every node sees the same value.
- param {function} [spec.label] - `label(body)` returns this node's caller-facing name, the one accumulated into `ctx.path`. Use it when your nodes are not named by a `name` field. Defaults to `body.name`.
- param {function} [spec.refs] - `refs(ctx)` returns address entries for this node, shallow-merged across the tree into a hidden `refs` field on the result. This is the only hook whose `ctx` carries `fragment`, so values can be read out of what the node actually built.
- param {function} [spec.root] - `root(built)` receives the whole assembled tree once every node has merged, and returns the final result. For anything that needs every node at once, such as a resource depending on all the others.
- param {string} [spec.children="children"] - the field on a node holding its children. Read with `std.get`, so a hidden `children::` supplied by `body` resolves too.
- param {*} [spec.inherited=null] - what the *root node* receives as `ctx.inherited`: the value entering the tree from outside it. Every node below receives `handoff(ctx)` instead.
- param {string} [spec.parentName=""] - what the *root node* receives as `ctx.parentName`, seeding the derived-name accumulation. Every node below receives its parent's `name`.
- returns {object} every node's fragment deep-merged into one object, passed through `root(built)` if you gave one, with a hidden `refs` field if you gave `refs(ctx)`

**Examples:**

```jsonnet
local tree = (import "@c6fc/spellcraft-plugins/module.libsonnet").utils.tree;

// The two required hooks: what a node is called, and what it becomes.
// Deriving the name from `ctx.path` keeps it unique by construction, which
// is what you want: output is merged, not concatenated.
{
  "flat.json": tree.walk({ name: "eng", children: [{ name: "api" }] }, {
    name(ctx):: std.join("_", ctx.path),
    node(ctx):: { [ctx.name]: { depth: ctx.depth } },
  }),
}

// Returns { "flat.json": { "eng": { "depth": 0 }, "eng_api": { "depth": 1 } } }
```

```jsonnet
local tree = (import "@c6fc/spellcraft-plugins/module.libsonnet").utils.tree;

// `inherited` seeds the root node; `handoff` computes it for every level
// below, so a child can reference whatever its parent just declared.
{
  "folders.json": tree.walk({ name: "eng", children: [{ name: "api" }] }, {
    inherited: "organizations/123456789",
    handoff(ctx):: "folders/${google_folder.%s.folder_id}" % ctx.name,
    name(ctx):: ctx.body.name,
    node(ctx):: { [ctx.name]: { parent: ctx.inherited } },
  }),
}

// "api" gets parent "folders/${google_folder.eng.folder_id}"; the root
// keeps the organization it was seeded with.
```

```jsonnet
local tree = (import "@c6fc/spellcraft-plugins/module.libsonnet").utils.tree;

// The two accumulations, side by side. ctx.name is derived -- here
// prefixed from parentName and upper-cased -- while ctx.path stays
// exactly what the caller wrote, which is what makes it a usable key.
{
  "names.json": tree.walk({ name: "eng", children: [{ name: "api" }] }, {
    parentName: "acme",
    name(ctx):: std.asciiUpper("%s_%s" % [ctx.parentName, ctx.body.name]),
    node(ctx):: { [std.join(".", ctx.path)]: ctx.name },
  }),
}

// Returns { "names.json": { "eng": "ACME_ENG", "eng.api": "ACME_ENG_API" } }
```

```jsonnet
local tree = (import "@c6fc/spellcraft-plugins/module.libsonnet").utils.tree;

// `body` applies defaults once per node, and every hook then reads the
// same ctx.body. Declaring them hidden keeps inputs that are yours, not
// the output format's, from leaking into what you emit. ctx.node stays
// the node exactly as the caller wrote it, so you can still tell what
// they actually supplied and what merely defaulted.
{
  "tiers.json": tree.walk({ name: "root", children: [{ name: "hot", tier: "gold" }] }, {
    body(node):: { tier:: "standard", children:: [] } + node,
    name(ctx):: ctx.body.name,
    node(ctx):: { [ctx.name]: {
      tier: ctx.body.tier,
      explicit: std.objectHas(ctx.node, "tier"),
    } },
  }),
}

// Returns { "tiers.json": {
//   "root": { "tier": "standard", "explicit": false },
//   "hot":  { "tier": "gold",     "explicit": true } } }
```

```jsonnet
local tree = (import "@c6fc/spellcraft-plugins/module.libsonnet").utils.tree;

// A structure that names things its own way: `children` says which field
// holds descendants, `label` says which one names a node.
{
  "units.json": tree.walk({ id: "eng", units: [{ id: "api" }] }, {
    children: "units",
    label(body):: body.id,
    name(ctx):: std.join("-", ctx.path),
    node(ctx):: { [ctx.name]: { label: ctx.label } },
  }),
}

// Keyed by the derived name, carrying the caller's label:
// { "units.json": { "eng": { "label": "eng" }, "eng-api": { "label": "api" } } }
```

```jsonnet
local tree = (import "@c6fc/spellcraft-plugins/module.libsonnet").utils.tree;

// `root` receives the assembled tree, so a post-pass over everything that
// was built -- here a marker depending on every resource -- is a plain
// expression rather than a second traversal.
{
  "org.tf.json": tree.walk({ name: "eng", children: [{ name: "api" }] }, {
    name(ctx):: ctx.body.name,
    node(ctx):: { resource: { thing: { [ctx.name]: {} } } },
    root(built):: built + {
      resource+: { marker: { all: {
        depends_on: ["thing.%s" % n for n in std.objectFields(built.resource.thing)],
      } } },
    },
  }),
}
```

```jsonnet
local tree = (import "@c6fc/spellcraft-plugins/module.libsonnet").utils.tree;

// refs keys are the caller's path; values are read out of ctx.fragment --
// this node's own output -- so they cannot drift from what was built.
local built = tree.walk({ name: "eng", children: [{ name: "api" }] }, {
  name(ctx):: std.join("_", ctx.path),
  node(ctx):: { resource: { thing: { [ctx.name]: { id: ctx.name } } } },
  refs(ctx):: {
    ["thing.%s" % std.join(".", ctx.path)]:
      ctx.fragment.resource.thing[ctx.name]
      + { _terraform_id:: "thing.%s" % ctx.name },
  },
});

{
  // refs is hidden, so it never reaches the rendered file.
  "org.tf.json": built,
  "lookup.json": { api: built.refs["thing.eng.api"]._terraform_id },
}

// "lookup.json" is { "api": "thing.eng_api" }
```

```jsonnet
local tree = (import "@c6fc/spellcraft-plugins/module.libsonnet").utils.tree;

// Where a node sits: ctx.depth is 0 at the root, ctx.index is its
// position among its siblings.
{
  "positions.json": tree.walk({ name: "r", children: [{ name: "x" }, { name: "y" }] }, {
    name(ctx):: ctx.body.name,
    node(ctx):: { [ctx.name]: "%d:%d" % [ctx.depth, ctx.index] },
  }),
}

// Returns { "positions.json": { "r": "0:0", "x": "1:0", "y": "1:1" } }
```

---

<!-- SPELLCRAFT_DOCS_API_END -->

## Maintaining this file

Everything between the API markers above is generated from the doc comments in
`module.libsonnet`. Edit those, not the generated section:

```bash
npm run doc     # regenerates the API section above from module.libsonnet
```
