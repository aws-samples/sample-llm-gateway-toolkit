import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bundlePlugins } from '../../scripts/bundle-plugin.ts';
import { readZipArchive } from '../../scripts/read-archive.ts';

/**
 * The archive reader returns the same fixture as the downloaded payload.
 */
const PAYLOAD = vi.hoisted(() => Buffer.from('plugin fixture'));

vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
  chmod: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn()
}));
vi.mock('../../scripts/read-archive.ts', () => ({
  readDebianArchive: vi.fn(),
  readZipArchive: vi.fn()
}));
vi.mock('../../src/ssm/plugin-assets.ts', async () => {
  const { createHash } = await import('node:crypto');
  const checksum = createHash('sha256').update(PAYLOAD).digest('hex');
  const asset = {
    archive: 'plugin.zip',
    archiveSha256: checksum,
    executable: 'bin/session-manager-plugin',
    executableSha256: checksum
  };

  return ({
    PLUGIN_VERSION: 'test',
    PLUGIN_ASSETS: {
      [`${process.platform}-${process.arch}`]: asset,
      'other-platform': asset
    }
  });
});

/**
 * Keep downloads and installation files inside the test doubles.
 */
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(PAYLOAD)));
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.mocked(readFile).mockRejectedValue(new Error('File not found.'));
  vi.mocked(readZipArchive).mockImplementation((_bytes, paths) => {
    return (new Map([...paths].map(path => [path, PAYLOAD])));
  });
});

/**
 * Restore network access and console output after each test.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * A normal installation must download only the current platform.
 */
test('installs one platform by default', async () => {
  await bundlePlugins();

  expect(fetch).toHaveBeenCalledTimes(1);
  expect(mkdir).toHaveBeenCalledWith(
    expect.stringContaining(`${process.platform}-${process.arch}`),
    { recursive: true }
  );
});

/**
 * Release packaging can still explicitly request every platform.
 */
test('installs all platforms when requested', async () => {
  await bundlePlugins(true);

  expect(fetch).toHaveBeenCalledTimes(2);
  expect(mkdir).toHaveBeenCalledWith(
    expect.stringContaining('other-platform'),
    { recursive: true }
  );
});

/**
 * Repeated installs reuse complete, verified files without network access.
 */
test('reuses a valid installed plugin', async () => {
  vi.mocked(readFile).mockResolvedValue(PAYLOAD);

  await bundlePlugins();

  expect(fetch).not.toHaveBeenCalled();
  expect(writeFile).not.toHaveBeenCalled();
});

/**
 * A changed executable must be replaced from the verified archive.
 */
test('replaces a corrupt cached plugin', async () => {
  vi.mocked(readFile)
    .mockResolvedValue(PAYLOAD)
    .mockResolvedValueOnce(Buffer.from('corrupt plugin'));

  await bundlePlugins();

  expect(fetch).toHaveBeenCalledTimes(1);
});

/**
 * A binary without its license notices is not a complete installation.
 */
test('repairs empty license notices', async () => {
  vi.mocked(readFile)
    .mockResolvedValue(Buffer.alloc(0))
    .mockResolvedValueOnce(PAYLOAD);

  await bundlePlugins();

  expect(fetch).toHaveBeenCalledTimes(1);
});

/**
 * An installed binary that cannot execute must not be reused.
 */
test('repairs a plugin without executable permission', async () => {
  vi.mocked(readFile).mockResolvedValue(PAYLOAD);
  vi.mocked(access).mockRejectedValue(new Error('Permission denied.'));

  await bundlePlugins();

  expect(fetch).toHaveBeenCalledTimes(1);
});

/**
 * Reject a tampered download before extracting or writing any files.
 */
test('rejects an archive with the wrong checksum', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response('invalid archive'));

  await expect(bundlePlugins()).rejects.toThrow('Checksum mismatch');

  expect(readZipArchive).not.toHaveBeenCalled();
  expect(writeFile).not.toHaveBeenCalled();
});
