// Shared helper for decoding a `ws` WebSocket frame to a UTF-8 string.
//
// The `ws` library's RawData type is `Buffer | ArrayBuffer | Buffer[]`,
// and a naive `Buffer.from(data as Buffer)` cast goes subtly wrong for
// the array variant (gets the first element only) and outright errors
// for the ArrayBuffer variant on some Node versions. This helper covers
// all four shapes the channel can deliver -- string, Buffer, Buffer[],
// ArrayBuffer -- with safe per-shape handling.

import type WebSocket from 'ws';

export function wsDataToUtf8(data: WebSocket.RawData | string): string | undefined {
  try {
    if (typeof data === 'string') {
      return data;
    }
    if (Buffer.isBuffer(data)) {
      return data.toString('utf8');
    }
    if (Array.isArray(data)) {
      // ws fragments large frames into Buffer[].
      return Buffer.concat(data).toString('utf8');
    }
    // ArrayBuffer / SharedArrayBuffer / TypedArray view.
    return Buffer.from(data as ArrayBuffer).toString('utf8');
  } catch {
    return undefined;
  }
}
