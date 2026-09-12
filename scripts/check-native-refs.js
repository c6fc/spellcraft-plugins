#!/usr/bin/env node
'use strict';

/*
 * Cross-plugin contract check.
 *
 * Every plugin exposes native JavaScript functions to Jsonnet as
 * "<package-name>:<export>", and its Jsonnet calls them through
 * std.native("..."). Nothing enforces that those two sides agree, so a renamed
 * or never-written export fails only at manifestation time, with a Jsonnet
 * runtime error that points at the caller rather than the cause.
 *
 * This walks every workspace member, loads its entry point the way SpellFrame
 * does, and confirms each std.native() reference in *every* module.libsonnet it
 * ships resolves -- either to one of its own exports, or to an export of a
 * package it actually declares as a dependency.
 *
 * @c6fc/spellcraft-plugins ships a tree of them rather than one file, so two
 * further rules apply to any package whose layout is a tree:
 *
 *   - Tree completeness: every directory holding a module.libsonnet is imported
 *     by its parent's module.libsonnet, and every relative import points at a
 *     file that exists. This is the one manual step the layout leaves -- adding
 *     a child means adding a line to its parent -- so it is checked rather than
 *     left to discipline.
 *   - Node list agreement: every directory holding an index.js appears in the
 *     root's declared `_spellcraft_metadata.nodes`, and every entry there exists on disk.
 *
 * Shadowing between a node's own API and its children needs no check: they live
 * in one object literal, and Jsonnet rejects a duplicate field statically
 * (including hidden-vs-visible), so a collision is a parse error, not a silent
 * overwrite.
 *
 * No credentials, no network, no init(): loading a module never makes cloud
 * calls, so this is safe to run anywhere.
 *
 * Usage:  npm run check
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname ? path.resolve(__dirname, '..') : process.cwd();

// Read members from the workspace itself, so parking a package in package.json
// automatically removes it from this check. A package.json with no `workspaces`
// key is its own only member -- which is what this script sees when it runs from
// a standalone clone of the package rather than through the dev overlay.
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const members = Array.isArray(rootPkg.workspaces)
    ? rootPkg.workspaces.filter((m) => m !== 'spellcraft')
    : ['.'];

// Every existing node_modules directory from `from` upward, nearest first -- the
// same set, in the same order, core puts on Jsonnet's search path.
function nodeModulesPaths(from) {
    const found = [];
    let current = path.resolve(from);

    while (true) {
        if (path.basename(current) !== 'node_modules') {
            const candidate = path.join(current, 'node_modules');
            if (fs.existsSync(candidate)) found.push(candidate);
        }

        const parent = path.dirname(current);
        if (parent === current) return found;
        current = parent;
    }
}

// Every module.libsonnet the package ships, root first. A single-file plugin
// yields exactly one, so everything below is a no-op for those.
function findLibsonnet(dir) {
    const found = [];

    const walk = (current) => {
        const lib = path.join(current, 'module.libsonnet');
        if (fs.existsSync(lib)) found.push(lib);

        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            if (entry.name === 'test' || entry.name === 'render' || entry.name === 'scripts') continue;
            walk(path.join(current, entry.name));
        }
    };

    walk(dir);
    return found;
}

// A node is only reachable if its parent names it. Checked in both directions:
// every relative import resolves to a real file, and every directory holding a
// module.libsonnet is imported by the directory above it.
function checkTree(dir, libs) {
    let failed = 0;

    const imported = new Set();

    for (const lib of libs) {
        const base = path.dirname(lib);
        const source = fs.readFileSync(lib, 'utf8');

        for (const [, target] of source.matchAll(/\bimport\s+["'](\.[^"']+)["']/g)) {
            const resolved = path.resolve(base, target);

            if (!fs.existsSync(resolved)) {
                console.log(`  FAIL  ${path.relative(dir, lib)} imports ${target}, which does not exist`);
                failed++;
                continue;
            }

            imported.add(resolved);
        }
    }

    for (const lib of libs.slice(1)) {
        if (imported.has(lib)) continue;

        console.log(
            `  FAIL  ${path.relative(dir, lib)} is not imported by its parent -- ` +
                `add it to ${path.relative(dir, path.join(path.dirname(path.dirname(lib)), 'module.libsonnet'))}`,
        );
        failed++;
    }

    if (failed === 0 && libs.length > 1) {
        console.log(`  ok    tree of ${libs.length} nodes, every child reachable from its parent`);
    }

    return failed;
}

// In a package built as a tree, a native exists to be called from Jsonnet. One
// that no module.libsonnet references is either dead or broken and cannot be
// noticed any other way -- the ref check only runs in the other direction.
// Scoped to `_nodes` packages: a single-file plugin may legitimately export
// something for a JS consumer.
function checkUnreferenced(mod, registered, refs) {
    if (!Array.isArray(mod._spellcraft_metadata?.nodes)) return 0;

    let failed = 0;
    const called = new Set(refs.map((ref) => ref.slice(ref.lastIndexOf(':') + 1)));

    for (const fn of registered) {
        if (called.has(fn)) continue;
        console.log(`  FAIL  ${fn} -- exported, but no module.libsonnet calls it`);
        failed++;
    }

    return failed;
}

// A package that aggregates several node entry points declares them in
// `_spellcraft_metadata.nodes`. A directory with an index.js that is missing from that list would
// have its natives silently unregistered.
function checkNodeList(dir, mod) {
    const nodes = mod._spellcraft_metadata?.nodes;
    if (!Array.isArray(nodes)) return 0;

    let failed = 0;

    const declared = new Set(nodes);
    const onDisk = new Set();

    const walk = (current, prefix) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            if (entry.name === 'test' || entry.name === 'render' || entry.name === 'scripts') continue;

            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (fs.existsSync(path.join(current, entry.name, 'index.js'))) onDisk.add(rel);

            walk(path.join(current, entry.name), rel);
        }
    };

    walk(dir, '');

    for (const node of onDisk) {
        if (declared.has(node)) continue;
        console.log(`  FAIL  ${node}/index.js exists but is missing from _spellcraft_metadata.nodes -- its natives are unregistered`);
        failed++;
    }

    for (const node of declared) {
        if (onDisk.has(node)) continue;
        console.log(`  FAIL  _spellcraft_metadata.nodes lists ${node}, which has no index.js on disk`);
        failed++;
    }

    if (failed === 0) {
        console.log(`  ok    node list agrees with the ${onDisk.size} node entry points on disk`);
    }

    return failed;
}

// `files` is a hand-maintained whitelist, so a new node directory ships only if
// somebody remembers to add it -- exactly the manual step this layout exists to
// remove, and it failed silently once already. `utils/` was absent from the
// whitelist, so `npm pack` dropped it and `googleOrgProject()`, which reaches it
// through utils.tree and utils.merge, would have died in a consumer's render.
// Nothing caught it, because Jsonnet imports are lazy: the tarball's
// module.libsonnet imports fine and even lists its fields. Only forcing the thunk
// fails, so the break surfaces at the one call that matters rather than at load.
//
// So ask npm what it would actually ship, rather than re-implementing its glob
// rules, and hold the answer against what is on disk. One direction only: every
// file the tree needs must be in the tarball. There is no check that a given
// file is *absent*, because nothing here is deliberately withheld.
function checkPackaging(dir, libs) {
    let failed = 0;

    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (!Array.isArray(pkg.files)) {
        console.log('  SKIP  no "files" whitelist; npm ships everything not ignored');
        return 0;
    }

    let shipped;
    try {
        const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
            cwd: dir,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        shipped = new Set(JSON.parse(out)[0].files.map((f) => f.path));
    } catch (e) {
        console.log(`  FAIL  could not determine tarball contents: ${String(e.message).split('\n')[0]}`);
        return 1;
    }

    // What the package needs at runtime, derived from the tree rather than listed:
    // every node's facade, its entry point where it has one, and its README --
    // the shipped READMEs link to each other by relative path.
    const required = new Set();
    for (const lib of libs) {
        const node = path.dirname(lib);
        required.add(path.relative(dir, lib));

        for (const name of ['index.js', 'README.md']) {
            const file = path.join(node, name);
            if (fs.existsSync(file)) required.add(path.relative(dir, file));
        }
    }

    for (const file of [...required].sort()) {
        if (shipped.has(file)) continue;
        console.log(`  FAIL  ${file} is on disk but not in the tarball -- add its directory to "files"`);
        failed++;
    }

    if (failed === 0) {
        console.log(`  ok    tarball ships all ${required.size} tree files`);
    }

    return failed;
}

let failures = 0;
let checked = 0;
const allLibsonnet = [];

for (const member of members) {
    const dir = path.join(ROOT, member);
    const manifestPath = path.join(dir, 'package.json');

    if (!fs.existsSync(manifestPath)) {
        console.log(`\n${member}\n  FAIL  no package.json`);
        failures++;
        continue;
    }

    const pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const name = pkg.name;

    console.log(`\n${name}`);

    if (pkg.spellcraft !== true) {
        console.log('  FAIL  missing "spellcraft": true -- core will never auto-load this plugin');
        failures++;
    }

    // Load the entry point and collect what SpellFrame.loadPlugin would register.
    let mod;
    try {
        mod = require(path.join(dir, pkg.main || 'index.js'));
    } catch (e) {
        console.log(`  FAIL  ${pkg.main || 'index.js'} failed to load: ${e.message}`);
        failures++;
        continue;
    }

    const registered = new Set(
        Object.keys(mod).filter(
            (k) => k !== '_spellcraft_metadata' && (Array.isArray(mod[k]) || typeof mod[k] === 'function'),
        ),
    );

    // Declared inter-plugin requirements must actually be declared as deps too.
    const deps = { ...pkg.dependencies, ...pkg.peerDependencies };
    for (const req of mod._spellcraft_metadata?.requires || []) {
        if (!deps[req]) {
            console.log(`  FAIL  _spellcraft_metadata.requires lists ${req}, which is not a declared dependency`);
            failures++;
        }
    }

    const libs = findLibsonnet(dir);
    if (libs.length === 0) {
        console.log('  SKIP  no module.libsonnet');
        continue;
    }

    failures += checkTree(dir, libs);
    failures += checkNodeList(dir, mod);
    failures += checkPackaging(dir, libs);

    for (const lib of libs) allLibsonnet.push({ member, lib });

    const refs = [
        ...new Set(
            libs.flatMap((lib) => [
                ...fs.readFileSync(lib, 'utf8').matchAll(/std\.native\(\s*["']([^"']+)["']\s*\)/g),
            ].map((m) => m[1])),
        ),
    ];

    if (refs.length === 0) {
        console.log(`  ok    pure Jsonnet across ${libs.length} file(s), no native calls (registers ${registered.size})`);
        continue;
    }

    failures += checkUnreferenced(mod, registered, refs);

    for (const ref of refs) {
        const split = ref.lastIndexOf(':');
        const owner = ref.slice(0, split);
        const fn = ref.slice(split + 1);
        checked++;

        if (owner === name) {
            if (registered.has(fn)) {
                console.log(`  ok    ${fn}`);
            } else {
                console.log(`  FAIL  ${fn} -- referenced by module.libsonnet but not exported`);
                failures++;
            }
            continue;
        }

        if (!deps[owner]) {
            console.log(`  FAIL  ${fn} -- from ${owner}, which is not a declared dependency`);
            failures++;
            continue;
        }

        try {
            // Resolve from the depending package so workspace links are honoured.
            const other = require(require.resolve(owner, { paths: [dir] }));
            if (Object.keys(other).includes(fn)) {
                console.log(`  ok    ${fn} (from ${owner})`);
            } else {
                console.log(`  FAIL  ${fn} -- ${owner} does not export it`);
                failures++;
            }
        } catch (e) {
            console.log(`  FAIL  ${fn} -- ${owner} failed to load: ${e.message}`);
            failures++;
        }
    }
}

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

// Every module.libsonnet must actually parse -- the ref scan above is a regex and
// will happily "resolve" references inside a file Jsonnet cannot read. The way
// this breaks in practice is a doc comment: `/** ... */` blocks do not nest, so a
// `/* ... */` placeholder written inside an @example terminates the doc comment
// early and corrupts everything after it. Forcing the field names evaluates the
// file and any import it needs to produce them, without calling a single native.
(async () => {
    const { Jsonnet } = require('@hanazuki/node-jsonnet');

    for (const { member, lib } of allLibsonnet) {
        const jsonnet = nodeModulesPaths(path.dirname(fs.realpathSync(lib)))
            .reduce((acc, dir) => acc.addJpath(dir), new Jsonnet());

        try {
            await jsonnet.evaluateSnippet(
                `std.length(std.objectFieldsAll(import ${JSON.stringify(path.resolve(lib))}))`,
            );
        } catch (e) {
            const detail = String(e.message).split('\n').find((line) => line.includes('ERROR')) || e.message;
            console.log(`\n${member}\n  FAIL  ${path.relative(path.join(ROOT, member), lib)} does not parse: ${detail.trim()}`);
            failures++;
        }
    }

    console.log(
        failures === 0
            ? `\nAll ${plural(checked, 'native reference')} across ${plural(members.length, 'package')} resolve, ` +
                  `and all ${plural(allLibsonnet.length, 'module.libsonnet')} parse.`
            : `\n${plural(failures, 'problem')} found.`,
    );

    process.exit(failures ? 1 : 0);
})();
