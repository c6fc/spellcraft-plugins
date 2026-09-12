'use strict';

// utils/tree and utils/merge are pure Jsonnet -- no natives, no credentials, no
// network -- so these need only a bare Jsonnet with the package on its jpath.
//
// The load-bearing test here is "every node is visited exactly once". The whole
// reason this node exists is that the pattern it generalises was, in its
// hand-written form, re-evaluating subtrees once per level of nesting; a walker
// that quietly reintroduced that would be worse than no walker at all.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { newJsonnet } = require('./helpers/jsonnet');


const IMPORTS = `
local utils = (import "@c6fc/spellcraft-plugins/module.libsonnet").utils;
local tree = utils.tree;
local merge = utils.merge;
`;

const evaluate = async (snippet) =>
    JSON.parse(await newJsonnet()
        .evaluateSnippet(IMPORTS + snippet));

// engineering > [production > [api, cache], staging]
const TREE = JSON.stringify({
    name: 'engineering',
    children: [
        { name: 'production', children: [{ name: 'api' }, { name: 'cache' }] },
        { name: 'staging' },
    ],
});

test('walk merges one fragment per node', async () => {
    const out = await evaluate(`
        tree.walk(${TREE}, {
            name(ctx):: '%s_%s' % [ctx.parentName, ctx.body.name],
            parentName: 'acme',
            node(ctx):: { seen: { [ctx.name]: ctx.depth } },
        })
    `);

    assert.deepStrictEqual(out.seen, {
        acme_engineering: 0,
        acme_engineering_production: 1,
        acme_engineering_production_api: 2,
        acme_engineering_production_cache: 2,
        acme_engineering_staging: 1,
    });
});

test('name accumulates derived names while path keeps the caller\'s', async () => {
    const out = await evaluate(`
        tree.walk(${TREE}, {
            name(ctx):: std.asciiUpper('%s-%s' % [ctx.parentName, ctx.body.name]),
            parentName: 'root',
            node(ctx):: { nodes: { [std.join('.', ctx.path)]: ctx.name } },
        })
    `);

    // The two accumulations are built in the same pass and stay independent:
    // path is exactly what the caller typed, name is whatever we derived.
    assert.deepStrictEqual(out.nodes, {
        'engineering': 'ROOT-ENGINEERING',
        'engineering.production': 'ROOT-ENGINEERING-PRODUCTION',
        'engineering.production.api': 'ROOT-ENGINEERING-PRODUCTION-API',
        'engineering.production.cache': 'ROOT-ENGINEERING-PRODUCTION-CACHE',
        'engineering.staging': 'ROOT-ENGINEERING-STAGING',
    });
});

test('handoff hands a parent-built value to its children only', async () => {
    const out = await evaluate(`
        tree.walk(${TREE}, {
            name(ctx):: ctx.body.name,
            inherited: 'ORG',
            handoff(ctx):: 'folder/%s' % ctx.name,
            node(ctx):: { parents: { [ctx.name]: ctx.inherited } },
        })
    `);

    assert.deepStrictEqual(out.parents, {
        engineering: 'ORG',                    // the root's own `inherited`
        production: 'folder/engineering',
        staging: 'folder/engineering',
        api: 'folder/production',
        cache: 'folder/production',
    });
});

test('handoff defaults to passing the inherited value straight down', async () => {
    const out = await evaluate(`
        tree.walk(${TREE}, {
            name(ctx):: ctx.body.name,
            inherited: 'ORG',
            node(ctx):: { parents: { [ctx.name]: ctx.inherited } },
        })
    `);

    assert.ok(Object.values(out.parents).every((v) => v === 'ORG'));
});

test('root receives the assembled tree, not one node', async () => {
    const out = await evaluate(`
        tree.walk(${TREE}, {
            name(ctx):: ctx.body.name,
            node(ctx):: { resource: { [ctx.name]: {} } },
            // The post-pass that motivated this hook: something that can only be
            // written once every node is known.
            root(built):: built + { all: std.objectFields(built.resource) },
        })
    `);

    assert.deepStrictEqual(out.all.sort(), ['api', 'cache', 'engineering', 'production', 'staging']);
});

test('body applies defaults once, and every hook sees the same object', async () => {
    const out = await evaluate(`
        tree.walk({ name: 'root', children: [{ name: 'child', tier: 'gold' }] }, {
            body(node):: { tier:: 'default', children:: [] } + node,
            name(ctx):: ctx.body.name,
            node(ctx):: { tiers: { [ctx.name]: ctx.body.tier } },
        })
    `);

    assert.deepStrictEqual(out.tiers, { root: 'default', child: 'gold' });
});

test('a hidden children:: default still resolves', async () => {
    // std.get's inc_hidden defaults to true, which is what makes the gcp
    // defaults block (children:: []) work without special-casing.
    const out = await evaluate(`
        tree.walk({ name: 'solo' }, {
            body(node):: { children:: [] } + node,
            name(ctx):: ctx.body.name,
            node(ctx):: { names: [ctx.name] },
        })
    `);

    assert.deepStrictEqual(out.names, ['solo']);
});

test('label and children are configurable', async () => {
    const out = await evaluate(`
        tree.walk({ id: 'a', kids: [{ id: 'b' }] }, {
            children: 'kids',
            label(body):: body.id,
            name(ctx):: std.join('_', ctx.path),
            node(ctx):: { seen: { [ctx.name]: std.join('.', ctx.path) } },
        })
    `);

    assert.deepStrictEqual(out.seen, { a: 'a', a_b: 'a.b' });
});

