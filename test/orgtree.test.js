'use strict';

// googleOrgProject() used to be unusably slow on nested trees -- a folder>folder
// >project tree cost 21s, and deeper shapes minutes. The cause was
// std.mergePatch, whose null_fields scan forces a full level of the patch at
// object-construction time; stacked one layer per level of the tree, that turned
// into a depth blow-up. See the deepMerge comment in gcp/terraform/module.libsonnet.
//
// These tests pin the fix from both sides: that the rendered output did not
// change, and that the *amount of evaluation* stays down. The second is the one
// that would actually have caught the defect -- the output was always correct,
// it just took 50x longer to produce.

const test = require('node:test');
const assert = require('node:assert');
const { newJsonnet } = require('./helpers/jsonnet');

const plugins = require('..');


// Same canned provider answers as manifest.test.js. normalizeResourceName,
// shortHash and enableServices are deliberately NOT stubbed here beyond
// enableServices' network call: the derivation runs for real, which is what
// makes the call counts below meaningful.
const STUBS = {
    'gcp.auth.getProjectMetadata': () => ({
        projectId: 'test-project',
        organizationId: '123456789',
        organizationDomain: 'example.com',
        directoryId: 'C01test',
        billingAccount: '0X0X0X-0X0X0X-0X0X0X',
        quotaProject: 'test-project',
    }),
    'gcp.auth.getProjectId': () => 'test-project',
    'gcp.auth.api': () => ({ items: [{ name: 'us-central1' }, { name: 'us-west2' }] }),
    'gcp.terraform.enableServices': () => true,
    'aws.auth.getCallerIdentity': () => ({
        Account: '111111111111',
        Arn: 'arn:aws:iam::111111111111:user/test',
        UserId: 'AIDATEST',
    }),
    'aws.auth.aws': () => ({ Regions: [] }),
};

// As manifest.test.js's harness, plus a counter. The memo cache is load-bearing
// and matches what SpellFrame does; `calls` counts every crossing, cache hits
// included, because that is the proxy for how many times an expression was
// re-evaluated.
function harness() {
    let jsonnet = newJsonnet();

    const cache = new Map();
    const counter = { calls: 0 };

    for (const key of Object.keys(plugins).filter((k) => !k.startsWith('_'))) {
        const value = plugins[key];
        const [fn, ...params] = Array.isArray(value) ? value : [value];
        const impl = STUBS[key] || fn;

        jsonnet = jsonnet.nativeCallback(
            `@c6fc/spellcraft-plugins:${key}`,
            (...args) => {
                counter.calls += 1;
                const id = JSON.stringify([key, ...args]);
                if (!cache.has(id)) cache.set(id, impl(...args));
                return cache.get(id);
            },
            ...params,
        );
    }

    return { jsonnet, counter };
}

const orgProject = async (map, { name = 'test', region = 'us-west2' } = {}) => {
    const { jsonnet, counter } = harness();
    const out = await jsonnet.evaluateSnippet(
        'local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.terraform;\n' +
        `gcp.googleOrgProject(${JSON.stringify(name)}, ${JSON.stringify(region)}, ${JSON.stringify(map)})`,
    );
    return { out: JSON.parse(out), calls: counter.calls };
};

// folder > folder > project. Three nodes, two levels of nesting -- the shape
// that cost 22s before the fix.
const NESTED = {
    type: 'folder',
    name: 'folder1',
    children: [{
        type: 'folder',
        name: 'folder2',
        children: [{
            type: 'project',
            name: 'project1',
            services: ['compute.googleapis.com'],
        }],
    }],
};

test('a nested tree does not re-evaluate itself into the ground', async () => {
    const { calls } = await orgProject(NESTED);

    // 41 today. Under std.mergePatch it was 1214 for this exact shape, and it
    // grew with depth -- 2700 at one level deeper, 5233 at two. The ceiling is
    // loose enough to absorb an honest change to what the tree emits and tight
    // enough that reintroducing a construction-time forcing pass trips it.
    assert.ok(
        calls < 150,
        `${calls} native calls to build 3 nodes -- something is re-evaluating the tree ` +
        '(it was 41 when this test was written, and 1214 before std.mergePatch was replaced)',
    );
});

test('cost grows with the size of the tree, not exponentially with its depth', async () => {
    // A chain six deep. Under std.mergePatch this shape was ~130s; the point of
    // the assertion is the *ratio*, which is what "exponential in depth" means.
    const chain = (depth) => (depth === 0
        ? { type: 'project', name: 'leaf', services: ['compute.googleapis.com'] }
        : { type: 'folder', name: `folder${depth}`, children: [chain(depth - 1)] });

    const shallow = await orgProject(chain(1));
    const deep = await orgProject(chain(6));

    // Five extra levels add five nodes' worth of work, not five doublings.
    assert.ok(
        deep.calls < shallow.calls * 3,
        `${shallow.calls} native calls at depth 1 but ${deep.calls} at depth 6 -- ` +
        'depth is compounding again',
    );
});

