// The object config() returns is built from this, parameterized on where
// source resolves from and what options every call in this "instance" should
// default to.
//
// There is deliberately no unconfigured fallback, and it must stay that way. Any
// default for thisFile is indistinguishable, from inside this function, from a
// plugin author who forgot to call config() -- and it can look correct during
// that author's own standalone testing, where render/'s parent happens to be
// their own plugin's root, then break once a third party nests the plugin inside
// a different project, far from wherever the mistake was made. Requiring config()
// turns that into an immediate, specific failure, for everyone, every time.
local build(thisFile, defaultOptions) = {
    nodejs_function(name, region, options={}):

      // Source for `name` lives at lambda_functions/<name>/, sibling to
      // `thisFile` -- the caller's own file when set via config(), or the
      // fake path above otherwise, which resolves the same way
      // "${path.module}/../lambda_functions/<name>" always did.
      local sourceDir = std.resolvePath(thisFile, 'lambda_functions/%s' % name);

      // config()'s defaults apply to every call from this instance unless
      // this specific call overrides them -- plain object merge, so any
      // options key (runtime, memory_size, execution_policy_attachments,
      // anything) can be set as a shared default, not just a hardcoded list.
      local mergedOptions = defaultOptions + options;

      local computedOptions = {
        // An array of ARNs that should be allowed to invoke the function
        arns_allowed_to_invoke:: [],

        // An array of cloudwatch event rules to create
        // using inner parameters of aws_cloudwatch_event_rule
        event_triggers:: [],

        // A key/value pair of attachment names and IAM policy ARNs
        // to attach to the execution role
        execution_policy_attachments:: [],

        // An array of IAM native statement objects to apply inline
        // to the execution role.
        execution_policy_statements:: [],

        // Allowed values: 1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180,
        // 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653,
        // and 0.
        cloudwatch_log_retention_days:: 30,

        // 'true' or 'false'
        retain_logs_on_destroy:: true,

        // An array of objects. Must contain
        // 'principal' and optionally 'source_arn'
        // as appropriate
        services_allowed_to_invoke:: [],

        // "Active" or "PassThrough"
        tracing:: 'Active',
      } + mergedOptions + {
        arns_allowed_to_invoke:: super.arns_allowed_to_invoke,
        cloudwatch_log_retention_days:: super.cloudwatch_log_retention_days,
        event_triggers:: super.event_triggers,
        retain_logs_on_destroy:: super.retain_logs_on_destroy,
        execution_policy_attachments:: super.execution_policy_attachments + [
          'arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess',
        ],
        execution_policy_statements:: super.execution_policy_statements,
        services_allowed_to_invoke:: super.services_allowed_to_invoke,
        tracing:: super.tracing,

        environment+: {
          variables+: {
            AWS_SDK_JS_SUPPRESS_MAINTENANCE_MODE_MESSAGE: 1,
          },
        },
      };

      local all = {
        provider: 'aws.%s' % region,
      };

      // The policy's own name is the *last* path segment, not the second. This
      // read `std.split(arn, '/')[1]` -- which is only the same thing for an ARN
      // with no path, and AWS-managed service-role policies (the most common
      // thing there is to attach to a Lambda execution role) all carry one:
      //
      //   arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
      //
      // So every one of them keyed on the literal "service-role" -- two of them
      // collided outright, and one produced a Terraform resource named after a
      // path component and a refs sub-key nobody could guess. The assert covers
      // the other half: a malformed ARN used to fail with `array bounds error:
      // 1 not within [0, 1)`, naming neither the option nor the value.
      local policyName(arn) =
        local parts = std.split(arn, '/');
        assert std.length(parts) > 1 : (
          "lambda.nodejs_function('%s'): execution_policy_attachments entry '%s' is not an IAM policy ARN " % [name, arn] +
          '(expected something like arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole).'
        );
        parts[std.length(parts) - 1];

      // '' + v so a number, a boolean or an object reaches std.strReplace as a
      // string -- those worked by accident before, and an object is exactly the
      // kind of value most likely to contain a quote.
      local shquote(v) = "'" + std.strReplace('' + v, "'", "'\\''") + "'";

      local manifested = std.prune({
        resource: {
          aws_lambda_function: {
            [name]: all {
              runtime: 'nodejs20.x',
              handler: 'main.main',
              timeout: 5,
              memory_size: 256,
              tracing_config: {
                mode: computedOptions.tracing,
              },
            } + computedOptions + {
              function_name: name,
              filename: '../lambda_functions/zip_files/%s.zip' % name,
              source_code_hash: '${data.archive_file.%s.output_base64sha256}' % name,
              role: '${aws_iam_role.lambda-%s.arn}' % name,
              // A caller's own depends_on is merged in here, on the resource
              // they passed it to. It used to be read only by data.archive_file
              // below -- so a standard Terraform meta-argument landed somewhere
              // other than the resource it was given to, and silently: the
              // ordering still worked out transitively, but the zip build was
              // blocked on unrelated infrastructure, and depends_on on a *data
              // source* defers its read to apply, which turns source_code_hash
              // into "(known after apply)" and stops the plan showing whether
              // the function changed at all.
              depends_on: ['data.archive_file.%s' % name, 'aws_iam_role_policy.lambda-%s' % name]
                          + (if std.objectHas(computedOptions, 'depends_on') then computedOptions.depends_on else []),
              environment+: {
                variables+: {},
              },
            },
          },
          null_resource: {
            ['npm_install-%s' % name]: {
              provisioner: [{
                'local-exec': {
                  command: 'cd %s && npm install' % sourceDir,
                },
              }],
            },
          },
          aws_iam_role: {
            ['lambda-%s' % name]: {
              provider: 'aws.us-east-1',
              name: 'lambda-%s' % name,
              description: 'Lambda Role for %s' % name,
              assume_role_policy: '{"Version": "2012-10-17","Statement": [{\n\t\t\t\t\t\t"Effect": "Allow","Principal": {"Service": ["edgelambda.amazonaws.com", "lambda.amazonaws.com"]},\n\t\t\t\t\t\t"Action": "sts:AssumeRole"\n\t\t\t\t\t}]}',
            },
          },
          aws_iam_role_policy: {
            ['lambda-%s' % name]: {
              provider: 'aws.us-east-1',
              name: 'lambda-%s' % name,
              role: '${aws_iam_role.lambda-%s.id}' % name,
              policy: std.manifestJsonEx({
                Version: '2012-10-17',
                Statement: computedOptions.execution_policy_statements + [{
                  Effect: 'Allow',
                  Action: [
                    'logs:CreateLogStream',
                    'logs:PutLogEvents',
                  ],
                  Resource: '${aws_cloudwatch_log_group.lambda-%s.arn}:*' % name,
                }, {
                  Effect: 'Allow',
                  Action: [
                    'xray:PutTraceSegments',
                    'xray:PutTelemetryRecords',
                    'xray:GetSamplingRules',
                    'xray:GetSamplingTargets',
                    'xray:GetSamplingStatisticSummaries',
                  ],
                  Resource: '*',
                }],
              }, ' '),
            },
          },
          aws_cloudwatch_log_group: {
            ['lambda-%s' % name]: all {
              name: '/aws/lambda/%s' % name,
              retention_in_days: computedOptions.cloudwatch_log_retention_days,
              skip_destroy: computedOptions.retain_logs_on_destroy,
            },
          },
          local_file: {
            ['lambda-%s_envvars' % name]: {
              // Values are interpolated into a file that gets `source`d, so they
              // are quoted the POSIX way -- close, escaped quote, reopen. Raw
              // single-quoting meant one apostrophe took out the *whole* file
              // (the unterminated quote swallows every variable after it), and a
              // crafted value ran as a command. That is not a hypothetical
              // input here: the premise of this package is that a manifest reads
              // live values at evaluation time, so a value from getArtifact(),
              // getRemoteState() or an API response lands here without anyone
              // having typed it.
              content: std.join('\n', [
                'declare %s=%s\nexport %s' % [key, shquote(computedOptions.environment.variables[key]), key]
                for key in std.objectFields(computedOptions.environment.variables)
              ]),
              filename: '%s/ENVVARS' % sourceDir,
              file_permission: '0600',
            },
          },
          aws_iam_role_policy_attachment+: {
            ['lambda-%s-%s' % [name, policyName(arn)]]: {
              provider: 'aws.us-east-1',
              role: '${aws_iam_role.lambda-%s.id}' % name,
              policy_arn: arn,
            }
            for arn in computedOptions.execution_policy_attachments
          },
          aws_lambda_permission: {
            ['%s-allowed_arns-%s' % [name, arn[0]]]: all {
              statement_id: '%s-allowed_arns-%s' % [name, arn[0]],
              action: 'lambda:InvokeFunction',
              function_name: '${aws_lambda_function.%s.function_name}' % name,
              principal: arn[1],
            }
            for arn in std.mapWithIndex(
              function(i, x) [i, x],
              computedOptions.arns_allowed_to_invoke
            )
          } + {
            ['%s-allowed_services-%s' % [name, service[0]]]: all + service[1] + {
              statement_id: '%s-allowed_services-%s' % [name, service[0]],
              action: 'lambda:InvokeFunction',
              function_name: '${aws_lambda_function.%s.function_name}' % name,
            }
            for service in std.mapWithIndex(
              function(i, x) [i, x],
              computedOptions.services_allowed_to_invoke
            )
          } + {
            ['%s-trigger-%s' % [name, trigger[0]]]: all {
              statement_id: '%s-trigger-%s' % [name, trigger[0]],
              action: 'lambda:InvokeFunction',
              function_name: '${aws_lambda_function.%s.function_name}' % name,
              principal: 'events.amazonaws.com',
              // Every other line in this block builds '%s-trigger-%s'; this one
              // dropped the literal '-trigger-', so the permission referenced a
              // resource that is never declared and `terraform validate` refused
              // the configuration. The option had never worked.
              source_arn: '${aws_cloudwatch_event_rule.%s-trigger-%s.arn}' % [name, trigger[0]],
            }
            for trigger in std.mapWithIndex(
              function(i, x) [i, x],
              computedOptions.event_triggers
            )
          },
          aws_cloudwatch_event_rule: {
            ['%s-trigger-%s' % [name, trigger[0]]]: trigger[1] + all + {
              name: '%s-trigger-%s' % [name, trigger[0]],
              name_prefix:: null,
            }
            for trigger in std.mapWithIndex(
              function(i, x) [i, x],
              computedOptions.event_triggers
            )
          },
          aws_cloudwatch_event_target: {
            ['%s-trigger-%s' % [name, trigger[0]]]: all {
              // Through the rule's own attribute rather than as a literal. The
              // string is identical either way; the reference is also an
              // ordering constraint, without which Terraform is free to create
              // the target before the rule exists.
              rule: '${aws_cloudwatch_event_rule.%s-trigger-%s.name}' % [name, trigger[0]],
              target_id: '%s-trigger-%s' % [name, trigger[0]],
              arn: '${aws_lambda_function.%s.arn}' % name,
            }
            for trigger in std.mapWithIndex(
              function(i, x) [i, x],
              computedOptions.event_triggers
            )
          },
        },
        data: {
          archive_file: {
            [name]: {
              depends_on: [
                'null_resource.npm_install-%s' % name,
              ],
              type: 'zip',
              source_dir: '%s/' % sourceDir,
              // Build output stays relative to render/ regardless of where the
              // source came from -- it's a build artifact, not source truth,
              // and `name` is already a hard-unique Terraform resource key, so
              // there's no cross-plugin collision risk to worry about here.
              output_path: '${path.module}/../lambda_functions/zip_files/%s.zip' % name,
            },
          },
        },
      });

      // refs:: -- one entry per resource this call manifested, addressed as
      // "<terraform_resource_type>.<the name you passed>". The key is built
      // only from what the caller supplied, never from this plugin's own
      // derivation, because looking a ref up must not require the knowledge
      // refs exists to hand you. `refs` is scoped to this call's return value,
      // so the name alone is unambiguous:
      //
      //   refs['aws_cloudwatch_log_group.s3cache'].retention_in_days   -- a real value
      //   "${%s.arn}" % refs['aws_iam_role.s3cache']._terraform_id      -- a reference
      //
      // The value is the *manifested* object, not the call's input: the caller
      // already knows what they passed, and what they cannot see is what it
      // became (`aws_cloudwatch_log_group`'s name is "/aws/lambda/<name>",
      // derived here and nowhere else). Reading the value off `manifested`
      // rather than rebuilding it also means refs cannot drift from what is
      // actually emitted. `_terraform_id` is the one thing added, carrying the
      // address after this plugin's own naming.
      //
      // Deliberately not built into the object handed to std.prune() above:
      // prune() rebuilds its result by iterating std.objectFields(), which
      // excludes hidden fields, so a refs:: living inside that object would be
      // silently dropped by prune() itself. Merged on afterwards instead.
      local resource = manifested.resource;
      local triggers = std.range(0, std.length(computedOptions.event_triggers) - 1);

      local refs = {
        ['aws_lambda_function.%s' % name]:
          resource.aws_lambda_function[name]
          + { _terraform_id:: 'aws_lambda_function.%s' % name },

        ['null_resource.%s' % name]:
          resource.null_resource['npm_install-%s' % name]
          + { _terraform_id:: 'null_resource.npm_install-%s' % name },

        ['aws_iam_role.%s' % name]:
          resource.aws_iam_role['lambda-%s' % name]
          + { _terraform_id:: 'aws_iam_role.lambda-%s' % name },

        ['aws_iam_role_policy.%s' % name]:
          resource.aws_iam_role_policy['lambda-%s' % name]
          + { _terraform_id:: 'aws_iam_role_policy.lambda-%s' % name },

        ['aws_cloudwatch_log_group.%s' % name]:
          resource.aws_cloudwatch_log_group['lambda-%s' % name]
          + { _terraform_id:: 'aws_cloudwatch_log_group.lambda-%s' % name },

        ['local_file.%s' % name]:
          resource.local_file['lambda-%s_envvars' % name]
          + { _terraform_id:: 'local_file.lambda-%s_envvars' % name },

        // One attachment per policy, including the XRay policy this plugin
        // appends itself -- which the caller has no other way to learn exists.
        // Sub-keyed by the policy's own name, which is both what Terraform's
        // name is built from and derivable from the ARN the caller passed.
        ['aws_iam_role_policy_attachment.%s' % name]: {
          [policyName(arn)]:
            resource.aws_iam_role_policy_attachment['lambda-%s-%s' % [name, policyName(arn)]]
            + { _terraform_id:: 'aws_iam_role_policy_attachment.lambda-%s-%s' % [name, policyName(arn)] }
          for arn in computedOptions.execution_policy_attachments
        },

        // A data source's own reference syntax is "data.<type>.<name>", so
        // that's the type prefix here too -- _terraform_id is then directly
        // usable exactly like every other entry's.
        ['data.archive_file.%s' % name]:
          manifested.data.archive_file[name]
          + { _terraform_id:: 'data.archive_file.%s' % name },
      }

      // The three families below exist only when the options that build them
      // are non-empty. std.prune() removes a family whose comprehension
      // produced nothing, so an entry here would point at a resource that is
      // not in the output -- refs describes what was built, so it is omitted
      // too.
      + (if std.objectHas(resource, 'aws_lambda_permission') then {
        // The one type three different options feed, so an array cannot say
        // which produced what. Sub-keyed by the option responsible, each in
        // the order that option was given.
        ['aws_lambda_permission.%s' % name]: {
          arns_allowed_to_invoke: [
            resource.aws_lambda_permission['%s-allowed_arns-%s' % [name, i]]
            + { _terraform_id:: 'aws_lambda_permission.%s-allowed_arns-%s' % [name, i] }
            for i in std.range(0, std.length(computedOptions.arns_allowed_to_invoke) - 1)
          ],
          services_allowed_to_invoke: [
            resource.aws_lambda_permission['%s-allowed_services-%s' % [name, i]]
            + { _terraform_id:: 'aws_lambda_permission.%s-allowed_services-%s' % [name, i] }
            for i in std.range(0, std.length(computedOptions.services_allowed_to_invoke) - 1)
          ],
          event_triggers: [
            resource.aws_lambda_permission['%s-trigger-%s' % [name, i]]
            + { _terraform_id:: 'aws_lambda_permission.%s-trigger-%s' % [name, i] }
            for i in triggers
          ],
        },
      } else {})

      + (if std.objectHas(resource, 'aws_cloudwatch_event_rule') then {
        ['aws_cloudwatch_event_rule.%s' % name]: [
          resource.aws_cloudwatch_event_rule['%s-trigger-%s' % [name, i]]
          + { _terraform_id:: 'aws_cloudwatch_event_rule.%s-trigger-%s' % [name, i] }
          for i in triggers
        ],
      } else {})

      + (if std.objectHas(resource, 'aws_cloudwatch_event_target') then {
        ['aws_cloudwatch_event_target.%s' % name]: [
          resource.aws_cloudwatch_event_target['%s-trigger-%s' % [name, i]]
          + { _terraform_id:: 'aws_cloudwatch_event_target.%s-trigger-%s' % [name, i] }
          for i in triggers
        ],
      } else {});

      manifested + { refs:: refs },
};

