# plugins.utils.merge

Deep-merging for [SpellCraft](https://github.com/c6fc/spellcraft), without the
performance trap in `std.mergePatch`.

[![NPM version](https://img.shields.io/npm/v/@c6fc/spellcraft-plugins.svg?style=flat)](https://www.npmjs.com/package/@c6fc/spellcraft-plugins)
[![License](https://img.shields.io/npm/l/@c6fc/spellcraft-plugins.svg?style=flat)](https://opensource.org/licenses/MIT)

Pure Jsonnet — no native functions, nothing to authenticate, no network.

```bash
npm install --save @c6fc/spellcraft-plugins
```

## Why this exists

Jsonnet's standard library has no `std.deepMerge`, so `std.mergePatch` is what
you reach for when you want one. It is a trap, and an expensive one.

`std.mergePatch` implements JSON Merge Patch, where a `null` on the right means
*delete this key*. Honouring that requires knowing which of the patch's values
are null, and it computes that as part of the result's key set:

```
local null_fields = [k for k in std.objectFields(patch) if patch[k] == null];
... for k in std.setDiff(both_fields, null_fields)
```

Jsonnet evaluates a comprehension's key set **eagerly, at construction**. So
merely *constructing* a merge force-evaluates a whole level of the patch. Each
field of the result is another `mergePatch` whose construction forces the next
level down, and because function calls are not memoized, every merge layer
stacked over a subtree re-triggers that walk.

Anything that merges once per level of a recursive structure therefore pays a
compounding cost. `gcp.terraform`'s `googleOrgProject()` did exactly that:

| nesting | `std.mergePatch` | `merge.deep` |
|---|---|---|
| `folder>project` | 10.1s | 1.4s |
| depth 2 | 28.3s | 1.8s |
| depth 3 | 65.3s | 2.1s |
| depth 4 | 130.4s | 2.6s |

Isolated by cloning `std.mergePatch` and removing only the `null_fields` line,
which alone took a three-node tree from 21.3s to 1.09s.

**If you do not need a `null` on the right-hand side to delete a key, you do not
need `std.mergePatch`.**

## Two things to know

**Nulls are ordinary values.** `merge.deep({a: 1}, {a: null})` gives
`{a: null}`, where `std.mergePatch` gives `{}`. That is the whole semantic
difference, and it is the one that buys the speed.

**Hidden fields do not survive.** The result is built by a comprehension, and
`std.objectFields` sees only visible fields. Keep anything hidden — a `refs::`
map, say — beside the merge rather than inside it:

```jsonnet
local merge = (import "@c6fc/spellcraft-plugins/module.libsonnet").utils.merge;

local a = { resource: { x: 1 }, refs:: { one: 1 } };
local b = { resource: { y: 2 }, refs:: { two: 2 } };

{
	// refs is carried explicitly; merging alone would drop it.
	"merged.json": merge.deep(a, b) + { refs:: a.refs + b.refs },
}
```

<!-- SPELLCRAFT_DOCS_API_START -->
## API Reference

### `deep(a, b)`

Deep-merges two objects, with the right-hand side winning at the leaves.

Where both sides hold an object at the same key, the two are merged
recursively; anywhere else `b` replaces `a`. Unlike `std.mergePatch`, a
`null` in `b` is an ordinary value that overwrites, not an instruction to
delete the key — which is what makes this cheap enough to use inside a
recursion. See the note at the top of this file.

Hidden fields are not carried across: the result is built by a
comprehension, and `std.objectFields` sees only visible fields. Keep
anything hidden — a `refs::` map, for instance — beside the merge rather
than inside it.

- param {object} a - the base object
- param {object} b - the object merged over it
- returns {object} the merged result

**Examples:**

```jsonnet
local merge = (import "@c6fc/spellcraft-plugins/module.libsonnet").utils.merge;

{ "merged.json": merge.deep({ a: { x: 1, y: 2 } }, { a: { y: 3 } }) }

// Returns { "a": { "x": 1, "y": 3 } }
```

---
### `all(objs)`

Deep-merges a list of objects, left to right.

A left fold is deliberate. A balanced divide-and-conquer merge was measured
against it on a 40-node tree and made no difference (20.9s vs 21.2s), so the
simpler shape stays.

- param {object[]} objs - the objects to merge
- returns {object} the merged result, or `{}` for an empty list

**Examples:**

```jsonnet
local merge = (import "@c6fc/spellcraft-plugins/module.libsonnet").utils.merge;

{ "merged.json": merge.all([{ a: 1 }, { b: 2 }, { a: 3 }]) }

// Returns { "a": 3, "b": 2 }
```

---
### `shallow(objs)`

Merges a list of objects one level deep, left to right.

For flat maps whose keys are already fully qualified — a `refs` map keyed
by `"<type>.<name path>"`, say — where a deep merge would be wasted work
and a collision would mean two things share an address anyway.

- param {object[]} objs - the objects to merge
- returns {object} the merged result, or `{}` for an empty list

**Examples:**

```jsonnet
local merge = (import "@c6fc/spellcraft-plugins/module.libsonnet").utils.merge;

{ "merged.json": merge.shallow([{ a: { x: 1 } }, { b: 2 }]) }

// Returns { "a": { "x": 1 }, "b": 2 }
```

---

<!-- SPELLCRAFT_DOCS_API_END -->

## Maintaining this file

Everything between the API markers above is generated from the doc comments in
`module.libsonnet`. Edit those, not the generated section:

```bash
npm run doc     # regenerates the API section above from module.libsonnet
```
