import { once } from 'node:events';
import { unzipSync } from 'fflate';
import { Parser } from 'tar';

/**
 * Maximum size of an extracted file, in bytes.
 */
const MAX_FILE_BYTES = 32 * 1_024 * 1_024;

/**
 * Field boundaries in the ar container used by Debian packages.
 */
const AR_FORMAT = {
  signature: '!<arch>\n',
  headerBytes: 60,
  nameEnd: 16,
  sizeStart: 48,
  sizeEnd: 58,
  trailer: '`\n'
} as const;

/**
 * Locates the compressed TAR payload inside an AWS Debian package.
 * @param archive - Package whose checksum has already been verified.
 */
const getDebianPayload = (archive: Buffer) => {
  let offset = AR_FORMAT.signature.length;

  if (archive.toString('ascii', 0, offset) !== AR_FORMAT.signature) {
    throw new Error('Invalid Debian archive signature.');
  }

  while (offset + AR_FORMAT.headerBytes <= archive.length) {
    const header = archive.subarray(offset, offset + AR_FORMAT.headerBytes);
    const name = header
      .toString('ascii', 0, AR_FORMAT.nameEnd)
      .trim()
      .replace(/\/$/, '');
    const size = Number(
      header.toString('ascii', AR_FORMAT.sizeStart, AR_FORMAT.sizeEnd)
    );
    const start = offset + AR_FORMAT.headerBytes;
    const end = start + size;

    if (
      header.toString('ascii', AR_FORMAT.sizeEnd) !== AR_FORMAT.trailer ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      end > archive.length
    ) {
      throw new Error('Invalid Debian archive header.');
    }

    if (name === 'data.tar.gz') {
      return (archive.subarray(start, end));
    }

    // ar members are padded to an even byte boundary.
    offset = end + (size % 2);
  }

  throw new Error('The Debian archive has no data.tar.gz payload.');
};

/**
 * Reads selected ZIP entries without extracting paths to disk.
 * @param archive - Archive whose checksum has already been verified.
 * @param paths - Exact archive paths required by the package.
 */
export const readZipArchive = (
  archive: Uint8Array,
  paths: ReadonlySet<string>
) => {
  const files = unzipSync(archive, {
    filter: entry => {
      return (paths.has(entry.name) && entry.originalSize <= MAX_FILE_BYTES);
    }
  });

  return (new Map(Object.entries(files)));
};

/**
 * Reads selected regular files from an AWS Debian package.
 * @param archive - Package whose checksum has already been verified.
 * @param paths - Exact archive paths required by the package.
 */
export const readDebianArchive = async (
  archive: Buffer,
  paths: ReadonlySet<string>
) => {
  const payload = getDebianPayload(archive);
  const files = new Map<string, Uint8Array>();
  const parser = new Parser({
    strict: true,
    filter: (path, entry) => {
      return (
        paths.has(path) &&
        'type' in entry &&
        entry.type === 'File' &&
        entry.size <= MAX_FILE_BYTES
      );
    },
    onReadEntry: entry => {
      const chunks: Buffer[] = [];

      entry.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      entry.on('end', () => {
        files.set(entry.path, Buffer.concat(chunks));
      });
    }
  });
  const completed = once(parser, 'end');

  // Register completion before parsing, which can finish synchronously.
  parser.end(payload);
  await completed;

  return (files);
};
