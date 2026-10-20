/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';

/**
 * OPTIONAL one-time setup for the self-hosting scripts in ./scripts (not part of the gateway).
 *
 * It creates only the standing pieces, so the scripts never need permission to create IAM:
 *   1. a weights bucket,
 *   2. the role the throwaway EC2 "stager" runs as (copies the model from Hugging Face into the bucket),
 *   3. the execution role SageMaker uses to run the endpoint (reads the bucket, pulls the vLLM image).
 *
 * The scripts still do the runtime work: launch and delete the EC2, create and delete the endpoint.
 * The endpoint is NOT part of this stack, so `cdk destroy` does not stop endpoint billing.
 * Order when finished:  1) scripts/deploy_qwen38.py delete   2) cdk destroy
 * (Destroy also DELETES THE WEIGHTS in the bucket; staging again takes minutes.)
 *
 * The names below are the ones the scripts expect (scripts/stage_qwen38_ec2.sh and scripts/deploy_qwen38.py).
 */
const BUCKET_PREFIX = 'sagemaker-qwen38-vllm';       // must match the scripts (BUCKET in the stager, deploy_qwen38.py)
const BUILDER_ROLE_NAME = 'qwen38-stager-builder';   // role + instance profile of the staging EC2
const SAGEMAKER_ROLE_NAME = 'qwen38-sagemaker-exec'; // SageMaker execution role
const MODELS_PREFIX = 'models';                       // the scripts write weights under models/<repo>/
const DLC_ACCOUNT = '763104351884';                   // AWS Deep Learning Containers registry (commercial Regions)
const DLC_REPO = 'vllm';

export class SelfHostingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── 1. Weights bucket ────────────────────────────────────────────────────────────────
    // Deleted with the stack, weights included (the model is public and can be staged again).
    const bucket = new s3.Bucket(this, 'WeightsBucket', {
      // Default name the scripts expect. If a bucket with that name already exists in your account, pick another
      // with `cdk deploy -c weightsBucketName=NAME` and run the scripts with BUCKET=NAME.
      bucketName: (this.node.tryGetContext('weightsBucketName') as string | undefined)
        ?? `${BUCKET_PREFIX}-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      // A failed or interrupted 55 GB upload leaves hidden, billed parts behind: clean them up.
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: cdk.Duration.days(1) }],
    });
    const modelObjects = bucket.arnForObjects(`${MODELS_PREFIX}/*`);

    // ── 2. Role of the staging EC2 ───────────────────────────────────────────────────────
    const builderRole = new iam.Role(this, 'StagerBuilderRole', {
      roleName: BUILDER_ROLE_NAME,
      description: 'Throwaway EC2 that copies model weights from Hugging Face into the weights bucket',
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });
    builderRole.addToPolicy(new iam.PolicyStatement({
      sid: 'WriteWeights',
      actions: ['s3:PutObject', 's3:GetObject', 's3:AbortMultipartUpload'],
      resources: [modelObjects],
    }));
    builderRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ListBucket',
      actions: ['s3:ListBucket'],
      resources: [bucket.bucketArn],
    }));
    builderRole.addToPolicy(new iam.PolicyStatement({
      sid: 'DeleteOwnHeartbeat',   // the progress marker the stager writes next to the weights
      actions: ['s3:DeleteObject'],
      resources: [bucket.arnForObjects(`${MODELS_PREFIX}/*.stager-heartbeat`)],
    }));
    new iam.CfnInstanceProfile(this, 'StagerBuilderProfile', {
      instanceProfileName: BUILDER_ROLE_NAME,
      roles: [builderRole.roleName],
    });

    // ── 3. SageMaker execution role ──────────────────────────────────────────────────────
    // The permissions AWS documents as the minimum for CreateModel with S3 model data and an ECR image:
    // https://docs.aws.amazon.com/sagemaker/latest/dg/sagemaker-roles.html#sagemaker-roles-createmodel-perms
    const sagemakerRole = new iam.Role(this, 'SageMakerExecRole', {
      roleName: SAGEMAKER_ROLE_NAME,
      description: 'Execution role of the self-hosted vLLM SageMaker endpoint',
      // Confused-deputy guard: only SageMaker acting for this account can assume the role.
      assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    });
    sagemakerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadWeights',
      actions: ['s3:GetObject'],
      resources: [modelObjects],
    }));
    sagemakerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ListWeights',
      actions: ['s3:ListBucket'],
      resources: [bucket.bucketArn],
    }));
    sagemakerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'EndpointLogs',
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
      resources: [this.formatArn({
        service: 'logs', resource: 'log-group', resourceName: '/aws/sagemaker/Endpoints/*',
        arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
      })],
    }));
    sagemakerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'EndpointMetrics',      // PutMetricData does not support resource-level permissions
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
    }));
    sagemakerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'EcrLogin',             // GetAuthorizationToken does not support resource-level permissions
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));
    sagemakerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'PullVllmImage',        // only the AWS vLLM Deep Learning Container repository
      actions: ['ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage'],
      resources: [`arn:${this.partition}:ecr:${this.region}:${DLC_ACCOUNT}:repository/${DLC_REPO}`],
    }));

    new cdk.CfnOutput(this, 'WeightsBucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'StagerBuilderRoleName', { value: builderRole.roleName });
    new cdk.CfnOutput(this, 'SageMakerExecRoleArn', { value: sagemakerRole.roleArn });

    this.acknowledgeCdkNagFindings(bucket);
  }

  /**
   * cdk-nag (AwsSolutions pack) acknowledgements, each with its reason. Same conventions as
   * gateway-cdk: base rules use the bare id, granular IAM5 findings are listed one by one.
   */
  private acknowledgeCdkNagFindings(bucket: s3.Bucket): void {
    // cdk-nag prints `<AWS::AccountId>` when the account is unknown at synth time and the real id
    // when credentials resolve it, so match whichever applies.
    const acct = cdk.Token.isUnresolved(this.account) ? '<AWS::AccountId>' : this.account;
    // cdk-nag names the bucket ARN by its logical id, e.g. <WeightsBucket1234ABCD.Arn>
    const bucketArn = '<' + this.getLogicalId(bucket.node.defaultChild as s3.CfnBucket) + '.Arn>';
    const partition = '<AWS::Partition>';   // how cdk-nag prints the partition token
    cdk.Validations.of(this).acknowledge(
      { id: 'AwsSolutions-S1', reason: 'The bucket only holds public model weights that can be staged again; server access logs add cost and no value here. CloudTrail data events are the audit path if needed.' },
      { id: `AwsSolutions-IAM5[Resource::${bucketArn}/models/*]`, reason: 'Object-level access cannot be granted without a key wildcard. Limited to the models/ prefix of the weights bucket; the stager writes the weights there and SageMaker reads them.' },
      { id: `AwsSolutions-IAM5[Resource::${bucketArn}/models/*.stager-heartbeat]`, reason: 'Lets the staging instance delete only its own progress marker, not the weights.' },
      { id: `AwsSolutions-IAM5[Resource::arn:${partition}:logs:${this.region}:${acct}:log-group:/aws/sagemaker/Endpoints/*]`, reason: 'SageMaker writes endpoint logs to /aws/sagemaker/Endpoints/<endpoint-name>; the endpoint name is chosen when the deploy script runs, so it cannot be named here.' },
      { id: 'AwsSolutions-IAM5[Resource::*]', reason: 'cloudwatch:PutMetricData and ecr:GetAuthorizationToken do not support resource-level permissions (AWS documents these as the minimum for a SageMaker execution role).' },
    );
  }
}
