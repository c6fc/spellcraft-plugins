// The Jsonnet face of this node. Native functions from its index.js are reached
// through std.native(), namespaced by the node's path in the package; everything
// else here is ordinary Jsonnet built on top of them.
//
// This file is the node's whole object -- its own API and, where it has them, its
// children by relative import. Doc comments below are lifted into README.md by
// `npx spellcraft doc`.

{

  local gcp = self,

  /**
   * The project this render is bound to.
   *
   * Resolved on the first call that needs credentials, from
   * `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`, the ADC file's quota project, then
   * gcloud's configured project — so it costs no API call, and a spell that
   * never touches GCP never resolves it at all.
   *
   * @returns {string} the project id
   * @example
   * local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.auth;
   *
   * { "project.json": { id: gcp.getProjectId() } }
   */
  getProjectId():: std.native('@c6fc/spellcraft-plugins:gcp.auth.getProjectId')(),

  /**
   * The project's place in the resource hierarchy, and how it is billed.
   *
   * Enables `cloudbilling.googleapis.com` on the project if it isn't already, so
   * that the billing account can be read back.
   *
   * @returns {object} `{ projectId, quotaProject, organizationId, organizationDomain, directoryId, billingAccount }` — the organization and billing fields are false when the project has none
   * @example
   * local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.auth;
   *
   * { "billing.json": gcp.getProjectMetadata() }
   */
  getProjectMetadata():: std.native('@c6fc/spellcraft-plugins:gcp.auth.getProjectMetadata')(),

  /**
   * The identity this render is authenticated as.
   *
   * @returns {object} `{ identity, projectId, scopes, expiresIn, authType, impersonatedBy }`
   * @example
   * local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.auth;
   *
   * { "identity.json": gcp.getCallerIdentity() }
   */
  getCallerIdentity():: std.native('@c6fc/spellcraft-plugins:gcp.auth.getCallerIdentity')(),

  /**
   * Enables API services during the render, so they are live before any tool
   * runs. This is the answer to the stage-zero problem: Terraform cannot enable
   * the API that a resource it is creating depends on.
   *
   * `api()`, `listBuckets()` and `listInstances()` already call this
   * internally for their own service, so you don't need to call it yourself
   * before using them. Reach for this directly when a manifest calls a native
   * function from elsewhere -- a different plugin, or a hand-written one --
   * that doesn't self-enable the way this plugin's own functions do. In that
   * case, Jsonnet evaluates lazily and in no guaranteed field order, so the
   * call that needs the service enabled must *depend on* the result rather
   * than merely follow it -- thread the return value through:
   *
   * ```
   * local ready = gcp.enableServices(["compute.googleapis.com"]);
   * { "instances.json": if ready then someOtherPlugin.rawThing() else null }
   * ```
   *
   * Already-enabled services are left alone, and confirmed ones are cached
   * for the life of the process, so calling this -- from as many places as
   * you like, including indirectly through `api()` -- is cheap and safe to
   * repeat. The one cost worth knowing: activating a service that's never
   * been enabled before waits ~15s for IAM/quota propagation, once per call
   * that activates something new -- so many separate calls each activating
   * one new service pay that wait separately, rather than once. This only
   * ever affects the first time a given process touches a given service.
   *
   * @param {string[]} services - fully qualified service names
   * @returns {boolean} true once every requested service is enabled
   * @example
   * local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.auth;
   *
   * { "instances.json": gcp.listInstances({
   *     project: gcp.getProjectId(),
   *     zone: "us-west1-b",
   *   }) }
   */
  enableServices(services):: std.native("@c6fc/spellcraft-plugins:gcp.auth.enableServices")(std.manifestJsonEx(services, "")),

  /**
   * Calls any googleapis method and returns its response.
   *
   * The path is dot-delimited: service, version, then the method path — so
   * `compute.v1.instances.list` or `storage.v1.buckets.list`.
   *
   * Enables `<service>.googleapis.com` first, best-effort -- that matches
   * Google's own naming convention for the overwhelming majority of services,
   * so most calls need nothing else. It isn't guaranteed for every service,
   * but a wrong or nonexistent guess never blocks the call itself, and a
   * correct one is free after the first time (see `enableServices()`). Call
   * `enableServices()` yourself first for anything this guess doesn't cover.
   *
   * Passing `params` replaces the default entirely, so add `project` back when
   * the method needs it alongside anything else you supply.
   *
   * @param {string} fullpath - `<service>.<version>.<...method>`
   * @param {object} [params={ project: gcp.getProjectId() }] - request parameters
   * @returns {object} the API response body
   * @example
   * local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.auth;
   *
   * { "projects.json": gcp.api("cloudresourcemanager.v1.projects.list", {}) }
   */
  api(fullpath, params={ project: gcp.getProjectId() })::
      std.native('@c6fc/spellcraft-plugins:gcp.auth.api')(
          fullpath,
          std.manifestJsonEx(params, '')
      ),

  /**
   * Cloud Storage buckets in the project.
   *
   * @param {object} [params={ project: gcp.getProjectId() }] - request parameters
   * @returns {object} a `storage#buckets` response
   * @example
   * local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.auth;
   *
   * { "buckets.json": gcp.listBuckets() }
   */
  listBuckets(params={ project: gcp.getProjectId() })::
      gcp.api('storage.v1.buckets.list', params),

  /**
   * Compute instances in one zone.
   *
   * A zone is required, and supplying it replaces the default params — so pass
   * `project` as well. Enables `compute.googleapis.com` itself, via `api()` --
   * nothing to enable yourself first.
   *
   * @param {object} [params={ project: gcp.getProjectId() }] - must include `zone`
   * @returns {object} a `compute#instanceList` response
   * @example
   * local gcp = (import "@c6fc/spellcraft-plugins/module.libsonnet").gcp.auth;
   *
   * { "instances.json": gcp.listInstances({
   *     project: gcp.getProjectId(),
   *     zone: "us-west1-b",
   *   }) }
   */
  listInstances(params={ project: gcp.getProjectId() })::
      gcp.api('compute.v1.instances.list', params),

}