test('the rendered tree is unchanged, resource for resource', async () => {
    const { out } = await orgProject(NESTED, { name: 'snap' });

    // Pinned by hand rather than regenerated, so a diff has to be read and
    // agreed to. Names come from the real normalizeResourceName/shortHash.
    assert.deepStrictEqual(Object.keys(out.resource).sort(), [
        'google_folder',
        'google_project',
        'google_project_service',
        'random_bytes',
        'terraform_data',
    ]);

    assert.deepStrictEqual(Object.keys(out.resource.google_folder).sort(), [
        'snap_folder1',
        'snap_folder1_folder2',
    ]);

    assert.deepStrictEqual(
        out.resource.google_folder.snap_folder1_folder2.parent,
        'folders/${google_folder.snap_folder1.folder_id}',
        'the child folder is still parented to its parent folder',
    );

    const project = out.resource.google_project.snap_folder1_folder2_project1;
    assert.strictEqual(project.parent, undefined);
    assert.strictEqual(project.folder_id, '${google_folder.snap_folder1_folder2.folder_id}');
    assert.match(
        project.project_id,
        /^project1-[a-z0-9]+-\$\{random_bytes\.snap-org-random-suffix\.hex\}$/,
        'project_id still carries the shortHash of the body and its parent',
    );

    // The dependency wiring googleOrgProject exists to generate.
    assert.deepStrictEqual(
        out.resource.terraform_data['snap_folder1_folder2_project1-service-depends'].depends_on,
        ['google_project_service.snap_folder1_folder2_project1-services-compute'],
    );

    const complete = out.resource.terraform_data['snap-org-complete'];
    assert.ok(
        complete.depends_on.includes('google_folder.snap_folder1'),
        'the completion marker still depends on every resource in the tree',
    );
    assert.ok(!complete.depends_on.includes('terraform_data.snap-org-complete'));
});

// deepMerge keeps a key whose right-hand value is null; std.mergePatch deleted
// it. That difference is unreachable because everything entering the merge has
// been through std.prune(), which removes nulls first -- but "unreachable"
// is a claim, so these pin it.
test('a caller-supplied null is invisible to the merge', async () => {
    const cases = {
        'null in a folder body': {
            type: 'folder', name: 'f', description: null,
            children: [{ type: 'project', name: 'p', services: ['compute.googleapis.com'] }],
        },
        'null nested in a child': {
            type: 'folder', name: 'f',
            children: [{ type: 'project', name: 'p', labels: { a: 'x', b: null } }],
        },
        'null inside iam_members': {
            type: 'project', name: 'p',
            iam_members: [{ role: 'roles/viewer', members: ['user:a@b.c'], condition: null }],
        },
        'empty object and array': {
            type: 'folder', name: 'f', labels: {}, tags: [],
            children: [{ type: 'project', name: 'p' }],
        },
    };

    for (const [label, map] of Object.entries(cases)) {
        const { out } = await orgProject(map);
        const json = JSON.stringify(out);
        assert.ok(!json.includes('null'), `${label}: a null survived into the rendered tree`);
    }
});

// --- refs, per refs-pattern.md's checklist ----------------------------------
//
// googleOrgProject is the recursive case that document was written for and had
// not met. utils.tree accumulates the caller's own name path alongside the
// derived Terraform name in the same pass, which is what made this writable.

// Every option that produces a resource family, so completeness is measured
// against the widest tree the plugin can build.
const POPULATED = {
    type: 'folder',
    name: 'engineering',
    iam_members: [{ role: 'roles/resourcemanager.folderAdmin', members: ['domain:example.com', 'user:a@b.c'] }],
    audit_config: { 'storage.googleapis.com': { log_types: ['DATA_READ'] } },
    children: [{
        type: 'project',
        name: 'api',
        services: ['compute.googleapis.com', 'iam.googleapis.com'],
        custom_roles: { myRole: { description: 'd', permissions: ['storage.objects.get'] } },
        service_accounts: {
            'cache-writer': {
                display_name: 'SA',
                identity_policies: ['roles/storage.viewer', 'custom/myRole'],
                impersonation_roles: { 'user:a@b.c': ['roles/iam.serviceAccountTokenCreator'] },
            },
        },
        audit_config: { 'compute.googleapis.com': { log_types: ['ADMIN_READ'] } },
        constraints: [{ name: 'compute.disableSerialPortAccess', rules: [{ enforce: true }] }],
        iam_members: [{ role: 'roles/viewer', members: ['user:c@d.e'] }],
    }],
};

