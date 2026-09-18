// A minimal USTAR + gzip writer: the browser's own `CompressionStream`
// compresses, so only the tar container needs hand-rolling.

const TAR_BLOCK_SIZE = 512;

export class TarballError extends Error {}

function padOctal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function tarEntry(path: string, content: Uint8Array): Uint8Array {
  if (path.length >= 100) {
    throw new TarballError(`tar entry path ${JSON.stringify(path)} is too long for a USTAR header`);
  }
  const header = new Uint8Array(TAR_BLOCK_SIZE);
  const encoder = new TextEncoder();
  const writeField = (offset: number, value: string): void => {
    header.set(encoder.encode(value), offset);
  };
  writeField(0, path);
  writeField(100, padOctal(0o644, 8));
  writeField(108, padOctal(0, 8));
  writeField(116, padOctal(0, 8));
  writeField(124, padOctal(content.length, 12));
  writeField(136, padOctal(0, 12));
  writeField(148, "        ");
  writeField(156, "0");
  writeField(257, "ustar\0");
  writeField(263, "00");

  let checksum = 0;
  for (const byte of header) checksum += byte;
  // The 8-byte checksum field is 6 octal digits, NUL, space; anything
  // longer spills into the typeflag byte and fails every reader's check.
  writeField(148, checksum.toString(8).padStart(6, "0") + "\0 ");

  const paddedLength = Math.ceil(content.length / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  const body = new Uint8Array(paddedLength);
  body.set(content);

  const entry = new Uint8Array(header.length + body.length);
  entry.set(header, 0);
  entry.set(body, header.length);
  return entry;
}

/** Packs a `{ path: contents }` tree into an npm-shaped gzipped tar
 * archive rooted at `package/`. */
export async function packTarball(tree: Readonly<Record<string, string>>): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const entries: Uint8Array[] = [];
  for (const [path, contents] of Object.entries(tree)) {
    entries.push(tarEntry(`package/${path}`, encoder.encode(contents)));
  }
  const endOfArchive = new Uint8Array(TAR_BLOCK_SIZE * 2);
  const totalLength = entries.reduce((sum, entry) => sum + entry.length, 0) + endOfArchive.length;
  const tar = new Uint8Array(totalLength);
  let offset = 0;
  for (const entry of entries) {
    tar.set(entry, offset);
    offset += entry.length;
  }
  tar.set(endOfArchive, offset);

  const gzipStream = new Blob([tar]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(gzipStream).arrayBuffer());
}
