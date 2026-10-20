import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { CloudFrontResultResponse } from 'aws-lambda';
import type { EdgeAuthSettings } from './schema.js';

/**
 * Browser callback registered with Cognito, supplied by CDK.
 */
declare const LOGIN_CALLBACK_URL: string;

/**
 * Returns the public settings needed to start browser login.
 * @param settings - Validated Cognito configuration from Parameter Store.
 */
export const createDiscoveryResponse = (settings: EdgeAuthSettings) => {
  const { issuer } = CognitoJwtVerifier.parseUserPoolId(settings.userPoolId);

  return ({
    status: '200',
    statusDescription: 'OK',
    headers: {
      'cache-control': [{
        key: 'Cache-Control',
        value: 'no-store'
      }],
      'content-type': [{
        key: 'Content-Type',
        value: 'application/json'
      }]
    },
    body: JSON.stringify({
      issuer,
      clientId: settings.clientId,
      scope: settings.scope,
      callbackUrl: LOGIN_CALLBACK_URL
    })
  } satisfies CloudFrontResultResponse);
};
