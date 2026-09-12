// The Jsonnet face of this node. Pure Jsonnet -- there is no index.js here and
// no native functions to reach.
//
// This file is the node's whole object. Doc comments below are lifted into
// README.md by `npx spellcraft doc`.
//
// -----------------------------------------------------------------------------
// Why this node exists: do not reach for std.mergePatch.
//
// Jsonnet's stdlib has no std.deepMerge, so std.mergePatch is the obvious thing
// to grab when you want one. It is a trap, and an expensive one. It computes the
// key set of its result through
//
//     local null_fields = [k for k in std.objectFields(patch) if patch[k] == null];
//     ... for k in std.setDiff(both_fields, null_fields)
//
// and Jsonnet evaluates a comprehension's key set *eagerly*, at construction. So
// merely constructing a merge force-evaluates a whole level of the patch; each
// field of the result is another mergePatch whose construction forces the next
// level down; and because function calls are not memoized, every merge layer
// stacked over a subtree re-triggers that walk.
//
// Anything that merges once per level of a recursive structure therefore pays a
// compounding cost. gcp.terraform's googleOrgProject() did exactly that: a
// three-node tree cost 21.3s and 1214 native calls, against 1.0s and 41 with the
// merge below. Isolated by cloning std.mergePatch and removing only the
// null_fields line, which alone took it to 1.09s.
//
// JSON-merge-patch's null-deletion semantics are the only thing that scan buys.
// If you do not need a null on the right-hand side to *delete* a key, you do not
// need std.mergePatch.
// -----------------------------------------------------------------------------
{
	/**
	 * Deep-merges two objects, with the right-hand side winning at the leaves.
	 *
	 * Where both sides hold an object at the same key, the two are merged
	 * recursively; anywhere else `b` replaces `a`. Unlike `std.mergePatch`, a
	 * `null` in `b` is an ordinary value that overwrites, not an instruction to
	 * delete the key — which is what makes this cheap enough to use inside a
	 * recursion. See the note at the top of this file.
	 *
	 * Hidden fields are not carried across: the result is built by a
	 * comprehension, and `std.objectFields` sees only visible fields. Keep
	 * anything hidden — a `refs::` map, for instance — beside the merge rather
	 * than inside it.
	 *
	 * @param {object} a - the base object
	 * @param {object} b - the object merged over it
	 * @returns {object} the merged result
	 * @example
	 * local merge = (import "@c6fc/spellcraft-plugins/module.libsonnet").utils.merge;
	 *
	 * { "merged.json": merge.deep({ a: { x: 1, y: 2 } }, { a: { y: 3 } }) }
	 *
	 * // Returns { "a": { "x": 1, "y": 3 } }
	 */
	deep(a, b)::
		if std.isObject(a) && std.isObject(b) then
			{
				[k]:
					if !std.objectHas(a, k) then b[k]
					else if !std.objectHas(b, k) then a[k]
					else $.deep(a[k], b[k]) tailstrict
				for k in std.setUnion(std.objectFields(a), std.objectFields(b))
			}
		else b,

	/**
	 * Deep-merges a list of objects, left to right.
	 *
	 * A left fold is deliberate. A balanced divide-and-conquer merge was measured
	 * against it on a 40-node tree and made no difference (20.9s vs 21.2s), so the
	 * simpler shape stays.
	 *
	 * @param {object[]} objs - the objects to merge
	 * @returns {object} the merged result, or `{}` for an empty list
	 * @example
	 * local merge = (import "@c6fc/spellcraft-plugins/module.libsonnet").utils.merge;
	 *
	 * { "merged.json": merge.all([{ a: 1 }, { b: 2 }, { a: 3 }]) }
	 *
	 * // Returns { "a": 3, "b": 2 }
	 */
	all(objs)::
		local aux(arr, i, running) =
			if i >= std.length(arr) then running
			else aux(arr, i + 1, $.deep(running, arr[i])) tailstrict;
		aux(objs, 0, {}),

	/**
	 * Merges a list of objects one level deep, left to right.
	 *
	 * For flat maps whose keys are already fully qualified — a `refs` map keyed
	 * by `"<type>.<name path>"`, say — where a deep merge would be wasted work
	 * and a collision would mean two things share an address anyway.
	 *
	 * @param {object[]} objs - the objects to merge
	 * @returns {object} the merged result, or `{}` for an empty list
	 * @example
	 * local merge = (import "@c6fc/spellcraft-plugins/module.libsonnet").utils.merge;
	 *
	 * { "merged.json": merge.shallow([{ a: { x: 1 } }, { b: 2 }]) }
	 *
	 * // Returns { "a": { "x": 1 }, "b": 2 }
	 */
	shallow(objs)::
		std.foldl(function(acc, o) acc + o, objs, {}),
}
