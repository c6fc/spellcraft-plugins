// The Jsonnet face of this node. Native functions from its index.js are reached
// through std.native(), namespaced by the node's path in the package; everything
// else here is ordinary Jsonnet built on top of them.
//
// This file is the node's whole object -- its own API and, where it has them, its
// children by relative import. Doc comments below are lifted into README.md by
// `npx spellcraft doc`.

local auth = import "../auth/module.libsonnet";
local merge = import "../../utils/merge/module.libsonnet";
local tree = import "../../utils/tree/module.libsonnet";

local projectMetadata = auth.getProjectMetadata();

local normalize(name) = std.native("@c6fc/spellcraft-plugins:gcp.terraform.normalizeResourceName")(name);
local shortHash(name) = std.native("@c6fc/spellcraft-plugins:gcp.terraform.shortHash")(std.manifestJsonEx(name, ''));
local enableServices(services) = std.native("@c6fc/spellcraft-plugins:gcp.terraform.enableServices")(std.manifestJsonEx(services, ""));

local nodeBody(rawbody) = {
	type:: "",
	iam_members:: [],
	services:: [],
	service_accounts:: {},
	audit_config:: {},
	constraints:: [],
	custom_roles:: {},
	children:: [],
	provider_regions:: []
} + rawbody + {
	services:: std.filter(function(x) x != "", std.uniq(std.sort(super.services + [
		if std.objectHas(rawbody, "iam_members") then "iam.googleapis.com" else "",
		if std.objectHas(rawbody, "service_accounts") then "iam.googleapis.com" else "",
		if std.objectHas(rawbody, "audit_config") then "iam.googleapis.com" else "",
		if std.objectHas(rawbody, "constraints") then "orgpolicy.googleapis.com" else "",
		if std.objectHas(rawbody, "custom_constraints") then "orgpolicy.googleapis.com" else "",
		if std.objectHas(rawbody, "custom_roles") then "iam.googleapis.com" else "",
	])))
};

