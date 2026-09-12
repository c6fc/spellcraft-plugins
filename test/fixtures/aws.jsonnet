// Ported from spellcraft-aws-s3/test.jsonnet, spellcraft-aws-lambda/test.jsonnet
// and spellcraft-aws-terraform/test.jsonnet, which were three files in three
// packages reaching each other through three imports. One import now.
local plugins = import '@c6fc/spellcraft-plugins/module.libsonnet';

local auth = plugins.aws.auth;
local terraform = plugins.aws.terraform;
local s3 = plugins.aws.terraform.s3;
local lambda = plugins.aws.terraform.lambda.config({ thisFile: std.thisFile });

local accountId = auth.getCallerIdentity().Account;

{
  'providers.tf.json': { provider: terraform.providerAliases('us-west-2') },

  's3_default.tf.json': s3.bucket('test-bucket-default', 'us-east-1'),
  's3_static-site.tf.json': s3.bucket('test-bucket-static-site', 'us-east-1', { type: 'static-site' }),
  's3_log-storage.tf.json': s3.bucket('test-bucket-log-storage', 'us-east-1', { type: 'log-storage' }),

  'lambda-defaults.tf.json': lambda.nodejs_function('my_test_function', 'us-east-1'),
  'lambda-custom-iam.tf.json': lambda.nodejs_function('my_test_function', 'us-east-1', {
    timeout: 1,
    memory_size: 128,
    environment: { variables: { MYENVVAR: 'This will be passed as an envvar' } },
    arns_allowed_to_invoke: ['arn:aws:iam::%s:root' % accountId],
    execution_policy_attachments: ['arn:aws:iam::aws:policy/AWSS3ReadOnlyAccess'],
    execution_policy_statements: [{ Effect: 'Deny', Action: 's3:*', Resource: '*' }],
    services_allowed_to_invoke: [{
      principal: 'apigateway.amazonaws.com',
      source_arn: 'arn:aws:execute-api:us-east-1:%s:*/*' % accountId,
    }],
    retain_logs_on_destroy: false,
  }),

  'regions.txt': std.join(',', auth.getRegionsList()),
}
