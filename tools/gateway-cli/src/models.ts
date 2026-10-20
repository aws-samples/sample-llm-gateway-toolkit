import { createGatewayHeaders } from './connection.ts';
import { MODEL_LIST_SCHEMA } from './schemas/model-list.ts';
import { MODEL_SCHEMA } from './schemas/model.ts';

import type { GatewayConnection } from './connection.ts';

/**
 * Maximum time to retrieve model metadata, in milliseconds.
 */
const REQUEST_TIMEOUT = 10_000;

/**
 * Maximum model-list response size, in bytes.
 */
const MAX_MODEL_LIST_BYTES = 1_048_576;

/**
 * Reads a bounded model-list response and validates its envelope.
 * @param response - Successful response from the gateway.
 * @param signal - Cancellation controlled by the CLI.
 */
const readModelList = async (response: Response, signal: AbortSignal) => {
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    if (response.body === null) {
      throw new Error('Empty model-list response.');
    }

    for await (const chunk of response.body) {
      size += chunk.byteLength;

      if (size > MAX_MODEL_LIST_BYTES) {
        throw new Error('Model-list response is too large.');
      }

      chunks.push(chunk);
    }

    const document: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));

    return (MODEL_LIST_SCHEMA.parse(document).data);
  } catch {
    signal.throwIfAborted();
    throw new Error(
      'Could not read the gateway model list. ' +
      'Check your connection or ask your administrator to check the deployment.'
    );
  }
};

/**
 * Reads the models available to the active virtual key.
 * @param connection - Credentials for the active gateway connection.
 * @param signal - Cancellation controlled by the CLI.
 */
export const getGatewayModels = async (
  connection: GatewayConnection,
  signal: AbortSignal
) => {
  const headers = createGatewayHeaders(connection);

  headers.set('accept', 'application/json');

  const response = await fetch(`${connection.gatewayUrl}/v1/models`, {
    headers,
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT)])
  }).catch(() => {
    signal.throwIfAborted();
    throw new Error('Cannot reach the gateway. Check your connection and try again.');
  });

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Gateway model lookup failed (HTTP ${response.status}).`, {
      cause: response
    });
  }

  return (await readModelList(response, signal));
};

/**
 * Resolves an accessible model and its token limits before starting OpenCode.
 * @param connection - Credentials for the active gateway connection.
 * @param modelId - Model alias selected by the developer.
 * @param signal - Cancellation controlled by the CLI.
 */
export const getGatewayModel = async (
  connection: GatewayConnection,
  modelId: string,
  signal: AbortSignal
) => {
  const models = await getGatewayModels(connection, signal);
  const model = models.find(candidate => candidate.id === modelId);

  if (model === undefined) {
    throw new Error(
      `Model ${JSON.stringify(modelId)} is not available to this virtual key.`
    );
  }

  const result = MODEL_SCHEMA.safeParse(model);

  if (!result.success) {
    throw new Error(
      'This model does not advertise valid token limits. ' +
      'Ask your administrator to check its LiteLLM configuration.'
    );
  }

  return (result.data);
};
