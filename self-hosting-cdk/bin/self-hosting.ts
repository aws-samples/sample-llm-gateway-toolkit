#!/usr/bin/env node
/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { SelfHostingStack } from '../lib/self-hosting-stack';

const app = new cdk.App();
cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));

// Region rule: the SAME as the scripts in ./scripts (AWS_REGION, else SAGEMAKER_REGION, else
// eu-north-1). The weights bucket name contains the region, so the stack and the scripts must agree.
// This deliberately ignores the default region of your AWS profile.
new SelfHostingStack(app, 'LlmGatewayToolkit-SelfHosting', {
  env: {
    region: process.env.AWS_REGION || process.env.SAGEMAKER_REGION || 'eu-north-1',
    account: process.env.CDK_DEFAULT_ACCOUNT,
  },
  description: 'AWS LlmGatewayToolkit-SelfHosting stack (uksb-c3byu8t03y).'
});
