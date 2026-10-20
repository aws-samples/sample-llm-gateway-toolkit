import * as cdk from 'aws-cdk-lib';

import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import { AwsSolutionsChecks } from 'cdk-nag';
import { flattenCfnReference } from 'cdk-nag/lib/utils/flatten-cfn-reference';

import type { IConstruct } from 'constructs';
import type { GatewayStack } from '../lib/gateway-stack';
import type { PublicAccessConstruct } from '../lib/constructs/public-access';

/**
 * CDK-managed logging policy used by deployment and replicated edge functions.
 */
const LAMBDA_LOGGING_RULE = 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]';

/**
 * Enables AWS Solutions checks and records the demo's resource-specific exceptions.
 * @param app - Application, including the generated Lambda@Edge stack.
 * @param stack - Gateway deployment.
 */
export const configureNag = (app: cdk.App, stack: GatewayStack) => {
  cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, {
    verbose: true,
    writeSuppressionsToCloudFormation: true
  }));

  acknowledgeGateway(stack);
  acknowledgeDeployment(stack);

  if (stack.publicAccess) {
    acknowledgePublicAccess(stack.publicAccess);
  }
};

/**
 * Records choices that apply to both access modes.
 * @param stack - Gateway deployment.
 */
const acknowledgeGateway = (stack: GatewayStack) => {
  const gateway = stack.gateway;
  const task = gateway.service.taskDefinition;

  acknowledge(stack.vpc,
    'VPC Flow Logs are intentionally disabled for this demo; LiteLLM and public request logs provide application diagnostics.',
    'AwsSolutions-VPC7'
  );
  acknowledge(gateway.masterKeySecret,
    'The master key is injected at task startup. Rotation requires a coordinated gateway update and must not run independently.',
    'AwsSolutions-SMG4'
  );
  acknowledge(gateway.node.findChild('DatabaseCredentials'),
    'LiteLLM receives the database password at task startup; automatic rotation requires coordinated task replacement.',
    'AwsSolutions-SMG4'
  );
  acknowledge(gateway.node.findChild('Database'),
    'LiteLLM uses a Secrets Manager password. IAM authentication would require refreshing database tokens in the application.',
    'AwsSolutions-RDS6'
  );
  acknowledge(gateway.node.findChild('Database'),
    'The demo uses DESTROY for complete cleanup. GatewayConstruct enables deletion protection when its removal policy is RETAIN.',
    'AwsSolutions-RDS10'
  );
  acknowledge(gateway.cluster,
    'Container Insights is omitted to limit demo costs; ECS service metrics and LiteLLM container logs remain available.',
    'AwsSolutions-ECS4'
  );
  acknowledge(task,
    'Plaintext environment values contain only routing and documentation settings. Credentials are injected from Secrets Manager.',
    'AwsSolutions-ECS2'
  );
  acknowledge(task.taskRole,
    'ECS Exec requires ssmmessages channel actions, which do not support resource-level permissions.',
    'AwsSolutions-IAM5[Resource::*]'
  );
  acknowledgeResources(task.taskRole,
    'Model invocation spans Regions for global and geographic inference profiles. Access is limited to Bedrock model and profile resource types.',
    `arn:${stack.partition}:bedrock:*::foundation-model/*`,
    `arn:${stack.partition}:bedrock:*:${stack.account}:inference-profile/*`,
    `arn:${stack.partition}:bedrock:*:${stack.account}:application-inference-profile/*`
  );
};

/**
 * Records the public demo's domain, cost, and logging choices.
 * @param access - Public gateway resources.
 */
