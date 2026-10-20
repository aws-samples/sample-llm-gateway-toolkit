import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { checkGatewayApi } from '../../src/doctor/api.ts';
import { checkSsmGateway } from '../../src/doctor/ssm.ts';
import { getGateway } from '../../src/ssm/gateway.ts';
import { createVirtualKeyStore } from '../../src/ssm/key-store.ts';
import { openTunnel } from '../../src/ssm/tunnel.ts';
import type { GatewayConnection } from '../../src/connection.ts';
import type { DoctorCheck } from '../../src/doctor/output.ts';

vi.mock('../../src/ssm/gateway.ts', () => ({
  getGateway: vi.fn()
}));
vi.mock('../../src/ssm/key-store.ts', () => ({
  createVirtualKeyStore: vi.fn()
}));
vi.mock('../../src/ssm/tunnel.ts', () => ({
  openTunnel: vi.fn()
}));

/**
 * Public credentials used only by the simulated HTTP transport.
 */
const CONNECTION = {
  transport: 'public',
  gatewayUrl: 'https://gateway.example',
  apiKey: 'test-virtual-key',
  accessToken: 'test-access-token'
} satisfies GatewayConnection;

/**
 * AWS settings for the simulated private deployment.
 */
const SSM_OPTIONS = {
  stack: 'ExampleGateway',
  region: 'eu-west-1'
};

/**
 * Cleanup operation owned by each diagnostic tunnel.
 */
const CLOSE_TUNNEL = vi.fn<() => Promise<void>>();

/**
 * Simulate external services while retaining API validation and cleanup logic.
 */
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', vi.fn<typeof fetch>());
  CLOSE_TUNNEL.mockResolvedValue(undefined);

  vi.mocked(getGateway).mockResolvedValue({
    stack: 'arn:aws:cloudformation:eu-west-1:123456789012:stack/ExampleGateway/test',
    region: SSM_OPTIONS.region,
    gatewayUrl: undefined,
    target: 'ecs:example_task_container',
    remotePort: 4000
  });
  vi.mocked(createVirtualKeyStore).mockResolvedValue({
    load: vi.fn().mockResolvedValue(CONNECTION.apiKey),
    save: vi.fn(),
    clear: vi.fn()
  });
  vi.mocked(openTunnel).mockResolvedValue({
    url: 'http://localhost:4000',
    signal: new AbortController().signal,
    close: CLOSE_TUNNEL
  });
});

/**
 * Restore the real HTTP transport after each diagnostic test.
 */
afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Verify both authentication headers without issuing an inference request.
 */
test('checks authenticated model access without inference', async () => {
  vi.mocked(fetch).mockImplementation(async (input, options) => {
    const headers = new Headers(options?.headers);

    expect(input).toBe(`${CONNECTION.gatewayUrl}/v1/models`);
    expect(options?.method ?? 'GET').toBe('GET');
    expect(options?.redirect).toBe('error');
    expect(headers.get('authorization')).toBe(`Bearer ${CONNECTION.accessToken}`);
    expect(headers.get('x-litellm-api-key')).toBe(`Bearer ${CONNECTION.apiKey}`);

    return (Response.json({
      data: [{
        id: 'example-model'
      }]
    }));
  });

  const result = await checkGatewayApi(CONNECTION, new AbortController().signal);

  expect(result.status).toBe('pass');
  expect(fetch).toHaveBeenCalledTimes(1);
});

/**
 * Authentication failures must provide recovery guidance without exposing bodies.
 */
test.each([401, 403])('reports HTTP %i without leaking response content', async status => {
  vi.mocked(fetch).mockResolvedValue(new Response('sensitive-response-content', {
    status
  }));

  const result = await checkGatewayApi(CONNECTION, new AbortController().signal);

  expect(result).toMatchObject({
    status: 'fail',
    action: 'Run: gateway login'
  });
  expect(JSON.stringify(result)).not.toContain('sensitive-response-content');
});

/**
 * Authentication alone is insufficient when the key cannot access any model.
 */
test('reports a key with no available models', async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({
    data: []
  }));

  const result = await checkGatewayApi(CONNECTION, new AbortController().signal);

  expect(result.status).toBe('fail');
  expect(result.detail).toContain('no models');
});

/**
 * A rejected virtual key must not leave the diagnostic tunnel open.
 */
test('closes the private tunnel after authentication fails', async () => {
  const checks: DoctorCheck[] = [];

  vi.mocked(fetch).mockResolvedValue(new Response(null, {
    status: 401
  }));

  await checkSsmGateway(
    SSM_OPTIONS,
    new AbortController().signal,
    check => checks.push(check)
  );

  expect(checks).toContainEqual(expect.objectContaining({
    label: 'LiteLLM API',
    status: 'fail'
  }));
  expect(checks.at(-1)).toMatchObject({
    label: 'Tunnel cleanup',
    status: 'pass'
  });
  expect(CLOSE_TUNNEL).toHaveBeenCalledTimes(1);
});

/**
 * Ctrl+C must propagate only after the diagnostic session is closed.
 */
test('closes the private tunnel before propagating cancellation', async () => {
  const controller = new AbortController();
  const reason = new Error('Cancelled.');

  vi.mocked(fetch).mockImplementation(async () => {
    controller.abort(reason);
    throw (reason);
  });

  await expect(checkSsmGateway(
    SSM_OPTIONS,
    controller.signal,
    () => {}
  )).rejects.toBe(reason);

  expect(CLOSE_TUNNEL).toHaveBeenCalledTimes(1);
});

/**
 * An AWS cleanup failure must remain visible even after a successful API check.
 */
test('reports failed tunnel cleanup', async () => {
  const checks: DoctorCheck[] = [];

  vi.mocked(fetch).mockResolvedValue(Response.json({
    data: [{
      id: 'example-model'
    }]
  }));
  CLOSE_TUNNEL.mockRejectedValue(new Error('Cleanup failed.'));

  await checkSsmGateway(
    SSM_OPTIONS,
    new AbortController().signal,
    check => checks.push(check)
  );

  expect(checks.at(-1)).toMatchObject({
    label: 'Tunnel cleanup',
    status: 'fail'
  });
  expect(CLOSE_TUNNEL).toHaveBeenCalledTimes(1);
});
