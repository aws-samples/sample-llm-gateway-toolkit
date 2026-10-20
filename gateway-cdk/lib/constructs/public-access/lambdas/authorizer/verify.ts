import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { FetchError } from 'aws-jwt-verify/error';
import type { CloudFrontRequestEvent, CloudFrontResultResponse } from 'aws-lambda';
import type { JwksCache } from 'aws-jwt-verify/jwk';

import {
  AUTHORIZATION_SCHEMA,
  EDGE_AUTH_SCHEMA,
  TOKEN_EXPIRY_SCHEMA
} from './schema.js';

/**
 * Rejects a request without exposing credentials or verifier errors.
 */
export const rejectRequest = (status: '401' | '503') => {
  return ({
    status,
    statusDescription: status === '401' ? 'Unauthorized' : 'Service Unavailable',
    headers: {
      'cache-control': [{
        key: 'Cache-Control',
        value: 'no-store'
      }],
      'content-type': [{
        key: 'Content-Type',
        value: 'application/json'
      }],
      ...(status === '401' ? {
        'www-authenticate': [{
          key: 'WWW-Authenticate',
          value: 'Bearer'
        }]
      } : {})
    },
    body: JSON.stringify({
      error: status === '401' ? 'unauthorized' : 'authentication_unavailable'
    })
  } satisfies CloudFrontResultResponse);
};

/**
 * Creates the viewer-request handler for a Cognito user pool.
 * @param configuration - Cognito settings read from Parameter Store.
 * @param jwksCache - Optional public-key cache for isolated tests.
 */
export const createEdgeAuth = (
  configuration: unknown,
  jwksCache?: JwksCache
) => {
  const settings = EDGE_AUTH_SCHEMA.parse(configuration);
  const verifier = CognitoJwtVerifier.create({
    ...settings,
    tokenUse: 'access'
  }, jwksCache === undefined ? undefined : {
    jwksCache
  });

  /**
   * Verifies the access token and preserves the complete inference request.
   */
  const handleRequest = async (event: CloudFrontRequestEvent) => {
    const request = event.Records[0]?.cf.request;
    const authorization = AUTHORIZATION_SCHEMA.safeParse(
      request?.headers.authorization
    );

    // Reject the request if the authorization header is missing or malformed.
    if (request === undefined || !authorization.success) {
      return (rejectRequest('401'));
    }

    try {
      // Get the bearer token from the authorization header.
      const token = authorization.data[0].value.slice('Bearer '.length);

      // Verify the token using the Cognito JWT verifier.
      const payload = await verifier.verify(token);

      // Validate the token's expiry using the defined schema.
      TOKEN_EXPIRY_SCHEMA.parse(payload);

      return (request);
    } catch (error) {
      return (rejectRequest(error instanceof FetchError ? '503' : '401'));
    }
  };

  return (handleRequest);
};
