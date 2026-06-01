import { TextDecoder } from 'util';

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export function decodeTextFile(buffer: Buffer): string | null {
  if (!buffer.length) {
    return '';
  }

  if (buffer.includes(0)) {
    return null;
  }

  const sampleSize = Math.min(buffer.length, 1024);
  let controlCharCount = 0;
  for (let i = 0; i < sampleSize; i += 1) {
    const byte = buffer[i];
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      controlCharCount += 1;
    }
  }

  if (controlCharCount / sampleSize > 0.2) {
    return null;
  }

  try {
    return utf8Decoder.decode(buffer);
  } catch {
    return null;
  }
}
