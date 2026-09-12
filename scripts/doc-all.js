#!/usr/bin/env node
'use strict';

/*
 * `spellcraft doc` regenerates one directory's README.md from the doc comments
 * in its module.libsonnet. That is exactly the granularity this package wants --
 * every node has both files -- so this just runs it once per node rather than
 * needing anything new from core.
 *
 * Usage:  npm run doc
 */

const fs = require('fs');
const path = require('path');
const DocGenerator = require('@c6fc/spellcraft/src/doc-generator');

const ROOT = path.resolve(__dirname, '..');

// Every directory holding both a module.libsonnet and a README.md. The root and
// the pure-namespace nodes (aws/, gcp/) have no doc comments to lift, so they
// are hand-written and skipped.
function nodeDirs(dir, found = []) {
    if (fs.existsSync(path.join(dir, 'module.libsonnet')) && fs.existsSync(path.join(dir, 'README.md'))) {
        found.push(dir);
    }

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        if (entry.name === 'test' || entry.name === 'scripts') continue;
        nodeDirs(path.join(dir, entry.name), found);
    }

    return found;
}

for (const dir of nodeDirs(ROOT)) {
    console.log(`\n[+] ${path.relative(ROOT, dir) || '.'}`);
    new DocGenerator(dir).generate();
}
