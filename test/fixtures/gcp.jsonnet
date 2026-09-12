// Ported from spellcraft-gcp-terraform/test.jsonnet. The original reached the
// auth plugin through gcp-terraform's `auth:` passthrough field, which existed
// only to spare a spell a second package import; `plugins.gcp.auth` replaces it.
//
// This used to be deliberately shallow, because nesting cost roughly threefold
// per level -- folder>folder>project took ~12s and the original shape took over
// a minute. That was std.mergePatch, not org_map: see the deepMerge comment in
// gcp/terraform/module.libsonnet. Depth is now close to free, so the tree here
// is genuinely nested and the two calls no longer need to be kept flat.
local plugins = import '@c6fc/spellcraft-plugins/module.libsonnet';

local auth = plugins.gcp.auth;
local gcp = plugins.gcp.terraform;

local domain = auth.getProjectMetadata().organizationDomain;

{
  // A three-level tree: folder > folder > project, with an IAM binding at each
  // folder. Depth is the thing that used to be unaffordable, so the fixture
  // exercises it directly.
  'orgTree.tf.json': gcp.googleOrgProject('tree', 'us-west2', {
    type: 'folder',
    name: 'folder1',

    iam_members: [{
      role: 'roles/resourcemanager.folderAdmin',
      members: ['domain:%s' % domain],
    }],

    children: [{
      type: 'folder',
      name: 'folder2',

      iam_members: [{
        role: 'roles/resourcemanager.projectCreator',
        members: ['domain:%s' % domain],
      }],

      children: [{
        type: 'project',
        name: 'project1',
        services: ['compute.googleapis.com'],

        audit_config: {
          'storage.googleapis.com': { log_types: ['DATA_READ'] },
        },

        constraints: [{
          name: 'compute.disableSerialPortAccess',
          rules: [{ enforce: true }],
        }],
      }],
    }],
  }),

  // A second, flat call covering service accounts and custom roles. Separate
  // from the tree above so each node type is covered once, not to dodge a cost.
  'projectDetail.tf.json': gcp.googleOrgProject('detail', 'us-west2', {
    type: 'project',
    name: 'project2',

    custom_roles: {
      exampleCustomRole: {
        description: 'A test custom role',
        permissions: ['storage.objects.get'],
      },
    },

    service_accounts: {
      'test-sa': {
        display_name: 'A test SA',
        identity_policies: ['roles/storage.viewer', 'custom/exampleCustomRole'],
      },
    },
  }),
}
