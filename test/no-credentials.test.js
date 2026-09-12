'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SpellFrame } = require('@c6fc/spellcraft');

const PACKAGE = path.resolve(__dirname, '..');

// A throwaway spell whose only dependency is this package, wired the way npm
// would wire it.
function spell(config = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spellcraft-plugins-'));

    fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'a-spell', version: '0.0.0', dependencies: { '@c6fc/spellcraft-plugins': '*' }, ...config }),
    );

    fs.mkdirSync(path.join(dir, 'node_modules', '@c6fc'), { recursive: true });
    fs.symlinkSync(PACKAGE, path.join(dir, 'node_modules', '@c6fc', 'spellcraft-plugins'), 'dir');

    return dir;
}

// Only actual code counts. Core's plugin discovery require()s every
// dependency's package.json to look for the "spellcraft" flag, so a cached
// package.json under node_modules/aws-sdk is not evidence the SDK was loaded.
const sdkLoaded = (name) =>
    Object.keys(require.cache).some(
        (k) => k.includes(path.join('node_modules', name, path.sep)) && k.endsWith('.js'),
    );

test('a spell that touches no cloud renders without credentials', async () => {
    // This is the failure mode collapsing seven packages into one would
    // otherwise have introduced. Core runs every loaded plugin's init()
    // unconditionally, and both auth nodes used to resolve credentials there --
    // gcp/auth by throwing outright when no project is bound. An AWS-only spell,
    // or a spell using neither provider, would have failed on every render.
    const dir = spell();
    const frame = new SpellFrame({ baseDir: dir, renderPath: path.join(dir, 'render') });

    await frame.init();

    const rendered = await frame.renderString(`
        local plugins = import "@c6fc/spellcraft-plugins/module.libsonnet";
        {
            "main.tf.json": {
                resource: {
                    null_resource: {
                        // A bucket built entirely from defaults still calls no
                        // native, so this exercises the tree without a provider.
                        example: {},
                    },
                },
            },
            "nodes.txt": std.join(",", std.objectFields(plugins)),
        }`);

    assert.deepStrictEqual(Object.keys(rendered).sort(), ['main.tf.json', 'nodes.txt']);
    assert.strictEqual(rendered['nodes.txt'], 'aws,gcp,terraform,utils');

    assert.ok(!sdkLoaded('aws-sdk'), 'aws-sdk loaded during a cloud-free render');
    assert.ok(!sdkLoaded('googleapis'), 'googleapis loaded during a cloud-free render');
});

test('the plugin loads as one plugin, with every native registered', async () => {
    const dir = spell();
    const frame = new SpellFrame({ baseDir: dir, renderPath: path.join(dir, 'render') });

    assert.deepStrictEqual([...frame.loadedPlugins.keys()], ['@c6fc/spellcraft-plugins']);
    assert.deepStrictEqual(frame.loadedPlugins.get('@c6fc/spellcraft-plugins').requires, []);

    // The .tf handler the terraform node contributes survived the metadata merge.
    assert.ok(Object.keys(frame.fileTypeHandlers).includes('.*?\\.tf$'));

    // All five CLI commands are still offered, from three different nodes.
    const commands = [];
    const yargs = { command: (name) => (commands.push(name.split(' ')[0]), yargs) };
    frame.cliExtensions.forEach((fn) => fn(yargs, frame));

    assert.deepStrictEqual(commands.sort(), [
        'aws-exportcredentials',
        'aws-identity',
        'gcp-identity',
        'terraform-apply',
        'terraform-destroy',
    ]);
});

test('config.spellcraftProject seeds the project name without calling out', async () => {
    // It used to bootstrap during init(), which made merely invoking the CLI
    // create an S3 bucket -- and gave two provider nodes reading the same key
    // nothing to tell them apart. Seeding is a file read, so both can do it.
    const dir = spell({ config: { spellcraftProject: 'seeded-project' } });
    const frame = new SpellFrame({ baseDir: dir, renderPath: path.join(dir, 'render') });

    await frame.init();

    assert.strictEqual(frame.functionContext.awsterraform.projectName, 'seeded-project');
    assert.strictEqual(frame.functionContext.gcpterraform.projectName, 'seeded-project');

    assert.ok(!sdkLoaded('aws-sdk'), 'seeding a project name loaded aws-sdk');
    assert.ok(!sdkLoaded('googleapis'), 'seeding a project name loaded googleapis');
});