// Addresses for everything one node manifested, keyed by the caller's own names.
//
// The convention is refs-pattern.md's: the key is "<type>.<dot-joined path of
// caller-supplied names>", the value is read out of the manifested fragment
// rather than rebuilt, and `_terraform_id` carries the address the caller could
// not have derived. ctx.path is that path -- accumulated by utils.tree in the
// same pass as the derived name, which is what made this implementable.
//
// Where one node produces several resources of a type, the entry stays at the
// node and its value holds them (the shapes table in refs-pattern.md):
//
//   - by the caller's own value where there is one: service accounts by SA name,
//     services by service name, custom roles by role name, audit configs by
//     service, org policies by constraint name.
//   - by the *option* responsible where the resource is content-hashed and has
//     no caller-supplied name: IAM members. That is the one place this invents
//     vocabulary, and it is a last resort -- two options (`iam_members` and a
//     service account's `identity_policies`) both produce
//     google_*_iam_member, so an array alone could not say which made what.
local orgRefs(ctx) =
	local body = ctx.body;
	local n = ctx.name;
	local P = std.join('.', ctx.path);
	local res = std.get(ctx.fragment, 'resource', {});
	// A family is absent from the fragment when std.prune dropped it empty, so
	// every lookup below is guarded: a resource that was not built gets no ref.
	local has(type, key) = std.objectHas(res, type) && std.objectHas(res[type], key);
	local at(type, key) = res[type][key] + { _terraform_id:: '%s.%s' % [type, key] };
	local entry(type, key) = if has(type, key) then { ['%s.%s' % [type, P]]: at(type, key) } else {};
	local group(type, pairs) =
		local kept = { [p[0]]: at(type, p[1]) for p in pairs if has(type, p[1]) };
		if std.length(kept) > 0 then { ['%s.%s' % [type, P]]: kept } else {};
	local isProject = body.type == "project";
	local memberType = if isProject then 'google_project_iam_member' else 'google_folder_iam_member';
	local auditType = if isProject then 'google_project_iam_audit_config' else 'google_folder_iam_audit_config';

	// google_*_iam_member is content-hashed, so it is grouped by the option that
	// produced it rather than by any caller-supplied name.
	local memberKeys = [
		'%s-member-%s' % [n, shortHash(item + member)]
		for item in body.iam_members for member in item.members
	];
	local policyKeys = [
		['%s-sa-permissions-%s-%s' % [n, normalize(sa), shortHash(sa + e)], sa]
		for sa in std.objectFields(body.service_accounts)
		for e in std.get(body.service_accounts[sa], 'identity_policies', [])
	];
	local memberGroup =
		local byOption = {
			[if std.length(memberKeys) > 0 then 'iam_members' else null]:
				[at(memberType, k) for k in memberKeys if has(memberType, k)],
			[if std.length(policyKeys) > 0 then 'identity_policies' else null]: {
				[sa]: [at(memberType, k[0]) for k in policyKeys if k[1] == sa && has(memberType, k[0])]
				for sa in std.uniq(std.sort([k[1] for k in policyKeys]))
			},
		};
		if std.length(byOption) > 0 then { ['%s.%s' % [memberType, P]]: byOption } else {};

	(if isProject then entry('google_project', n) else entry('google_folder', n))
	+ group('google_project_service', [
		['%s' % svc, '%s-services-%s' % [n, std.split(svc, ".")[0]]] for svc in body.services
	])
	+ group('terraform_data', [
		['service_depends', '%s-service-depends' % n],
		['oob_service_depends', '%s-oob-service-depends' % n],
	])
	+ group('google_service_account', [
		[sa, '%s-sa-%s' % [n, normalize(sa)]] for sa in std.objectFields(body.service_accounts)
	])
	+ group('google_service_account_iam_member', [
		['%s.%s' % [sa, role], '%s-sa-%s-member-%s' % [n, normalize(sa), shortHash(sa + member + role)]]
		for sa in std.objectFields(body.service_accounts)
		for member in std.objectFields(std.get(body.service_accounts[sa], 'impersonation_roles', {}))
		for role in body.service_accounts[sa].impersonation_roles[member]
	])
	+ group('google_project_iam_custom_role', [
		[role, '%s-customrole-%s' % [n, role]] for role in std.objectFields(body.custom_roles)
	])
	+ group(auditType, [
		[k, '%s-audit-%s' % [n, normalize(std.split(k, ".")[0])]] for k in std.objectFields(body.audit_config)
	])
	+ group('google_org_policy_policy', [
		[item.name, '%s-constraint-%s' % [n, shortHash(item)]] for item in body.constraints
	])
	+ memberGroup;

