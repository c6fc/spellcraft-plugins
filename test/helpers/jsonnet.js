'use strict';

/*
 * One Jsonnet factory for the whole suite, because building the search path is
 * not as simple as it looks.
 *
 * Every fixture imports this package by name --
 * `import "@c6fc/spellcraft-plugins/module.libsonnet"` -- which is what a real
 * spell writes, and what makes these tests exercise the same resolution a
 * consumer gets. But npm never links a package into its own node_modules. In the
 * dev overlay that is papered over: the workspace root has a
 * node_modules/@c6fc/spellcraft-plugins symlink, so pointing jpath at the
 * *parent* directory's node_modules happened to work, and every test file did
 * exactly that with `path.resolve(__dirname, '..', '..')`.
 *
 * In a standalone clone that resolves to the directory *containing* the clone,
 * which has no node_modules at all and certainly no link back to us -- so
 * `git clone && npm install && npm test` failed on every fixture. Nothing was
 * wrong with the tests; they were reading a path that only exists in one layout.
 *
 * So build the path explicitly instead of relying on where the package happens
 * to sit: every real node_modules from here upward (the same set, in the same
 * order, core puts on jpath), plus a scratch directory holding the self-link npm
 * will not create. scripts/check-docs.js builds its sandbox the same way.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Jsonnet } = require('@hanazuki/node-jsonnet');

const PACKAGE = path.resolve(__dirname, '..', '..');
const NAME = require(path.join(PACKAGE, 'package.json')).name;

// Every existing node_modules from `from` upward, nearest first.
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

// The self-link, made once per process and reused. Named after the package so
// two checkouts under one tmpdir cannot collide.
let selfLinkDir = null;

function selfLink() {
    if (selfLinkDir) return selfLinkDir;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spellcraft-plugins-jpath-'));
    const scope = path.join(dir, path.dirname(NAME));

    fs.mkdirSync(scope, { recursive: true });
    fs.symlinkSync(PACKAGE, path.join(dir, NAME), 'dir');

    selfLinkDir = dir;
    return dir;
}

// A Jsonnet instance that can resolve this package by name, in either layout.
function newJsonnet() {
    return [selfLink(), ...nodeModulesPaths(PACKAGE)].reduce(
        (jsonnet, dir) => jsonnet.addJpath(dir),
        new Jsonnet(),
    );
}

module.exports = { newJsonnet, PACKAGE };