test('index is the position among siblings', async () => {
    const out = await evaluate(`
        tree.walk({ name: 'r', children: [{ name: 'x' }, { name: 'y' }, { name: 'z' }] }, {
            name(ctx):: ctx.body.name,
            node(ctx):: { idx: { [ctx.name]: ctx.index } },
        })
    `);

    assert.deepStrictEqual(out.idx, { r: 0, x: 0, y: 1, z: 2 });
});

// The guard the node exists for. A walker that merged as it recursed would stack
// a merge layer per level and re-force subtrees. Counting object keys cannot see
// that -- a merge is idempotent -- so this counts real evaluations through a
// native callback, deliberately un-memoized so every crossing is recorded.
test('every node is evaluated exactly once, at depth', async () => {
    // A chain six deep: if evaluation compounded per level, the nodes nearest
    // the root would be counted many times over.
    const chain = (d) => (d === 0 ? { name: 'leaf' } : { name: `f${d}`, children: [chain(d - 1)] });

    const seen = [];
    const jsonnet = newJsonnet()
        .nativeCallback('test:tick', (name) => { seen.push(name); return name; }, 'name');

    await jsonnet.evaluateSnippet(IMPORTS + `
        tree.walk(${JSON.stringify(chain(6))}, {
            name(ctx):: std.join('_', ctx.path),
            node(ctx):: { seen: { [std.native('test:tick')(ctx.name)]: true } },
        })
    `);

    assert.strictEqual(seen.length, 7, `seven nodes, but node() was evaluated ${seen.length} times`);
    assert.strictEqual(new Set(seen).size, 7, 'every evaluation should be a distinct node');
});

test('refs is hidden, keyed by the caller, and reads out of the fragment', async () => {
    const out = await evaluate(`
        local built = tree.walk(${TREE}, {
            name(ctx):: '%s_%s' % [ctx.parentName, ctx.body.name],
            parentName: 'acme',
            node(ctx):: { resource: { thing: { [ctx.name]: { derived: 'value-for-%s' % ctx.name } } } },
            refs(ctx):: {
                ['thing.%s' % std.join('.', ctx.path)]:
                    ctx.fragment.resource.thing[ctx.name] + { _terraform_id:: 'thing.%s' % ctx.name },
            },
        });
        {
            visible: std.objectFields(built),
            keys: std.objectFields(built.refs),
            addr: built.refs['thing.engineering.production.api']._terraform_id,
            // Rule 3: the value is the manifested object, not a rebuild.
            value: built.refs['thing.engineering.production.api'].derived,
            sameObject: built.refs['thing.engineering.production.api'].derived
                == built.resource.thing.acme_engineering_production_api.derived,
        }
    `);

    assert.deepStrictEqual(out.visible, ['resource'], 'refs must not manifest');
    assert.deepStrictEqual(out.keys, [
        'thing.engineering',
        'thing.engineering.production',
        'thing.engineering.production.api',
        'thing.engineering.production.cache',
        'thing.engineering.staging',
    ]);
    assert.strictEqual(out.addr, 'thing.acme_engineering_production_api');
    assert.strictEqual(out.value, 'value-for-acme_engineering_production_api');
    assert.ok(out.sameObject);
});

test('merge.deep merges objects and lets the right side win', async () => {
    const out = await evaluate(`{
        nested: merge.deep({ a: { x: 1, y: 2 } }, { a: { y: 3, z: 4 } }),
        disjoint: merge.deep({ a: 1 }, { b: 2 }),
        replace: merge.deep({ a: { x: 1 } }, { a: 'scalar' }),
        arrays: merge.deep({ a: [1, 2] }, { a: [3] }),
        // The difference from std.mergePatch: a null on the right is a value
        // that overwrites, not an instruction to delete the key.
        nulls: merge.deep({ a: 1, b: 2 }, { a: null }),
        patch: std.mergePatch({ a: 1, b: 2 }, { a: null }),
    }`);

    assert.deepStrictEqual(out.nested, { a: { x: 1, y: 3, z: 4 } });
    assert.deepStrictEqual(out.disjoint, { a: 1, b: 2 });
    assert.deepStrictEqual(out.replace, { a: 'scalar' });
    assert.deepStrictEqual(out.arrays, { a: [3] }, 'arrays replace, they do not concatenate');
    assert.deepStrictEqual(out.nulls, { a: null, b: 2 });
    assert.deepStrictEqual(out.patch, { b: 2 }, 'std.mergePatch deletes it -- the semantics we dropped');
});

test('merge.all and merge.shallow fold a list', async () => {
    const out = await evaluate(`{
        all: merge.all([{ a: { x: 1 } }, { a: { y: 2 } }, { b: 3 }]),
        allEmpty: merge.all([]),
        shallow: merge.shallow([{ a: { x: 1 } }, { a: { y: 2 } }, { b: 3 }]),
    }`);

    assert.deepStrictEqual(out.all, { a: { x: 1, y: 2 }, b: 3 });
    assert.deepStrictEqual(out.allEmpty, {});
    // Shallow replaces the whole value rather than merging into it.
    assert.deepStrictEqual(out.shallow, { a: { y: 2 }, b: 3 });
});
