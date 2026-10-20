import { DISCOVERY_SCHEMA } from './schemas/discovery.ts';
import { GATEWAY_URL_SCHEMA } from './schemas/gateway-url.ts';

/**
 * Maximum time to fetch login settings, in milliseconds.
 */
const DISCOVERY_TIMEOUT = 10_000;

/**
 * Maximum discovery response size, in bytes.
 */
const MAX_DISCOVERY_BYTES = 8_192;

/**
 * Reads the gateway's public login settings without AWS credentials.
 * @param gatewayUrl - Public HTTPS address supplied by the developer.
 */
export const discoverGateway = async (gatewayUrl: string) => {
  const url = GATEWAY_URL_SCHEMA.parse(gatewayUrl);
  const response = await fetch(`${url}/.well-known/llm-gateway`, {
    headers: {
      accept: 'application/json'
    },
    redirect: 'error',
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT)
  }).catch(() => {
    throw new Error(`Cannot reach ${url}. Check the URL and your connection.`);
  });
  const chunks: Uint8Array[] = [];
  let size = 0;

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Gateway discovery failed (HTTP ${response.status}). ` +
      'Ask your administrator to check the deployment.'
    );
  }

  try {
    if (response.body === null) {
      throw new Error('Empty discovery response.');
    }

    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > MAX_DISCOVERY_BYTES) {
        throw new Error('Discovery response is too large.');
      }
      chunks.push(chunk);
    }

    const document: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const settings = DISCOVERY_SCHEMA.parse(document);

    return ({
      url,
      ...settings
    });
  } catch (error) {
    throw new Error(
      'Could not read valid gateway login settings. ' +
      'Check your connection or ask your administrator to check the deployment.',
      { cause: error }
    );
  }
};