const acknowledgePublicAccess = (access: PublicAccessConstruct) => {
  const role = access.authorizer.lambda.role;

  acknowledge(access.userPool,
    'The demo uses Cognito Essentials without MFA; paid Plus threat protection is not enabled.',
    'AwsSolutions-COG8'
  );
  acknowledge(access.userPool,
    'MFA is off to keep the sample simple. Turn it on (required TOTP) for production.',
    'AwsSolutions-COG2'
  );
  acknowledge(access.node.findChild('OriginSecret'),
    'CloudFront and the ALB must receive the same origin credential together. Independent automatic rotation would interrupt access.',
    'AwsSolutions-SMG4'
  );
  acknowledge(access.node.findChild('AccessLogs'),
    'This bucket receives ALB and CloudFront access logs. Logging writes back into the same log bucket would create recursive logs.',
    'AwsSolutions-S1'
  );
  acknowledge(access.distribution,
    'The demo supports developers in any country; no geographic access policy is imposed.',
    'AwsSolutions-CFR1'
  );
  acknowledge(access.distribution,
    'AWS WAF is omitted to avoid fixed demo costs. JWT validation and the inference allowlist remain enforced; these do not replace WAF protection.',
    'AwsSolutions-CFR2'
  );
  acknowledge(access.distribution,
    'The default cloudfront.net certificate keeps deployment domain-free. Its minimum TLS policy is controlled by CloudFront.',
    'AwsSolutions-CFR4'
  );

  if (role) {
    acknowledge(role,
      'Lambda@Edge replicas write logs in execution Regions using the CDK-managed basic execution policy; SSM access is separately resource-scoped.',
      LAMBDA_LOGGING_RULE
    );
  }
};

/**
 * Records permissions and runtime owned by CDK's S3 deployment provider.
 * @param stack - Gateway deployment.
 */
const acknowledgeDeployment = (stack: GatewayStack) => {
  const deployment = stack.gateway.node.findChild('DeployConfiguration');
  const provider = stack.node.children.find((child) =>
    child.node.id.startsWith('Custom::CDKBucketDeployment')
  );
  const assets = deployment.node.findAll()
    .filter((child): child is Asset => child instanceof Asset);

  if (!provider) {
    throw new Error('The CDK bucket deployment provider was not found.');
  }

  acknowledge(provider,
    'aws-cdk-lib supplies and tests the BucketDeployment runtime and its basic Lambda logging policy.',
    'AwsSolutions-L1',
    LAMBDA_LOGGING_RULE
  );
  acknowledge(provider,
    'CDK uses these S3 action families to read deployment assets and synchronize the configuration bucket.',
    'AwsSolutions-IAM5[Action::s3:GetBucket*]',
    'AwsSolutions-IAM5[Action::s3:GetObject*]',
    'AwsSolutions-IAM5[Action::s3:List*]',
    'AwsSolutions-IAM5[Action::s3:Abort*]',
    'AwsSolutions-IAM5[Action::s3:DeleteObject*]'
  );
  acknowledgeResources(provider,
    'The deployment provider synchronizes configuration objects and reads versioned assets from the CDK asset bucket.',
    stack.gateway.configBucket.arnForObjects('*'),
    ...assets.map((asset) => asset.bucket.arnForObjects('*'))
  );
};

/**
 * Acknowledges exact rule IDs on one construct.
 * @param scope - Resource or provider owning the exception.
 * @param reason - Explanation retained in the synthesized template.
 * @param ids - Exact CDK Nag findings.
 */
const acknowledge = (scope: IConstruct, reason: string, ...ids: string[]) => {
  cdk.Validations.of(scope).acknowledge(
    ...ids.map((id) => ({ id, reason }))
  );
};

/**
 * Uses CDK Nag's token formatting for exact, account-independent IAM exceptions.
 * @param scope - Role or deployment provider owning the permission.
 * @param reason - Reason the resource wildcard is required.
 * @param arns - Only the resource patterns reviewed for this permission.
 */
const acknowledgeResources = (scope: IConstruct, reason: string, ...arns: string[]) => {
  const stack = cdk.Stack.of(scope);
  const findings = new Set(arns.map((arn) =>
    `AwsSolutions-IAM5[Resource::${flattenCfnReference(stack.resolve(arn))}]`
  ));

  acknowledge(scope, reason, ...findings);
};
