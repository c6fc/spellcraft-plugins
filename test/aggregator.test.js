'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const plugins = require('..');

const natives = () => Object.keys(plugins).filter((k) => !k.startsWith('_'));

test('every native is namespaced by its node path', () => {
    for (const key of natives()) {
        assert.match(key, /^[a-z]+(\.[a-z]+)*\.[A-Za-z]\w*$/, `${key} is not a dotted node path`);
    }
});

test('the collisions that made a flat namespace impossible are all resolved', () => {
    // Each of these names exists in two nodes. Under core's flat
    // "<package>:<export>" registration they would have overwritten each other.
    const collided = [
        ['aws.auth.getCallerIdentity', 'gcp.auth.getCallerIdentity'],
        ['aws.terraform.bootstrap', 'gcp.terraform.bootstrap'],
        ['aws.terraform.getArtifact', 'gcp.terraform.getArtifact'],
        ['aws.terraform.putArtifact', 'gcp.terraform.putArtifact'],
        ['aws.terraform.getBootstrapBucket', 'gcp.terraform.getBootstrapBucket'],
        ['aws.terraform.getRemoteState', 'gcp.terraform.getRemoteState'],
        ['gcp.auth.enableServices', 'gcp.terraform.enableServices'],
    ];

    for (const [a, b] of collided) {
        assert.ok(plugins[a], `${a} missing`);
        assert.ok(plugins[b], `${b} missing`);
        assert.notStrictEqual(plugins[a], plugins[b], `${a} and ${b} resolved to the same function`);
    }
});

test('internals are reachable by siblings but never registered as natives', () => {
    assert.ok(require('../aws/auth')._internal.ensureAuth, 'aws.auth exposes ensureAuth internally');
    assert.ok(require('../gcp/auth')._internal.ensureAuth, 'gcp.auth exposes ensureAuth internally');

    assert.ok(!natives().some((k) => k.includes('_internal')), 'no _internal key was re-exported');
    assert.deepStrictEqual(Object.keys(plugins).filter((k) => k.startsWith('_')), ['_spellcraft_metadata'],
        'the only underscore export is the metadata core reads');
});

test('metadata merges into the shape core consumes', () => {
    const meta = plugins._spellcraft_metadata;

    // Same flat keys the separate packages published, so anything reading
    // spellframe.functionContext keeps working.
    assert.deepStrictEqual(
        Object.keys(meta.functionContext).sort(),
        ['aws', 'awsterraform', 'gcpterraform', 'google'],
    );

    assert.ok(Array.isArray(meta.cliExtensions) && meta.cliExtensions.length > 0);
    assert.ok(Array.isArray(meta.init) && meta.init.length > 0);
    assert.ok(Object.keys(meta.fileTypeHandlers).includes('.*?\\.tf$'), 'the terraform node still claims .tf');

    // Nothing external is left to require -- the auth nodes are siblings now.
    assert.ok(!meta.requires, 'no cross-package requires remain');
});

test('nothing is exported that core would silently skip', () => {
    for (const key of natives()) {
        const value = plugins[key];
        assert.ok(
            Array.isArray(value) || typeof value === 'function',
            `${key} is neither a function nor a [fn, ...names] pair, so core would drop it`,
        );
    }
});

// Only actual code counts -- a cached package.json under a dependency's
// directory is plugin discovery reading manifests, not the dependency loading.
const loaded = (name) =>
    Object.keys(require.cache).some(
        (k) => k.includes(path.join('node_modules', name, path.sep)) && k.endsWith('.js'),
    );

test('requiring the package loads neither cloud SDK', () => {
    // ~1s of require() between them, and 300MB on disk. Every spell would pay it
    // for the provider it does not use if these were not deferred.
    assert.ok(!loaded('aws-sdk'), 'aws-sdk was loaded eagerly');
    assert.ok(!loaded('googleapis'), 'googleapis was loaded eagerly');
});

