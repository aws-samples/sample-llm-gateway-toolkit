#!/usr/bin/env node

/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */

import * as cdk from 'aws-cdk-lib';
import { GatewayStack } from '../lib/gateway-stack';
import { configureNag } from './cdk-nag';
import { env } from './env';

/**
 * CDK application.
 */
const app = new cdk.App();

/**
 * Create the Gateway stack.
 */
const stack = new GatewayStack(app, 'LlmGatewayToolkit-Gateway', {
  env: {
    region: env.CDK_DEFAULT_REGION,
    account: env.CDK_DEFAULT_ACCOUNT
  },
  // Bootstrap and teardown include the edge stack regardless of deployment mode.
  isPublicAccessEnabled: env.PUBLIC_ACCESS_ENABLED ||
    app.node.tryGetContext('includePublicAccess') === 'true',
  description: 'AWS LlmGatewayToolkit-Gateway stack (uksb-c3byu8t03y).'
});

// Validate both the gateway and CDK's generated Lambda@Edge stack.
configureNag(app, stack);
