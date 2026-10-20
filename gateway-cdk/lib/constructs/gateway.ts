import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

import { Construct } from 'constructs';

/**
 * Database used for gateway keys, configuration, and spend tracking.
 */
const DATABASE_NAME = 'litellm';

/**
 * Configuration object loaded by LiteLLM at startup.
 */
const CONFIG_OBJECT_KEY = 'litellm-config.yaml';

/**
 * Properties for the gateway construct.
 */
export type GatewayConstructProps = {

  /**
   * Network shared by the gateway and its optional public entry point.
   */
  readonly vpc: ec2.IVpc;

  /**
   * Private subnets in which to run the LiteLLM tasks.
   */
  readonly serviceSubnets: ec2.SubnetSelection;

  /**
   * Isolated subnets reserved for Aurora.
   */
  readonly databaseSubnets: ec2.SubnetSelection;

  /**
   * Deployment asset containing litellm-config.yaml.
   */
  readonly configSource: s3deploy.ISource;

  /**
   * Pinned LiteLLM database image.
   */
  readonly image: ecs.ContainerImage;

  /**
   * Foundation-model and inference-profile ARNs required by the catalogue.
   */
  readonly bedrockResourceArns: readonly string[];

  /**
   * Existing SageMaker endpoints the gateway may invoke.
   * @default No SageMaker access.
   */
  readonly sagemakerEndpointArns?: readonly string[];

  /**
   * Existing secret containing the raw master key.
   * @default Generate a master key in Secrets Manager.
   */
  readonly masterKeySecret?: secretsmanager.ISecret;

  /**
   * Enable ECS Exec and the task permissions used by SSM sessions.
   * @default true
   */
  readonly enableSsmAccess?: boolean;

  /**
   * Lifecycle for gateway data, generated secrets, and container logs.
   * Access-log buckets are retained separately.
   * @default cdk.RemovalPolicy.DESTROY
   */
  readonly removalPolicy?: cdk.RemovalPolicy.DESTROY | cdk.RemovalPolicy.RETAIN;
};

/**
 * Runs LiteLLM on Fargate with Aurora PostgreSQL
 * and configuration stored in S3.
 */
export class GatewayConstruct extends Construct {

  /**
   * ECS cluster used to discover tasks for SSM sessions.
   */
  public readonly cluster: ecs.ICluster;

  /**
   * Service connected to the optional public-access construct.
   */
  public readonly service: ecs.FargateService;

  /**
   * Bucket containing the gateway configuration.
   */
  public readonly configBucket: s3.IBucket;

  /**
   * Master-key secret used for gateway administration.
   */
  public readonly masterKeySecret: secretsmanager.ISecret;

  /**
   * Container port used for inference and SSM forwarding.
   */
  public readonly port = 4000;