test('requiring the package does not load @c6fc/terraform', () => {
    // Worse than slow. @c6fc/terraform before 1.1.0 ran its install at module
    // scope, so requiring it started downloading a Terraform binary -- and on a
    // platform it did not support, called process.exit(-1). Core require()s every
    // installed plugin's entry point to discover it, which made both of those a
    // property of `spellcraft --help` rather than of running Terraform.
    //
    // The node defers it, so an older @c6fc/terraform is harmless too. Keep it
    // that way: this assertion is the only thing standing between a one-word edit
    // and a package that downloads a binary on every command.
    assert.ok(!loaded(path.join('@c6fc', 'terraform')), '@c6fc/terraform was loaded eagerly');
});

test('terraform-apply emits exactly the current lifecycle event names', async () => {
    // Nothing asserted which events fire, so the names could have been renamed,
    // dropped or doubled silently -- and they were doubled: every phase used to
    // emit a second `@c6fc/spellcraft-terraform:<phase>` alias, bridging listeners
    // written against the separate package this node used to be. That package is
    // deprecated with no upgrade path to this one, and this one has never been
    // published, so the alias was a deprecation cycle for a version nobody ever
    // received.
    const terraform = require('../terraform');

    // @c6fc/terraform is stubbed through the require cache rather than by
    // interrupting the handler. The obvious alternative -- have emitAsync throw
    // once it has recorded -- masks the defect under test: it stops at the first
    // emit, so a second alias emitted right after is never seen. Letting the
    // handler run to completion is the only way to observe what it emits, and
    // exec() has to be harmless for that to be safe (it spawns the real binary
    // and then calls process.exit, which kills the test process mid-file).
    const tfPath = require.resolve('@c6fc/terraform');
    const cached = require.cache[tfPath];

    require.cache[tfPath] = {
        id: tfPath,
        filename: tfPath,
        loaded: true,
        exports: { exec: async () => {}, get isReady() { return Promise.resolve(true); } },
    };

    const handlers = {};
    const yargs = {
        command: (name, _desc, _builder, handler) => {
            handlers[name.split(' ')[0]] = handler;
            return yargs;
        },
    };
    yargs.positional = () => yargs;
    yargs.option = () => yargs;

    const emitted = [];
    const frame = {
        renderPath: '/nonexistent',
        init: async () => {},
        render: async () => {},
        write: () => {},
        emitAsync: async (name) => { emitted.push(name); },
    };

    try {
        terraform._spellcraft_metadata.cliExtensions(yargs, frame);
        await handlers['terraform-apply']({ filename: 'x.jsonnet' });
    } finally {
        if (cached) require.cache[tfPath] = cached;
        else delete require.cache[tfPath];
    }

    assert.deepStrictEqual(emitted, [
        '@c6fc/spellcraft-plugins:terraform.pre-apply',
        '@c6fc/spellcraft-plugins:terraform.post-apply',
    ]);

    // The two nodes meet on this string and nothing else -- gcp.terraform holds
    // its own copy of it as a literal, and registers a listener that enables the
    // GCP services a manifest asked for. Rename one side only and stage-zero
    // bootstrapping stops happening, with no error: the emit finds no listener
    // and the apply proceeds against services that were never enabled.
    const listened = [];
    const listener = { on: (name) => listened.push(name) };
    await require('../gcp/terraform')._spellcraft_metadata.init({
        ...listener,
        baseDir: __dirname,
    });

    assert.ok(
        listened.includes('@c6fc/spellcraft-plugins:terraform.pre-apply'),
        `gcp.terraform listens for ${listened.join(', ')}, which terraform does not emit`,
    );
});

test('the terraform node has no init hook', () => {
    // Core's init() is all-or-nothing across every loaded plugin, so anything
    // expensive in one node's hook is paid by every command that renders --
    // `spellcraft generate` included, which never runs Terraform. Awaiting the
    // binary belongs to terraform-apply and terraform-destroy, and lives there.
    const terraform = require('../terraform');
    assert.ok(!terraform._spellcraft_metadata.init, 'terraform declared an init hook');

    // The remaining hooks must stay cheap for the same reason: the two that exist
    // read one package.json and register one listener.
    assert.deepStrictEqual(
        plugins._spellcraft_metadata.init.length,
        2,
        'expected exactly the two terraform-state nodes to declare init hooks',
    );
});