{
  // Required, once per file -- see the README for why there's no unconfigured
  // fallback. `defaults` becomes the options every nodejs_function() call
  // from the returned object starts with; any call can still override any of
  // them. `thisFile` must be `std.thisFile`, passed by you: a real default
  // written *in this file* would itself be lexically bound to this plugin's
  // own path -- std.thisFile names whichever file the token is written in,
  // not whoever calls the function it's used inside -- so it has to come
  // from your own call site, not from here.
  config(defaults={}):
    assert std.objectHas(defaults, 'thisFile') && defaults.thisFile != null : (
      "lambda.config() requires thisFile: pass { thisFile: std.thisFile } from your own " +
      "manifest or plugin file, so source resolves relative to where you are, not to " +
      "this node's own directory inside @c6fc/spellcraft-plugins."
    );
    build(
      defaults.thisFile,
      { [k]: defaults[k] for k in std.objectFields(defaults) if k != 'thisFile' }
    ),

  // Calling nodejs_function() directly, without config() first, is always a
  // mistake -- there is no thisFile that could be correct here (see config()
  // above for why), so this fails immediately and specifically rather than
  // with Jsonnet's generic "field does not exist".
  nodejs_function(name, region, options={})::
    error 'lambda.nodejs_function() must be called through lambda.config({ thisFile: std.thisFile }) -- see the README.',
}
