// The Jsonnet face of this node. Native functions from its index.js are reached
// through std.native(), namespaced by the node's path in the package; everything
// else here is ordinary Jsonnet built on top of them.
//
// This file is the node's whole object -- its own API and, where it has them, its
// children by relative import. Doc comments below are lifted into README.md by
// `npx spellcraft doc`.

{
	local aws = self,

	/**
	 * Describes an AWS service client. Pass the result to `aws.api()`.
	 *
	 * This does not instantiate anything on its own — it is a plain object naming
	 * the service and the constructor parameters, which `aws.api()` hands to the
	 * SDK. Reach for it when a call needs non-default client options such as a
	 * region; otherwise `aws.call()` is shorter.
	 *
	 * @param {string} service - an AWS-SDK v2 client name, e.g. 'STS' or 'EC2'
	 * @param {object} [params={}] - constructor options, e.g. { region: "us-west-2" }
	 * @returns {object} a client descriptor
	 * @example
	 * local aws = (import "@c6fc/spellcraft-plugins/module.libsonnet").aws.auth;
	 * local ec2 = aws.client('EC2', { region: "us-west-2" });
	 *
	 * { "zones.json": aws.api(ec2, 'describeAvailabilityZones') }
	 */
	client(service, params={}):: {
		service: service,
		params: params
	},

	/**
	 * Calls an AWS API method and returns its response.
	 *
	 * The client and parameters are serialised on the way out because Jsonnet
	 * cannot pass objects into a native function, and parsed again on the
	 * JavaScript side. The response comes back as an ordinary Jsonnet object.
	 *
	 * @param {object} clientObj - a descriptor from `aws.client()`
	 * @param {string} method - the SDK method name, e.g. 'describeRegions'
	 * @param {object} [params={}] - request parameters
	 * @returns {object} the API response, with ResponseMetadata left intact
	 * @example
	 * local aws = (import "@c6fc/spellcraft-plugins/module.libsonnet").aws.auth;
	 * local s3 = aws.client('S3', { region: "us-west-2" });
	 *
	 * { "buckets.json": aws.api(s3, 'listBuckets') }
	 */
	api(clientObj, method, params={}):: std.native('@c6fc/spellcraft-plugins:aws.auth.aws')(
		std.manifestJsonEx(clientObj, ''),
		method,
		std.manifestJsonEx(params, '')
	),

	/**
	 * Shorthand for `aws.api(aws.client(name, { region: "us-east-1" }), method, params)`.
	 *
	 * Note the pinned region: this is for global endpoints such as STS and IAM.
	 * For anything regional, build the client yourself with `aws.client()` so the
	 * call reaches the region you mean.
	 *
	 * @param {string} name - an AWS-SDK v2 client name
	 * @param {string} method - the SDK method name
	 * @param {object} [params={}] - request parameters
	 * @returns {object} the API response
	 * @example
	 * local aws = (import "@c6fc/spellcraft-plugins/module.libsonnet").aws.auth;
	 *
	 * { "identity.json": aws.call('STS', 'getCallerIdentity') }
	 */
	call(name, method, params={}):: aws.api(
		aws.client(name, { region: "us-east-1" }),
		method,
		params
	),


	/**
	 * The identity the render is authenticated as.
	 *
	 * Resolved on the first call that needs credentials and cached for the rest
	 * of the process, so calling it repeatedly costs one request. It is the
	 * identity *after* any `SPELLCRAFT_ASSUMEROLE` chaining has happened.
	 *
	 * @returns {object} `{ UserId, Account, Arn }`
	 * @example
	 * local aws = (import "@c6fc/spellcraft-plugins/module.libsonnet").aws.auth;
	 *
	 * { "account.json": { account: aws.getCallerIdentity().Account } }
	 */
	getCallerIdentity():: std.native('@c6fc/spellcraft-plugins:aws.auth.getCallerIdentity')(),

	/**
	 * Every region name the current credentials can see.
	 *
	 * One `describeRegions` call against us-east-1, mapped down to the names.
	 *
	 * @returns {string[]} region names, e.g. `["us-east-1", "us-west-2", ...]`
	 * @example
	 * local aws = (import "@c6fc/spellcraft-plugins/module.libsonnet").aws.auth;
	 *
	 * { "regions.json": aws.getRegionsList() }
	 */
	getRegionsList():: std.map(
		function (x) x.RegionName,
		aws.call('EC2', 'describeRegions').Regions
	),

	/**
	 * Availability zone names, keyed by region.
	 *
	 * Be aware of the cost: this is one `describeRegions` call plus one
	 * `describeAvailabilityZones` per region, so it makes tens of API calls and
	 * takes a while. Memoisation makes it once per render, not once per use.
	 *
	 * @returns {object} region name to an array of zone names
	 * @example
	 * local aws = (import "@c6fc/spellcraft-plugins/module.libsonnet").aws.auth;
	 *
	 * { "zones.json": aws.getAvailabilityZones() }
	 *
	 * // Returns:
	 * // { "us-east-1": ["us-east-1a", "us-east-1b", ...], ... }
	 */
	getAvailabilityZones():: {
		[region]: std.map(
			function (x) x.ZoneName,
			aws.api(aws.client('EC2', { region: region }), 'describeAvailabilityZones').AvailabilityZones
		) for region in aws.getRegionsList()
	},
}
