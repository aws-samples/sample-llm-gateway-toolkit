/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */

import { join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { GatewayConstruct } from './constructs/gateway';
import { PublicAccessConstruct } from './constructs/public-access';
import type { Construct } from 'constructs';

/**
 * LiteLLM image validated by the compatibility tests.
 */
const LITELLM_IMAGE = 'litellm/litellm-database:v1.105.1@sha256:2bcadb9905b692a5ca4dadd51bccaaa23a95dc8a0f9322d9c9787f0ac2aeb50e';

/**
 * Callback handled by the local Cognito login helper.
 */
const LOGIN_CALLBACK_URL = 'http://localhost:8765/callback';

/**
 * Optional integrations for the gateway deployment.
 */
export type GatewayStackProps = cdk.StackProps & {

  /**
   * Enable authenticated public inference alongside SSM access.
   * @default false
   */
  readonly isPublicAccessEnabled?: boolean;

  /**
   * Existing secret containing the raw LiteLLM master key.
   * @default Generate a master key in Secrets Manager.
   */
  readonly masterKeySecretArn?: string;

  /**
   * Existing SageMaker endpoints the gateway may invoke.
   * @default No SageMaker access.
   */
  readonly sagemakerEndpointArns?: readonly string[];
};

/**
 * Composes the gateway and its access modes within a private network.
 */
export class GatewayStack extends cdk.Stack {

  /**
   * Network shared by the gateway and public access resources.
   */
  public readonly vpc: ec2.Vpc;

  /**
   * LiteLLM service, persistence, and SSM access.
   */
  public readonly gateway: GatewayConstruct;

  /**
   * Optional authenticated public entry point.
   */
  public readonly publicAccess?: PublicAccessConstruct;

  /**
   * Gateway stack constructor.
   * @param scope - Parent construct.
   * @param id - Stack identifier.
   * @param props - Deployment environment and optional integrations.
   */
  constructor(scope: Construct, id: string, props: GatewayStackProps = {}) {
    super(scope, id, props);

    const removalPolicy = cdk.RemovalPolicy.DESTROY;
    const serviceSubnets = {
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
    };

    // Allow model changes and all inference-profile types without IAM updates.
    const bedrockResourceArns = [
      `arn:${this.partition}:bedrock:*::foundation-model/*`,
      `arn:${this.partition}:bedrock:*:${this.account}:inference-profile/*`,
      `arn:${this.partition}:bedrock:*:${this.account}:application-inference-profile/*`,
      // Native OpenAI-compatible APIs also authorize the default project.
      `arn:${this.partition}:bedrock:${this.region}:${this.account}:project/default`
    ];

    ///////////////////////////////////////////
    ///////           Network           ///////
    ///////////////////////////////////////////

    // Give private tasks outbound access for image pulls and AWS APIs.
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [{
        name: 'Public',
        subnetType: ec2.SubnetType.PUBLIC,
        cidrMask: 24
      }, {
        name: 'Service',
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        cidrMask: 24
      }, {
        name: 'Database',
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        cidrMask: 24
      }],
      gatewayEndpoints: {
        S3: {
          service: ec2.GatewayVpcEndpointAwsService.S3,
          subnets: [serviceSubnets]
        }
      }
    });

    ///////////////////////////////////////////
    ///////           Gateway           ///////
    ///////////////////////////////////////////

    // Keep compute, persistence, and model permissions in the gateway.
    this.gateway = new GatewayConstruct(this, 'Gateway', {
      vpc: this.vpc,
      serviceSubnets,
      databaseSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED
      },
      configSource: s3deploy.Source.asset(join(__dirname, '..', 'config')),
      image: ecs.ContainerImage.fromRegistry(LITELLM_IMAGE),
      bedrockResourceArns,
      sagemakerEndpointArns: props.sagemakerEndpointArns,
      masterKeySecret: props.masterKeySecretArn === undefined
        ? undefined
        : secretsmanager.Secret.fromSecretCompleteArn(
          this,
          'MasterKey',
          props.masterKeySecretArn
        ),
      enableSsmAccess: true,
      removalPolicy
    });

    ///////////////////////////////////////////
    ///////         Public Access       ///////
    ///////////////////////////////////////////

    // Expose inference through Cognito, CloudFront, and an internal ALB.
    if (props.isPublicAccessEnabled) {
      this.publicAccess = new PublicAccessConstruct(this, 'PublicAccess', {
        vpc: this.vpc,
        loadBalancerSubnets: serviceSubnets,
        service: this.gateway.service,
        port: this.gateway.port,
        callbackUrl: LOGIN_CALLBACK_URL,
        removalPolicy
      });

      new cdk.CfnOutput(this, 'GatewayUrl', {
        value: `https://${this.publicAccess.distribution.distributionDomainName}`
      });
      new cdk.CfnOutput(this, 'UserPoolId', {
        value: this.publicAccess.userPool.userPoolId
      });
      new cdk.CfnOutput(this, 'UserPoolClientId', {
        value: this.publicAccess.userPoolClient.userPoolClientId
      });
      new cdk.CfnOutput(this, 'CognitoDomain', {
        value: this.publicAccess.domain.baseUrl()
      });
    }

    ///////////////////////////////////////////
    ///////           Outputs           ///////
    ///////////////////////////////////////////

    // Identify the service used for SSM task discovery and port forwarding.
    new cdk.CfnOutput(this, 'ClusterName', {
      value: this.gateway.cluster.clusterName
    });
    new cdk.CfnOutput(this, 'ServiceName', {
      value: this.gateway.service.serviceName
    });
    new cdk.CfnOutput(this, 'GatewayPort', {
      value: String(this.gateway.port)
    });
    new cdk.CfnOutput(this, 'ConfigBucketName', {
      value: this.gateway.configBucket.bucketName
    });
    new cdk.CfnOutput(this, 'MasterKeySecretArn', {
      value: this.gateway.masterKeySecret.secretArn
    });
  }
}
