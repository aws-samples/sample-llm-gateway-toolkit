import { join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type * as ecs from 'aws-cdk-lib/aws-ecs';

import { Construct } from 'constructs';
import { buildSync } from 'esbuild';

/**
 * Inference routes exposed through the public entry point.
 */
const INFERENCE_ROUTES = [{
  id: 'Models',
  method: 'GET',
  path: '/models'
}, {
  id: 'ChatCompletions',
  method: 'POST',
  path: '/chat/completions'
}, {
  id: 'Messages',
  method: 'POST',
  path: '/messages'
}, {
  id: 'CountTokens',
  method: 'POST',
  path: '/messages/count_tokens'
}, {
  id: 'Responses',
  method: 'POST',
  path: '/responses'
}, {
  id: 'CompactResponses',
  method: 'POST',
  path: '/responses/compact'
}] as const;

/**
 * Error responses for which CloudFront caching is explicitly disabled.
 */
const ERROR_STATUS_CODES = [400, 403, 404, 405, 414, 500, 501, 502, 503, 504];

/**
 * Properties for public access to the gateway.
 */
export type PublicAccessConstructProps = {

  /**
   * Network shared with the gateway service.
   */
  readonly vpc: ec2.IVpc;

  /**
   * Private subnets in which to place the internal load balancer.
   */
  readonly loadBalancerSubnets: ec2.SubnetSelection;

  /**
   * LiteLLM service receiving permitted inference requests.
   */
  readonly service: ecs.FargateService;

  /**
   * Container port used by LiteLLM.
   */
  readonly port: number;

  /**
   * Redirect URL handled by the local login helper.
   */
  readonly callbackUrl: string;

  /**
   * Lifecycle for identity resources, configuration, and the origin secret.
   * @default cdk.RemovalPolicy.DESTROY
   */
  readonly removalPolicy?: cdk.RemovalPolicy.DESTROY | cdk.RemovalPolicy.RETAIN;
};

/**
 * Provides authentication and private routing for the gateway's public entry point.
 */
export class PublicAccessConstruct extends Construct {

  /**
   * User pool containing the customer-managed gateway users.
   */
  public readonly userPool: cognito.UserPool;

  /**
   * Public OAuth client used by the local login helper.
   */
  public readonly userPoolClient: cognito.UserPoolClient;

  /**
   * Cognito-hosted login domain, requiring no customer DNS name.
   */
  public readonly domain: cognito.UserPoolDomain;

  /**
   * Configuration read by the Lambda@Edge authorizer.
   */
  public readonly configurationParameter: ssm.StringParameter;

  /**
   * Published authorizer version for CloudFront viewer requests.
   */
  public readonly authorizer: lambda.IVersion;

  /**
   * HTTPS entry point used by coding clients.
   */
  public readonly distribution: cloudfront.Distribution;

  /**
   * Public-access constructor.
   * @param scope - Parent construct.
   * @param id - Construct identifier.
   * @param props - Network, gateway service, login callback, and lifecycle.
   */
  constructor(scope: Construct, id: string, props: PublicAccessConstructProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const removalPolicy = props.removalPolicy ?? cdk.RemovalPolicy.DESTROY;
    const parameterName = `/llm-gateway/${stack.stackName}/authorizer`;
    const domainPrefix = cdk.Names.uniqueResourceName(this, {
      maxLength: 32
    }).toLowerCase();

    ///////////////////////////////////////////
    ///////       Authentication        ///////
    ///////////////////////////////////////////

    // Keep user creation under the customer's control.
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false,
      signInCaseSensitive: false,
      signInAliases: {
        email: true
      },
      autoVerify: {
        email: true
      },
      // MFA is off to keep the sample simple. For production, set Mfa.REQUIRED with mfaSecondFactor: { otp: true }.
      mfa: cognito.Mfa.OFF,
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      deletionProtection: removalPolicy === cdk.RemovalPolicy.RETAIN,
      removalPolicy
    });

    // Require an inference scope on tokens accepted by the authorizer.
    const inferenceScope = new cognito.ResourceServerScope({
      scopeName: 'invoke',
      scopeDescription: 'Invoke the LiteLLM gateway'
    });
    const resourceServer = this.userPool.addResourceServer('GatewayApi', {
      identifier: 'gateway',
      scopes: [inferenceScope]
    });
    const oauthScope = cognito.OAuthScope.resourceServer(
      resourceServer,
      inferenceScope
    );

    // Use authorization code flow for clients that cannot keep a client secret.
    this.userPoolClient = this.userPool.addClient('Client', {
      generateSecret: false,
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      authFlows: {
        userSrp: true
      },
      oAuth: {
        flows: {
          authorizationCodeGrant: true
        },
        callbackUrls: [props.callbackUrl],
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          oauthScope
        ]
      },
      accessTokenValidity: cdk.Duration.minutes(15),
      idTokenValidity: cdk.Duration.minutes(15),
      refreshTokenValidity: cdk.Duration.days(7),
      refreshTokenRotationGracePeriod: cdk.Duration.seconds(0)
    });

    // Include the account ID to avoid collisions between customer deployments.
    this.domain = this.userPool.addDomain('Login', {
      cognitoDomain: {
        domainPrefix: `${domainPrefix}-${stack.account}`
      },
      managedLoginVersion: cognito.ManagedLoginVersion.CLASSIC_HOSTED_UI
    });

    ///////////////////////////////////////////
    ///////       Configuration         ///////
    ///////////////////////////////////////////

    // Let CloudFormation write the generated Cognito IDs directly to SSM.
    this.configurationParameter = new ssm.StringParameter(this, 'Configuration', {
      parameterName,
      description: 'Cognito configuration for the LiteLLM edge authorizer',
      tier: ssm.ParameterTier.STANDARD,
      stringValue: stack.toJsonString({
        userPoolId: this.userPool.userPoolId,
        clientId: this.userPoolClient.userPoolClientId,
        scope: oauthScope.scopeName
      })
    });

    // Keep the identity resources and their configuration on the same lifecycle.
    for (const resource of [
      this.userPoolClient,
      resourceServer,
      this.domain,
      this.configurationParameter
    ]) {
      resource.applyRemovalPolicy(removalPolicy);
    }

    ///////////////////////////////////////////
    ///////        Edge Authorizer      ///////
    ///////////////////////////////////////////

    // Bundle the authorizer with the location of its SSM configuration.
    const authorizerCode = lambda.Code.fromAsset(join(__dirname, 'lambdas/authorizer'), {
      assetHashType: cdk.AssetHashType.OUTPUT,
      bundling: {
        image: lambda.Runtime.NODEJS_24_X.bundlingImage,
        // Include the SSM location and login callback in the build cache key.
        environment: {
          CONFIGURATION_REGION: stack.region,
          CONFIGURATION_PARAMETER_NAME: parameterName,
          LOGIN_CALLBACK_URL: props.callbackUrl
        },
        local: {
          /**
           * Compiles the authorizer using the installed esbuild package.
           * @param outputDir - Asset directory provided by CDK.
           */
          tryBundle: (outputDir: string) => {
            buildSync({
              entryPoints: [join(__dirname, 'lambdas/authorizer/index.ts')],
              outfile: join(outputDir, 'index.js'),
              bundle: true,
              minify: true,
              platform: 'node',
              format: 'cjs',
              target: 'node24',
              define: {
                CONFIGURATION_REGION: JSON.stringify(stack.region),
                CONFIGURATION_PARAMETER_NAME: JSON.stringify(parameterName),
                LOGIN_CALLBACK_URL: JSON.stringify(props.callbackUrl)
              }
            });

            return (true);
          }
        }
      }
    });

    // Let CDK manage the function's required us-east-1 placement.
    const authorizer = new cloudfront.experimental.EdgeFunction(this, 'Authorizer', {
      code: authorizerCode,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(5),
      currentVersionOptions: {
        removalPolicy: cdk.RemovalPolicy.RETAIN
      }
    });

    // Allow only the configuration read used by this authorizer.
    authorizer.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [this.configurationParameter.parameterArn]
    }));
    this.authorizer = authorizer.currentVersion;

    ///////////////////////////////////////////
    ///////        Load Balancer        ///////
    ///////////////////////////////////////////

    // Keep the origin credential out of source code and local build output.
    const originSecret = new secretsmanager.Secret(this, 'OriginSecret', {
      description: 'CloudFront origin credential for the LiteLLM gateway',
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 32
      },
      removalPolicy
    });
    const originSecretValue = originSecret.secretValue.unsafeUnwrap();

    // Retain the audit bucket after teardown; expire log objects after seven days.
    const accessLogs = new s3.Bucket(this, 'AccessLogs', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      // CloudFront standard logging requires bucket ACLs.
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      lifecycleRules: [{
        expiration: cdk.Duration.days(7)
      }],
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });

    // Preserve access controls on the retained bucket.
    accessLogs.policy?.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    // Allow outbound traffic only to the registered gateway targets.
    const loadBalancerSecurityGroup = new ec2.SecurityGroup(this, 'LoadBalancerSecurityGroup', {
      vpc: props.vpc,
      description: 'Network access for the internal gateway load balancer',
      allowAllOutbound: false
    });

    // Create the internal application load balancer.
    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
      vpc: props.vpc,
      vpcSubnets: props.loadBalancerSubnets,
      internetFacing: false,
      securityGroup: loadBalancerSecurityGroup,
      dropInvalidHeaderFields: true
    });
    loadBalancer.logAccessLogs(accessLogs, 'alb');

    // Refuse paths and methods without an explicit forwarding rule.
    const listener = loadBalancer.addListener('Http', {
      port: 80,
      open: false,
      defaultAction: elbv2.ListenerAction.fixedResponse(403, {
        contentType: 'application/json',
        messageBody: '{"error":"Access denied"}'
      })
    });
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'GatewayTargets', {
      vpc: props.vpc,
      port: props.port,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [props.service],
      healthCheck: {
        path: '/health/liveliness',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30)
      }
    });

    // Require the origin credential on both supported URL prefixes.
    for (const [index, route] of INFERENCE_ROUTES.entries()) {
      listener.addTargetGroups(route.id, {
        priority: index + 1,
        targetGroups: [targetGroup],
        conditions: [
          elbv2.ListenerCondition.httpHeader('x-cf-origin-secret', [originSecretValue]),
          elbv2.ListenerCondition.httpRequestMethods([route.method]),
          elbv2.ListenerCondition.pathPatterns([route.path, `/v1${route.path}`])
        ]
      });
    }

    ///////////////////////////////////////////
    ///////          CloudFront         ///////
    ///////////////////////////////////////////

    // Discover the regional prefix list without requiring a customer-supplied ID.
    const cloudFrontPrefixList = ec2.PrefixList.fromLookup(this, 'CloudFrontPrefixList', {
      prefixListName: 'com.amazonaws.global.cloudfront.origin-facing'
    });
    loadBalancerSecurityGroup.addIngressRule(
      cloudFrontPrefixList,
      ec2.Port.tcp(80),
      'CloudFront access to the private origin'
    );

    // Reach the internal ALB through a CloudFront-managed VPC connection.
    const vpcOrigin = new cloudfront.VpcOrigin(this, 'VpcOrigin', {
      endpoint: cloudfront.VpcOriginEndpoint.applicationLoadBalancer(loadBalancer),
      httpPort: 80,
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY
    });

    // Wait for the network, listener, and ingress rule before connecting.
    vpcOrigin.node.addDependency(props.vpc, listener, loadBalancerSecurityGroup);

    // Validate inference credentials before reaching the private origin.
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Authenticated public access to the LiteLLM gateway',
      logBucket: accessLogs,
      logFilePrefix: 'cloudfront/',
      logIncludesCookies: false,
      defaultBehavior: {
        origin: origins.VpcOrigin.withVpcOrigin(vpcOrigin, {
          customHeaders: {
            'x-cf-origin-secret': originSecretValue
          },
          readTimeout: cdk.Duration.seconds(60),
          keepaliveTimeout: cdk.Duration.seconds(60)
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        edgeLambdas: [{
          functionVersion: this.authorizer,
          eventType: cloudfront.LambdaEdgeEventType.VIEWER_REQUEST
        }]
      },
      errorResponses: ERROR_STATUS_CODES.map((httpStatus) => ({
        httpStatus,
        ttl: cdk.Duration.seconds(0)
      }))
    });

    // Make the Cognito configuration available before public traffic is accepted.
    this.distribution.node.addDependency(this.configurationParameter);
  }
}