// The whole folder/project tree, built by walking the caller's structure once.
//
// utils.tree owns the traversal, the two name accumulations and the assembly;
// everything below is what a *node* becomes. The four hooks are the four
// decisions the traversal cannot make: what a node is called, what it emits,
// what its children inherit, and what can only be computed once the whole tree
// is known.
local projectAnchor(name, region, map) =
	local built = tree.walk(map, {

		// Defaults applied once per node and shared by every hook below, so
		// `ctx.body` is the same object each of them sees.
		body(rawbody):: nodeBody(rawbody),

		// Hierarchical name construction. The derived Terraform name accumulates
		// down the tree from the parent's; ctx.path accumulates the caller's own
		// names alongside it, un-normalized, which is what the refs keys use.
		name(ctx):: normalize("%s_%s" % [ctx.parentName, ctx.body.name]),

		// What this node's children inherit as ctx.inherited. Only folders have
		// children, so this is always a folder reference.
		handoff(ctx):: "folders/${google_folder.%s.folder_id}" % ctx.name,

		// One node's contribution. Pruned here rather than by the walker: emptying
		// a resource family is this plugin's habit, so the cost belongs to it.
		node(ctx)::
			local body = ctx.body;
			local parent = ctx.inherited;
			local thisResource = ctx.name;
			local gParent = if (body.type == "project") then
					"projects/${google_project.%s.project_id}" % thisResource
				else
					"folders/${google_folder.%s.folder_id}" % thisResource;
			std.prune({
				provider: (if body.type == "project" then [{
					google: {
						project: "${terraform_data.%s-service-depends.output}" % thisResource,
						alias: "%s" % [body.name],
						region: region
					}
				}, {
					google: {
						project: "${terraform_data.%s-service-depends.output}" % thisResource,
						alias: "%s-%s" % [body.name, region],
						region: region
					}
				}] + [{
					google: {
						project: "${terraform_data.%s-service-depends.output}" % thisResource,
						alias: "%s-%s" % [body.name, r],
						region: r
					}
				} for r in body.provider_regions] else []),
				resource: {
					[if body.type == "project" then 'google_project' else null]: {
						[thisResource]: {
							deletion_policy: "DELETE",
							billing_account: projectMetadata.billingAccount,
						} + body + {
							project_id: "%s-%s-${random_bytes.%s-org-random-suffix.hex}" % [normalize(body.name), shortHash(body + parent), name],

							[if std.startsWith(parent, "organizations/") then 'org_id' else null]: std.split(parent, "/")[1],
							[if std.startsWith(parent, "folders/") then 'folder_id' else null]: std.split(parent, "/")[1],
						}
					},

					[if body.type == "folder" then 'google_folder' else null]: {
						[thisResource]: {
							name:: "",
						} + body + {
							display_name: "%s" % [body.name],
							parent: parent,
							deletion_protection: false
						}
					},

					[if body.type == "project" then 'google_project_service' else null]: {
						["%s-services-%s" % [thisResource, std.split(service, ".")[0]]]: {
							project: "${google_project.%s.project_id}" % thisResource,
							service: service,
							disable_on_destroy: false,
							disable_dependent_services: false,
						} for service in body.services
					},

					[if body.type == "project" then 'terraform_data' else null]: {
						["%s-service-depends" % [thisResource]]: {
							input: "${google_project.%s.project_id}" % thisResource,
							depends_on: ["google_project_service.%s-services-%s" % [thisResource, std.split(service, ".")[0]] for service in body.services]
						},
						["%s-oob-service-depends" % [thisResource]]: {
							input: if (std.length(body.services) > 0) then enableServices(body.services) else true
						}
					},

					[if body.type == "project" then 'google_project_iam_member' else 'google_folder_iam_member']: {
						["%s-member-%s" % [thisResource, shortHash(item + member)]]: {
						
							[if body.type == "project" then 'project' else null]: "${google_project.%s.project_id}" % thisResource,
							[if body.type == "folder" then 'folder' else null]: "${google_folder.%s.name}" % thisResource,
						
							role: item.role,
							member: member,
							[if body.type == "project" then 'depends_on']: ["terraform_data.%s-service-depends" % thisResource],
						} for item in body.iam_members for member in item.members
					} + {
						["%s-sa-permissions-%s-%s" % [thisResource, normalize(sa), shortHash(sa+entry)]]: (if std.type(entry) == "string" then {
							role: entry
						} else entry) + {
							role: (if std.startsWith(super.role, "custom/") then "projects/${google_project.%s.project_id}/roles/%s" % [thisResource, std.split(super.role, "/")[1]] else super.role),
							project: "${google_project.%s.project_id}" % thisResource,
							member: "serviceAccount:${google_service_account.%s-sa-%s.email}" % [thisResource, normalize(sa)],
							depends_on: ["terraform_data.%s-service-depends" % thisResource],
						}
						for sa in std.objectFields(body.service_accounts)
						for entry in (if std.objectHas(body.service_accounts[sa], 'identity_policies') then body.service_accounts[sa].identity_policies else [])
					},

					[if body.type == "project" then 'google_project_iam_audit_config' else 'google_folder_iam_audit_config']: {
						["%s-audit-%s" % [thisResource, normalize(std.split(k, ".")[0])]]: {
						
							[if body.type == "project" then 'project' else null]: "${google_project.%s.project_id}" % thisResource,
							[if body.type == "folder" then 'folder' else null]: "${google_folder.%s.name}" % thisResource,
						
							service: k,
							audit_log_config: std.map(
								function(e) (if std.type(e) == "string" then {
									log_type: e
								} else e),
								body.audit_config[k].log_types
							),
							[if body.type == "project" then 'depends_on']: ["terraform_data.%s-service-depends" % thisResource],
						} for k in std.objectFields(body.audit_config)
					},

					[if body.type == "project" then 'google_project_iam_custom_role' else null]: {
						["%s-customrole-%s" % [thisResource, role]]: body.custom_roles[role] + {
						
							// Fail if the name contains underscores. I agree this is a dumb limitation
							local failWithUnderscores = std.assertEqual(std.count("_", role), 0),
						
							project: "${google_project.%s.project_id}" % thisResource,
							role_id: role,
							title: role,
							depends_on: ["terraform_data.%s-service-depends" % thisResource],
						} for role in std.objectFields(body.custom_roles)
					},

					google_org_policy_policy: {
						["%s-constraint-%s" % [thisResource, shortHash(item)]]: {						
							name: "%s/policies/%s" % [gParent, item.name],
							parent: gParent,

							spec: if (std.objectHas(item, 'spec')) then
									item.spec
								else if (std.objectHas(item, 'rules')) then {
									inherit_from_parent: false,
									rules: item.rules
								} else { },

							dry_run_spec: if (std.objectHas(item, 'dry_run_spec')) then
									item.dry_run_spec
								else { },
							[if body.type == "project" then 'depends_on']: ["terraform_data.%s-service-depends" % thisResource],
						} for item in body.constraints
					},

					// service accounts:
					[if body.type == "project" then 'google_service_account' else null]: {
						["%s-sa-%s" % [thisResource, normalize(sa)]]: {
							project: "${google_project.%s.project_id}" % thisResource,
							account_id: sa,
							display_name: body.service_accounts[sa].display_name,
							depends_on: ["terraform_data.%s-service-depends" % thisResource],
						} for sa in std.objectFields(body.service_accounts)
					},

					[if body.type == "project" then 'google_service_account_iam_member' else null]: {
						// impersonation_roles
						["%s-sa-%s-member-%s" % [thisResource, normalize(sa), shortHash(sa+member+role)]]: {
							service_account_id: "${google_service_account.%s-sa-%s.name}" % [thisResource, normalize(sa)],
							role: role,
							member: member,
							depends_on: ["terraform_data.%s-service-depends" % thisResource],
						}
						for sa in std.objectFields(body.service_accounts)
						for member in (if std.objectHas(body.service_accounts[sa], 'impersonation_roles') then std.objectFields(body.service_accounts[sa].impersonation_roles) else [])
						for role in body.service_accounts[sa].impersonation_roles[member]
					} + {
						// impersonation_policies
						["%s-sa-%s-member-%s" % [thisResource, normalize(sa), shortHash(sa+policy)]]: policy + {
							service_account_id: "${google_service_account.%s-sa-%s.name}" % [thisResource, normalize(sa)],
							depends_on: ["terraform_data.%s-service-depends" % thisResource],
						}
						for sa in std.objectFields(body.service_accounts)
						for policy in (if std.objectHas(body.service_accounts[sa], 'impersonation_policies') then body.service_accounts[sa].impersonation_policies else [])
					},
				}
			}),

		// Addresses for what this call built, keyed by the caller's own names.
		// See ../../../refs-pattern.md; the shapes are documented in README.md.
		refs(ctx):: orgRefs(ctx),

		// The root object. Receives the assembled tree, which is what lets the
		// completion marker depend on every resource in it -- a post-pass that
		// cannot be written from inside a single node.
		root(built)::
			local all_resources = merge.deep({
				resource: {
					random_bytes: {
						["%s-org-random-suffix" % name]: {
							length: 2
						}
					}
				},
				output: {
					"org-api-activation": {
						value: enableServices(["orgpolicy.googleapis.com"])
					}
				}
			}, built);
			local complete_resource_name = "%s-org-complete" % name;
			local all_deps = [
				"%s.%s" % [res_type, res_name]
				for res_type in std.objectFields(all_resources.resource)
				for res_name in std.objectFields(all_resources.resource[res_type])
				if !(res_type == "terraform_data" && res_name == complete_resource_name)
			];
			merge.deep(all_resources, {
				resource: {
					terraform_data: {
						[complete_resource_name]: {
							input: name,
							depends_on: all_deps
						}
					}
				}
			}),

		// The root node's own inputs: the name its derived names build from, and
		// the organization or folder the tree hangs off.
		parentName: name,
		inherited: if (std.objectHas(map, "parent")) then map.parent
			else "organizations/%s" % projectMetadata.organizationId,
	});

	// The two resources root() adds belong to the call rather than to any node,
	// so they are keyed at the call's own name rather than a tree path. Without
	// them refs would advertise 18 of the 20 resources a populated tree builds.
	built + {
		refs+:: {
			['random_bytes.%s' % name]:
				built.resource.random_bytes['%s-org-random-suffix' % name]
				+ { _terraform_id:: 'random_bytes.%s-org-random-suffix' % name },
			['terraform_data.%s' % name]:
				built.resource.terraform_data['%s-org-complete' % name]
				+ { _terraform_id:: 'terraform_data.%s-org-complete' % name },
		},
	};