// Walks refs recursively -- grouped entries nest -- collecting every address.
const REFS_PROBE = `
local walk(o) =
    if std.isObject(o) then
        (if std.objectHasAll(o, '_terraform_id') then [o._terraform_id] else [])
        + std.flattenArrays([walk(o[k]) for k in std.objectFields(o)])
    else if std.isArray(o) then std.flattenArrays([walk(x) for x in o])
    else [];
`;

const refsOf = async (map, name = 'bench') => {
    const { jsonnet } = harness();
    return JSON.parse(await jsonnet.evaluateSnippet(`
        local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.terraform;
        ${REFS_PROBE}
        local built = gcp.googleOrgProject(${JSON.stringify(name)}, "us-west2", ${JSON.stringify(map)});
        {
            visible: std.objectFields(built),
            keys: std.objectFields(built.refs),
            addresses: std.sort(walk(built.refs)),
            manifested: std.sort(std.flattenArrays([
                ["%s.%s" % [t, n] for n in std.objectFields(built.resource[t])]
                for t in std.objectFields(built.resource)
            ])),
        }
    `));
};

test('every resource the tree manifests is reachable through refs', async () => {
    const out = await refsOf(POPULATED);

    const missing = out.manifested.filter((m) => !out.addresses.includes(m));
    const dangling = out.addresses.filter((a) => !out.manifested.includes(a));

    assert.deepStrictEqual(missing, [], 'these resources have no ref');
    assert.deepStrictEqual(dangling, [], 'these refs point at nothing');
    assert.ok(out.manifested.length >= 20, `only ${out.manifested.length} resources -- fixture stopped covering the tree`);
});

test('refs keys are the caller\'s names, never the derived ones', async () => {
    const out = await refsOf(POPULATED);

    // The derived names carry the call prefix and a hash; a key that leaked one
    // would require the very knowledge refs exists to supply.
    for (const key of out.keys) {
        const namePath = key.slice(key.indexOf('.') + 1);
        assert.ok(
            namePath === 'bench' || namePath === 'engineering' || namePath === 'engineering.api',
            `${key} is not addressed by a caller-supplied name path`,
        );
    }

    assert.ok(out.keys.includes('google_project.engineering.api'));
    assert.ok(out.keys.includes('google_folder.engineering'));
});

test('refs never manifests', async () => {
    const out = await refsOf(POPULATED);

    assert.deepStrictEqual(out.visible.sort(), ['output', 'provider', 'resource']);

    const { jsonnet } = harness();
    const rendered = await jsonnet.evaluateSnippet(`
        local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.terraform;
        gcp.googleOrgProject("bench", "us-west2", ${JSON.stringify(POPULATED)})
    `);
    assert.ok(!rendered.includes('refs'), 'refs reached the rendered output');
    assert.ok(!rendered.includes('_terraform_id'), '_terraform_id reached the rendered output');
});

test('a family that was not built has no ref', async () => {
    const bare = await refsOf({ type: 'project', name: 'plain' });
    const full = await refsOf(POPULATED);

    // Conditional families appear only when their option was set.
    for (const type of ['google_org_policy_policy', 'google_service_account', 'google_project_iam_custom_role']) {
        assert.ok(
            !bare.keys.some((k) => k.startsWith(`${type}.`)),
            `${type} has a ref on a tree that never built one`,
        );
        assert.ok(full.keys.some((k) => k.startsWith(`${type}.`)), `${type} missing on the populated tree`);
    }
});

test('refs values are the manifested objects, and differ from each other', async () => {
    const { jsonnet } = harness();
    const out = JSON.parse(await jsonnet.evaluateSnippet(`
        local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.terraform;
        local built = gcp.googleOrgProject("bench", "us-west2", ${JSON.stringify(POPULATED)});
        {
            // Read straight off the manifested tree, not rebuilt from inputs.
            projectId: built.refs['google_project.engineering.api'].project_id,
            fromTree: built.resource.google_project[
                built.refs['google_project.engineering.api']._terraform_id[std.length('google_project.'):]
            ].project_id,
            folderDisplay: built.refs['google_folder.engineering'].display_name,
            saEmail: built.refs['google_service_account.engineering.api']['cache-writer'].account_id,
        }
    `));

    assert.strictEqual(out.projectId, out.fromTree, 'the ref value is not the manifested object');
    assert.match(out.projectId, /^api-[a-z0-9]+-\$\{random_bytes\./, 'the derived project_id is not exposed');
    assert.strictEqual(out.folderDisplay, 'engineering');
    assert.strictEqual(out.saEmail, 'cache-writer');
});
