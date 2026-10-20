import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PLUGIN_ASSETS, PLUGIN_VERSION } from '../src/ssm/plugin-assets.ts';
import { readDebianArchive, readZipArchive } from './read-archive.ts';

/**
 * Generated binaries included in the distributed CLI.
 */
const PLUGIN_DIRECTORY = fileURLToPath(
  new URL('../vendor/session-manager-plugin/', import.meta.url)
);

/**
 * Original license notices retained alongside each executable.
 */
const NOTICE_FILES = ['LICENSE', 'NOTICE', 'THIRD-PARTY'] as const;

/**
 * Maximum download size, in bytes.
 */
const MAX_ARCHIVE_BYTES = 16 * 1_024 * 1_024;

/**
 * Maximum duration of an archive download, in milliseconds.
 */
const DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * Pinned archive metadata for one supported platform.
 */
type PluginAsset = (typeof PLUGIN_ASSETS)[keyof typeof PLUGIN_ASSETS];

/**
 * Rejects content that differs from the reviewed release.
 * @param bytes - Downloaded archive or extracted executable.
 * @param expected - SHA-256 digest recorded in the asset manifest.
 * @param name - Filename included in error messages.
 */
const verifyChecksum = (
  bytes: Uint8Array,
  expected: string,
  name: string
) => {
  const actual = createHash('sha256').update(bytes).digest('hex');

  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${name}.`);
  }
};

/**
 * Reuses a verified executable when its license notices are also present.
 * @param directory - Platform-specific installation directory.
 * @param asset - Reviewed executable path and checksum.
 */
const hasBundledPlugin = async (directory: string, asset: PluginAsset) => {
  const executable = join(directory, posix.basename(asset.executable));

  try {
    const [bytes, ...notices] = await Promise.all([
      readFile(executable),
      ...NOTICE_FILES.map(name => readFile(join(directory, name)))
    ]);

    await access(executable, constants.X_OK);
    verifyChecksum(bytes, asset.executableSha256, executable);

    return (notices.every(notice => notice.byteLength > 0));
  } catch {
    return (false);
  }
};

/**
 * Downloads a bounded archive directly from AWS.
 * @param archive - Relative path within the pinned plugin release.
 */
const downloadArchive = async (archive: string) => {
  const url = new URL(
    archive,
    `https://s3.amazonaws.com/session-manager-downloads/plugin/${PLUGIN_VERSION}/`
  );
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  });
  const chunks: Uint8Array[] = [];
  let size = 0;

  if (!response.ok || !response.body) {
    throw new Error(`Cannot download ${archive}: HTTP ${response.status}.`);
  }

  for await (const chunk of response.body) {
    size += chunk.byteLength;

    if (size > MAX_ARCHIVE_BYTES) {
      throw new Error(`Archive exceeds the download limit: ${archive}.`);
    }

    chunks.push(chunk);
  }

  return (Buffer.concat(chunks));
};

/**
 * Packages one executable with its original license notices.
 * @param platform - Node.js platform and architecture.
 * @param asset - Reviewed archive paths and checksums.
 */
const bundlePlugin = async (platform: string, asset: PluginAsset) => {
  const destination = join(PLUGIN_DIRECTORY, platform);

  if (await hasBundledPlugin(destination, asset)) {
    console.info(`Session Manager plugin ${PLUGIN_VERSION} is ready: ${platform}`);
    return;
  }

  const archive = await downloadArchive(asset.archive);
  const root = posix.dirname(posix.dirname(asset.executable));
  const paths = new Set([
    asset.executable,
    ...NOTICE_FILES.map(name => posix.join(root, name))
  ]);

  // Verify the complete download before parsing either archive format.
  verifyChecksum(archive, asset.archiveSha256, asset.archive);

  const payload = 'nestedArchive' in asset
    ? readZipArchive(archive, new Set([asset.nestedArchive]))
      .get(asset.nestedArchive)
    : archive;

  if (!payload) {
    throw new Error(`Missing nested package in ${asset.archive}.`);
  }

  const files = asset.archive.endsWith('.deb')
    ? await readDebianArchive(archive, paths)
    : readZipArchive(payload, paths);
  const entries = [...paths].map(path => {
    const bytes = files.get(path);
    const isExecutable = path === asset.executable;

    if (!bytes?.byteLength) {
      throw new Error(`Missing ${path} in ${asset.archive}.`);
    }

    if (isExecutable) {
      verifyChecksum(bytes, asset.executableSha256, path);
    }

    return ({
      name: posix.basename(path),
      bytes,
      mode: isExecutable ? 0o755 : 0o644
    });
  });

  // All required files are verified before creating the platform directory.
  await mkdir(destination, {
    recursive: true
  });
  await Promise.all(entries.map(async ({ name, bytes, mode }) => {
    const path = join(destination, name);

    await writeFile(path, bytes, {
      mode
    });
    // writeFile only applies its mode when creating a new file.
    await chmod(path, mode);
  }));

  console.info(`Bundled Session Manager plugin ${PLUGIN_VERSION}: ${platform}`);
};

/**
 * Installs this machine's plugin, or every platform for distribution.
 * @param isAllPlatforms - Include all supported platforms in a release package.
 */
export const bundlePlugins = async (isAllPlatforms = false) => {
  const platform = `${process.platform}-${process.arch}`;
  const assets = Object.entries(PLUGIN_ASSETS)
    .filter(([name]) => isAllPlatforms || name === platform);
  const results = await Promise.allSettled(
    assets.map(([name, asset]) => bundlePlugin(name, asset))
  );

  if (!assets.length) {
    console.info(`SSM is unavailable on ${platform}; public access is supported.`);
  }

  // Finish outstanding writes before reporting a packaging failure.
  for (const result of results) {
    if (result.status === 'rejected') {
      throw result.reason;
    }
  }
};

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      all: {
        type: 'boolean',
        default: false
      }
    }
  });

  await bundlePlugins(values.all);
}