{

	/**
	 * Prepares the GCS backend for a spell, creating the bootstrap bucket if it
	 * does not exist yet, and returns the Terraform `backend` block for it.
	 *
	 * This is the one function here that writes: it creates the bucket on first
	 * use. State and artifacts for every spell live in that bucket, keyed by the
	 * name you pass.
	 *
	 * `getArtifact()` and `putArtifact()` key their object off the project name
	 * this sets, so either one throws if it runs before this has. Jsonnet does
	 * not guarantee that order on its own -- thread this function's result into
	 * whatever calls them, rather than merely calling both in the same manifest.
	 *
* Setting `config.spellcraftProject` in `package.json` supplies the project
	 * name ahead of evaluation -- a file read during `init()`, no network -- so
	 * `getArtifact()`/`putArtifact()` have a namespace to key off even before
	 * this call is forced. It does not replace this call: creating the bucket
	 * and returning the backend block is still this function's job. Calling it
	 * with a name that disagrees with the configured one throws, naming both
	 * sources; the same name is a no-op.
	 *
	 * A spell has one project. Calling this again with a *different* name in
	 * the same process throws for the same reason -- to read another spell's
	 * state, use `getRemoteState()`, not a second `bootstrap()` call. The
	 * same name twice is a no-op.
	 *
	 * @param {string} project - names the state prefix; use one per spell
	 * @returns {object} a Terraform block ready to merge into a `.tf.json` file
	 * @example
	 * local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.terraform;
	 *
	 * { "backend.tf.json": gcp.bootstrap("my-project") }
	 *
	 * // Returns a terraform.backend.gcs block pointing at the bootstrap bucket,
	 * // prefixed with the project name you passed.
	 */
	bootstrap(project):: std.native("@c6fc/spellcraft-plugins:gcp.terraform.bootstrap")(project),

	/**
	 * Reads an artifact previously stored by `putArtifact()`.
	 *
	 * Artifacts are how one spell hands a value to another without a Terraform
	 * data source — the value is fetched while the manifest evaluates, so it can
	 * shape the configuration rather than only appear in it.
	 *
	 * Throws if `bootstrap()` hasn't set a project name yet -- see `bootstrap()`
	 * for why that ordering isn't automatic.
	 *
	 * @param {string} name - the artifact name given to `putArtifact()`
	 * @returns {*} the stored value, parsed back from JSON
	 * @example
	 * local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.terraform;
	 *
	 * local backend = gcp.bootstrap("my-project");
	 * local shared = if backend != null then gcp.getArtifact("network") else null;
	 *
	 * { "app.tf.json": { output: { subnet: { value: shared.subnet } } } }
	 */
	getArtifact(name):: std.native("@c6fc/spellcraft-plugins:gcp.terraform.getArtifact")(name),

	/**
	 * The name of the bootstrap bucket for the current project.
	 *
	 * @returns {string} the bucket name, `spellcraft-terraform-<project-id>`
	 * @example
	 * local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.terraform;
	 *
	 * { "state.json": { bucket: gcp.getBootstrapBucket() } }
	 */
	getBootstrapBucket():: std.native("@c6fc/spellcraft-plugins:gcp.terraform.getBootstrapBucket")(),

	/**
	 * Reads the Terraform state of another SpellCraft spell in the same GCP
	 * project. Use it to consume another spell's outputs at evaluation time; the
	 * name is the one passed to that spell's `bootstrap()`.
	 *
	 * Outputs are flattened to their values, so an output named `subnet` is
	 * `state.outputs.subnet` — there is no `.value` to unwrap. Resources are
	 * keyed by type and name, with `data` sources under `state.data`.
	 *
	 * @param {string} project - the other spell's project name
	 * @returns {object} that spell's Terraform state
	 * @example
	 * local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.terraform;
	 *
	 * local network = gcp.getRemoteState("network");
	 *
	 * { "app.tf.json": { output: { subnet: { value: network.outputs.subnet } } } }
	 */
	getRemoteState(project):: std.native("@c6fc/spellcraft-plugins:gcp.terraform.getRemoteState")(project),

	/**
	 * Builds a whole folder and project tree from one nested description.
	 *
	 * Each node is a `{ type: "folder" | "project", name, children }`, and may
	 * carry `iam_members`, `services` and the other per-node settings the tree
	 * understands. The root's parent defaults to the organization the current
	 * project belongs to; set `parent` on the map to place it elsewhere.
	 *
	 * Alongside the resources it emits the dependency wiring that makes creation
	 * order correct, and registers the services each project needs so they are
	 * enabled before `terraform apply` runs.
	 *
	 * `test.jsonnet` in this package is the fully worked example.
	 *
	 * @param {string} name - prefix for the generated Terraform resource names
	 * @param {string} region - region for the providers the tree exposes
	 * @param {object} map - the root node of the folder/project tree
	 * @returns {object} Terraform `resource` and `output` blocks
	 * @example
	 * local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.terraform;
	 *
	 * { "org.tf.json": gcp.googleOrgProject("platform", "us-west2", {
	 *     type: "folder",
	 *     name: "engineering",
	 *     children: [{ type: "project", name: "sandbox" }],
	 *   }) }
	 */
	googleOrgProject(name, region, map):: projectAnchor(name, region, map),

	/**
	 * Stores a value as a JSON artifact in the bootstrap bucket, under this
	 * project's prefix. Read it back with `getArtifact()`.
	 *
	 * Throws if `bootstrap()` hasn't set a project name yet -- see `bootstrap()`
	 * for why that ordering isn't automatic.
	 *
	 * @param {string} name - the artifact name
	 * @param {*} content - any JSON-serialisable value
	 * @returns {boolean} true
	 * @example
	 * local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.terraform;
	 *
	 * local backend = gcp.bootstrap("my-project");
	 *
	 * {
	 *     "backend.tf.json": backend,
	 *     "meta.json": { stored: if backend != null then gcp.putArtifact("myArtifact", { someData: "a value" }) else null },
	 * }
	 */
	putArtifact(name, content)::
		std.native("@c6fc/spellcraft-plugins:gcp.terraform.putArtifact")(
			name,
			// Native arguments must be primitives, so the content is serialised
			// here and parsed on the other side -- the same convention
			// `gcp.auth.api()` uses. Passing the object straight through raised
			// "native extensions can only take primitives", which made this
			// function unusable for anything but a string.
			std.manifestJsonEx(content, ''),
		),

	/**
	 * Builds the full set of Google provider declarations for a spell.
	 *
	 * Returns one aliased provider per Compute region — the alias is the region
	 * name, so resources bind to it as `google.us-west2` — plus an unaliased
	 * default for the region you name. `options` is merged into every provider,
	 * which is where a shared `project` or `billing_project` belongs. Pass a
	 * `filter` to keep only regions whose name contains it.
	 *
	 * The region list comes from a live `compute.v1.regions.list` call.
	 *
	 * @param {string} default - region for the unaliased default provider
	 * @param {object} options - merged into every provider declaration
	 * @param {string} [filter=""] - substring the region name must contain
	 * @returns {object[]} provider declarations, for the `provider` key of a `.tf.json`
	 * @example
	 * local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.terraform;
	 *
	 * gcp.providerAliases("us-west2", {}, "us-")
	 *
	 * // Returns:
	 * // [
	 * //   { "google": { "alias": "us-east1", "region": "us-east1" } },
	 * //   { "google": { "alias": "us-west2", "region": "us-west2" } },
	 * //   ...
	 * //   { "google": { "region": "us-west2" } }
	 * // ]
	 */
	providerAliases(default, options, filter=""):: [{
		google: options + {
			alias: region,
			region: region
		}
	} for region in std.filterMap(
		function(x) filter != false && (std.length(filter) < 1 || std.length(std.findSubstr(filter, x.name)) > 0),
		function(x) x.name,
		std.native("@c6fc/spellcraft-plugins:gcp.auth.api")('compute.v1.regions.list', '{"project":"%s"}' % std.native("@c6fc/spellcraft-plugins:gcp.auth.getProjectId")()).items
	)] + [{
		google: options + {
			region: default
		}
	}]
}