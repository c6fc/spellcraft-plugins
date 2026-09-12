local accountId = std.native("@c6fc/spellcraft-plugins:aws.auth.getCallerIdentity")().Account;

local mandatory_tags = {};

{
	/**
	 * Builds a secure-by-default S3 bucket and its supporting resources.
	 *
	 * Returns a `{ resource: { ... } }` object: one call, one `.tf.json` file.
	 * Give each call its own manifest key rather than combining calls, the way a
	 * Terraform repository is laid out anyway.
	 *
	 * With no options you get a KMS-encrypted bucket with its own customer-managed
	 * key and rotation enabled, all four public access blocks on, a policy that
	 * denies any request below TLS 1.2, `BucketOwnerEnforced` ownership, and
	 * versioning disabled. Pass a `type` for a common preset, or any option below
	 * to override one default. Anything not recognised as an option is passed
	 * straight through as an attribute of `aws_s3_bucket`.
	 *
	 * `name` is the Terraform resource key, not the bucket name: the bucket is
	 * created with `bucket_prefix`, so its deployed name is `<name>-<suffix>` with
	 * a suffix AWS generates. That keeps the globally-unique S3 namespace from
	 * being something you have to negotiate by hand.
	 *
	 * Every resource is bound to `provider: "aws.<region>"`, so the spell needs
	 * matching provider aliases — see `providerAliases()` in
	 * `plugins.aws.terraform`.
	 *
	 * @param {string} name - the Terraform resource key, and the bucket's name prefix
	 * @param {string} region - the region alias to bind every resource to
	 * @param {object} [options={}] - overrides; see the option reference in the README
	 * @returns {object} a Terraform `resource` block
	 * @example
	 * local s3 = (import "@c6fc/spellcraft-plugins/module.libsonnet").aws.terraform.s3;
	 *
	 * { "buckets.tf.json": s3.bucket("artifacts", "us-west-2") }
	 *
	 * @example
	 * local s3 = (import "@c6fc/spellcraft-plugins/module.libsonnet").aws.terraform.s3;
	 *
	 * // A public static site, and a log bucket that can receive delivery writes.
	 * // One call per file: Terraform reads every .tf.json in the directory as one
	 * // configuration, so there is nothing to gain by combining them.
	 * {
	 *   "site.tf.json": s3.bucket("site", "us-west-2", { type: "static-site" }),
	 *   "logs.tf.json": s3.bucket("logs", "us-west-2", { type: "log-storage" }),
	 * }
	 */
	bucket(name, region, options = {}):

		// The name is derived from `name` via bucket_prefix, so a `bucket:` in
		// options is dropped by the third merge layer below. That behaviour is
		// right -- see "Bucket names" in the README -- but it was the one silent
		// exception to a pass-through contract the README states twice, and the
		// inversion it produced is the tell: a key that is genuinely wrong reaches
		// Terraform and fails at plan, while a real, valid aws_s3_bucket argument
		// was the one thrown away without a word.
		assert !std.objectHas(options, 'bucket') : (
			"s3.bucket('%s'): the bucket name is derived from `name` through bucket_prefix and " % name +
			'cannot be set directly -- see "Bucket names" in the README.'
		);

		local types = {
			"static-site": {
				public_access_block: false,
				server_side_encryption: false,
				policy_statements: [{
					Effect: "Allow",
					Principal: "*",
					Action: ["s3:getObject"],
					Resource: [
						"${aws_s3_bucket.%s.arn}/*" % name
					]
				}],
				website: true
			},
			"log-storage": {
				acl: "log-delivery-write",
				object_ownership: "ObjectWriter",
			}
		};

		// An unrecognised preset used to be ignored in silence, so `type:
		// "static_site"` -- one character out -- returned a fully locked-down
		// private bucket where a public website was asked for, with exit 0 and no
		// website configuration emitted.
		assert !std.objectHas(options, 'type') || (std.isString(options.type) && std.objectHas(types, options.type)) : (
			"s3.bucket('%s'): unknown type %s. Valid types are %s." % [
				name, std.manifestJsonEx(options.type, ''), std.join(', ', ["'%s'" % t for t in std.objectFields(types)]),
			]
		);

		local typeOptions = if (std.objectHas(options, 'type') && std.objectHas(types, options.type)) then types[options.type] else {};

		// Three layers: defaults a caller may override, then the caller's own
		// options, then the values this plugin computes and will not let them
		// override.
		//
		// Visibility carries the distinction between "an argument of
		// aws_s3_bucket" and "an input to this plugin". Only the former is
		// declared with ':' -- everything else is '::' and is read below to
		// build the separate resources it configures, never manifested into the
		// bucket body, where Terraform would reject it as an unsupported
		// argument.
		//
		// Declaring them '::' here is all that is needed. A caller overriding
		// one with ':' does not un-hide it: in Jsonnet a ':' field inherits the
		// visibility of the field it overrides, and only ':::' forces visible.
		// Re-hiding them again in the third layer would be redundant.
		local computed_options = {
			// Arguments of aws_s3_bucket itself.
			object_lock_enabled: false,
			force_destroy: false,
			tags: {},

			// Inputs to this plugin, consumed below.
			//
			// `type` needs a default even though nothing reads it, for the same
			// reason as the rest: without one, a caller passing `type:` has no
			// hidden field to inherit visibility from, and it manifests into the
			// bucket body.
			type:: null,
			acceleration_status:: false,
			acl:: false,
			allow_insecure_access:: false,
			cors_rule:: [],
			lifecycle_rule:: [],
			logging:: "",
			object_lock_configuration:: [],
			object_ownership:: "BucketOwnerEnforced",
			policy_statements:: [],
			public_access_block:: true,
			replication_configuration:: {},
			request_payer:: "BucketOwner",
			server_side_encryption:: true,
			versioning:: "Disabled",
			website:: {},

		} + typeOptions + options + {
			bucket:: null,
			bucket_prefix: "%s-" % name,

			tags: super.tags + mandatory_tags,

			// `website: true` is shorthand for the conventional pair of
			// documents. This is the one entry here that transforms rather than
			// computes, so it cannot move up into the defaults.
			website:: (if super.website == true then {
					index_document: {
						suffix: "index.html"
					},
					error_document: {
						key: "error.html"
					}
				} else super.website)
		};

		local all = {
			provider: "aws.%s" % region,
			bucket: "${aws_s3_bucket.%s.id}" % name,
		};


		local manifested = {
		resource: {
			aws_s3_bucket: {
				[name]: computed_options + {
					provider: "aws.%s" % region,
				}
			},
			aws_s3_bucket_policy: {
				[name]: all + {
					policy: std.manifestJsonEx({
						Version: "2012-10-17",
						Statement: std.flattenArrays([computed_options.policy_statements, if computed_options.allow_insecure_access then [] else [{
							Effect: "Deny",
							Principal: "*",
							Action: "s3:*",
							Resource: [
								"${aws_s3_bucket.%s.arn}/*" % name,
								"${aws_s3_bucket.%s.arn}" % name
							],
							Condition: {
								Bool: {
									"aws:SecureTransport": false
								},
								NumericLessThan: {
									"s3:TlsVersion": 1.2
								}
							}
						}]])
					}, '')
				}
			},
			aws_s3_bucket_ownership_controls: {
				[name]: all + {
					rule: [{
						object_ownership: computed_options.object_ownership
					}]
				}
			},
			[if computed_options.acl != false && computed_options.object_ownership != "BucketOwnerEnforced" then 'aws_s3_bucket_acl' else null]: {
				[name]: all + {
					acl: computed_options.acl,
					depends_on: [
						"aws_s3_bucket_ownership_controls.%s" % name,
						"aws_s3_bucket_public_access_block.%s" % name
					]
				}
			},
			aws_s3_bucket_public_access_block: {
				[name]: all + {
					block_public_acls: computed_options.public_access_block,
					block_public_policy: computed_options.public_access_block,
					ignore_public_acls: computed_options.public_access_block,
					restrict_public_buckets: computed_options.public_access_block
				}
			},
			[if std.member(["Enabled", "Suspended"], computed_options.acceleration_status) then "aws_s3_bucket_accelerate_configuration" else null]: {
				[name]: all + {
					status: computed_options.acceleration_status
				}
			},
			[if computed_options.cors_rule != [] then "aws_s3_bucket_cors_configuration" else null]: {
				[name]: all + {
					cors_rule: computed_options.cors_rule
				}
			},
			[if computed_options.lifecycle_rule != [] then "aws_s3_bucket_lifecycle_configuration" else null]: {
				[name]: all + {
					rule: computed_options.lifecycle_rule
				}
			},
			[if computed_options.logging != "" then "aws_s3_bucket_logging" else null]: {
				[name]: all + {
					target_bucket: computed_options.logging,
					target_prefix: "%s/%s-" % [accountId, name]
				}
			},
			[if computed_options.object_lock_configuration != [] then "aws_s3_bucket_object_lock_configuration" else null]: {
				[name]: all + {
					rule: computed_options.object_lock_configuration
				}
			},
			// Passed through whole, like `website`, because the resource needs a
			// `role` alongside its rules — emitting rules on their own would
			// produce a configuration Terraform rejects.
			[if computed_options.replication_configuration != {} then "aws_s3_bucket_replication_configuration" else null]: {
				[name]: all + computed_options.replication_configuration
			},
			aws_s3_bucket_request_payment_configuration: {
				[name]: all + {
					payer: computed_options.request_payer
				}
			},
			[if computed_options.server_side_encryption then "aws_s3_bucket_server_side_encryption_configuration" else null]: {
				[name]: all + {
					rule: [{
						apply_server_side_encryption_by_default: {
							kms_master_key_id: "${aws_kms_key.s3_%s.id}" % name,
							sse_algorithm: "aws:kms"
						}
					}]
				}
			},
			aws_s3_bucket_versioning: {
				[name]: all + {
					versioning_configuration: {
						status: computed_options.versioning
					}
				}
			},
			[if computed_options.website != {} then "aws_s3_bucket_website_configuration" else null]: {
				[name]: computed_options.website + all
			},
			[if computed_options.server_side_encryption then "aws_kms_key" else null]: {
				["s3_%s" % name]: {
					provider: "aws.%s" % region,
					
					description: "S3 CMK for %s" % [name],
					customer_master_key_spec: "SYMMETRIC_DEFAULT",
					deletion_window_in_days: 7,
					enable_key_rotation: true,

					policy: std.manifestJsonEx({
						Id: "ExamplePolicy",
						Version: "2012-10-17",
						Statement: [{
							Sid: "Enable IAM policies",
							Effect: "Allow",
							Principal: {
								AWS: "arn:aws:iam::%s:root" % accountId
							},
							Action: "kms:*",
							Resource: "*"
						}]
					}, '  ')
				}
			}
		}
		};

		// refs:: -- one entry per resource this call manifested, addressed as
		// "<terraform_resource_type>.<the name you passed>", valued as the
		// manifested object plus a hidden _terraform_id carrying the address
		// Terraform actually uses. See ../../../../refs-pattern.md.
		//
		// Derived from the manifested tree rather than hand-listed, which the
		// pattern permits because every key here is still built from the caller's
		// own `name`: only _terraform_id comes from the manifested side. That
		// matters most for aws_kms_key, the one resource whose name this plugin
		// derives (s3_<name>) -- and it means the eight conditional families need
		// no guards, since a family that was not built simply is not in the tree.
		local refs = {
			['%s.%s' % [type, name]]:
				// One resource per type is structural here, not incidental: every
				// family is keyed by the single bucket being built. Asserted rather
				// than assumed -- though note the scope, since it is easy to
				// overestimate: this fires only when somebody reads the affected
				// entry, because each value is a separate lazy thunk. Reading the
				// keys, or a different entry, will not trip it. The check that
				// actually catches a new multi-resource family is in
				// test/refs.test.js, which asserts one-per-type across every family.
				assert std.length(std.objectFields(manifested.resource[type])) == 1 :
					"refs: %s holds %d resources; a type with several needs its own entry, as aws.terraform.lambda does" % [
						type, std.length(std.objectFields(manifested.resource[type]))
					];

				local manifestedName = std.objectFields(manifested.resource[type])[0];

				manifested.resource[type][manifestedName]
				+ { _terraform_id:: '%s.%s' % [type, manifestedName] }
			for type in std.objectFields(manifested.resource)
		};

		manifested + { refs:: refs }
}