  /**
   * Gateway constructor.
   * @param scope - Parent construct.
   * @param id - Construct identifier.
   * @param props - Network, assets, permissions, and access settings.
   */
  constructor(scope: Construct, id: string, props: GatewayConstructProps) {
    super(scope, id);

    const removalPolicy = props.removalPolicy ?? cdk.RemovalPolicy.DESTROY;
    const isCleanupEnabled = removalPolicy === cdk.RemovalPolicy.DESTROY;
    const sagemakerEndpointArns = props.sagemakerEndpointArns ?? [];

    ///////////////////////////////////////////
    ///////           Secrets           ///////
    ///////////////////////////////////////////

    // Use the supplied master key or generate one.
    const masterKeySecret = props.masterKeySecret ?? new secretsmanager.Secret(this, 'MasterKey', {
      description: 'LiteLLM gateway master key',
      generateSecretString: {
        excludePunctuation: true,
        includeSpace: false,
        passwordLength: 48
      },
      removalPolicy
    });

    // Credentials shared by Aurora and the LiteLLM container.
    const databaseSecret = new rds.DatabaseSecret(this, 'DatabaseCredentials', {
      username: 'postgres'
    });

    ///////////////////////////////////////////
    ///////         Persistence         ///////
    ///////////////////////////////////////////

    // Store virtual keys, configuration, and spend tracking.
    const database = new rds.DatabaseCluster(this, 'Database', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_13
      }),
      credentials: rds.Credentials.fromSecret(databaseSecret, 'postgres'),
      vpc: props.vpc,
      vpcSubnets: props.databaseSubnets,
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 2,
      writer: rds.ClusterInstance.serverlessV2('Writer'),
      defaultDatabaseName: DATABASE_NAME,
      storageEncrypted: true,
      deletionProtection: !isCleanupEnabled,
      removalPolicy
    });

    // Retain the audit bucket after teardown; expire log objects after seven days.
    const accessLogs = new s3.Bucket(this, 'AccessLogs', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [{
        expiration: cdk.Duration.days(7)
      }],
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });

    // Preserve access controls on the retained bucket.
    accessLogs.policy?.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    // Store the model catalogue loaded by LiteLLM.
    const configBucket = new s3.Bucket(this, 'Configuration', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      serverAccessLogsBucket: accessLogs,
      serverAccessLogsPrefix: 'configuration/',
      autoDeleteObjects: isCleanupEnabled,
      removalPolicy
    });

    // Upload the configuration supplied by the stack.
    const configDeployment = new s3deploy.BucketDeployment(this, 'DeployConfiguration', {
      sources: [props.configSource],
      destinationBucket: configBucket
    });

    ///////////////////////////////////////////
    ///////        LiteLLM Service      ///////
    ///////////////////////////////////////////

    // Run the gateway in the supplied VPC.
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc
    });

    // Retain container logs for one week.
    const logGroup = new logs.LogGroup(this, 'Logs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy
    });

    // Inbound access is granted by the public-access construct.
    const serviceSecurityGroup = new ec2.SecurityGroup(this, 'ServiceSecurityGroup', {
      vpc: props.vpc,
      description: 'Network access for LiteLLM tasks'
    });

    // Allocate the gateway's compute resources.
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'Task', {
      cpu: 1024,
      memoryLimitMiB: 3072
    });

    // Keep database credentials for as long as the database.
    databaseSecret.applyRemovalPolicy(removalPolicy);

    // Allow LiteLLM to reach Aurora.
    database.connections.allowDefaultPortFrom(
      serviceSecurityGroup,
      'LiteLLM access to Aurora'
    );

    // Restrict configuration reads to the deployed object.
    taskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [configBucket.arnForObjects(CONFIG_OBJECT_KEY)]
    }));

    // Allow invocation of the configured Bedrock resources.
    if (props.bedrockResourceArns.length > 0) {
      taskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
        actions: [
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream'
        ],
        resources: [...props.bedrockResourceArns]
      }));
    }

    // Allow invocation of explicitly supplied SageMaker endpoints.
    if (sagemakerEndpointArns.length > 0) {
      taskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
        actions: [
          'sagemaker:InvokeEndpoint',
          'sagemaker:InvokeEndpointWithResponseStream'
        ],
        resources: [...sagemakerEndpointArns]
      }));
    }

    // Inject credentials at startup and disable API documentation.
    taskDefinition.addContainer('LiteLLM', {
      containerName: 'litellm',
      image: props.image,
      essential: true,
      linuxParameters: new ecs.LinuxParameters(this, 'LinuxParameters', {
        initProcessEnabled: true
      }),
      // ECS Exec requires a writable container filesystem.
      readonlyRootFilesystem: false,
      secrets: {
        LITELLM_MASTER_KEY: ecs.Secret.fromSecretsManager(masterKeySecret),
        DATABASE_USERNAME: ecs.Secret.fromSecretsManager(
          databaseSecret,
          'username'
        ),
        DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(
          databaseSecret,
          'password'
        )
      },
      environment: {
        DATABASE_HOST: `${database.clusterEndpoint.hostname}:${database.clusterEndpoint.port}`,
        DATABASE_NAME,
        LITELLM_CONFIG_BUCKET_NAME: configBucket.bucketName,
        LITELLM_CONFIG_BUCKET_OBJECT_KEY: CONFIG_OBJECT_KEY,
        AWS_REGION: cdk.Stack.of(this).region,
        NO_DOCS: 'true',
        NO_REDOC: 'true',
        NO_OPENAPI: 'true'
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'litellm',
        logGroup
      }),
      portMappings: [{
        containerPort: this.port
      }]
    });

    // Keep tasks private and enable SSM access by default.
    this.service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: props.serviceSubnets,
      securityGroups: [serviceSecurityGroup],
      enableExecuteCommand: props.enableSsmAccess ?? true,
      // Roll tasks after a changed configuration asset has been uploaded.
      forceNewDeployment: {
        enabled: true,
        nonce: cdk.Fn.select(0, configDeployment.objectKeys)
      },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: {
        rollback: true
      }
    });

    // Start tasks after the database and configuration are ready.
    this.service.node.addDependency(database, configDeployment);

    this.cluster = cluster;
    this.configBucket = configBucket;
    this.masterKeySecret = masterKeySecret;
  }
}
