/**
 * AWS event-stream (application/vnd.amazon.eventstream) binary framing decoder.
 * Frame: total_len u32 | headers_len u32 | prelude_crc u32 | headers | payload | message_crc u32.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array, start = 0, end = buf.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface EventStreamMessage {
  headers: Record<string, string | number | boolean | Uint8Array>;
  payload: Uint8Array;
}

function parseHeaders(buf: Uint8Array): EventStreamMessage["headers"] {
  const out: EventStreamMessage["headers"] = {};
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const dec = new TextDecoder();
  let i = 0;
  while (i < buf.length) {
    const nameLen = buf[i]!;
    i += 1;
    const name = dec.decode(buf.subarray(i, i + nameLen));
    i += nameLen;
    const type = buf[i]!;
    i += 1;
    switch (type) {
      case 0:
        out[name] = true;
        break;
      case 1:
        out[name] = false;
        break;
      case 2:
        out[name] = view.getInt8(i);
        i += 1;
        break;
      case 3:
        out[name] = view.getInt16(i);
        i += 2;
        break;
      case 4:
        out[name] = view.getInt32(i);
        i += 4;
        break;
      case 5:
      case 8:
        out[name] = Number(view.getBigInt64(i));
        i += 8;
        break;
      case 6:
      case 7: {
        const len = view.getUint16(i);
        i += 2;
        const bytes = buf.subarray(i, i + len);
        out[name] = type === 7 ? dec.decode(bytes) : bytes;
        i += len;
        break;
      }
      case 9:
        out[name] = buf.subarray(i, i + 16);
        i += 16;
        break;
      default:
        throw new Error(`eventstream: unknown header type ${type}`);
    }
  }
  return out;
}

/** Incremental decoder: feed byte chunks, get complete messages. */
export class EventStreamDecoder {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): EventStreamMessage[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    const out: EventStreamMessage[] = [];
    while (this.buf.length >= 12) {
      const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
      const total = view.getUint32(0);
      const headersLen = view.getUint32(4);
      if (total < 16 || total > 16 * 1024 * 1024) throw new Error("eventstream: bad frame length");
      if (this.buf.length < total) break;
      if (crc32(this.buf, 0, 8) !== view.getUint32(8)) throw new Error("eventstream: prelude CRC mismatch");
      if (crc32(this.buf, 0, total - 4) !== view.getUint32(total - 4)) throw new Error("eventstream: message CRC mismatch");
      const headers = parseHeaders(this.buf.subarray(12, 12 + headersLen));
      const payload = this.buf.slice(12 + headersLen, total - 4);
      out.push({ headers, payload });
      this.buf = this.buf.slice(total);
    }
    return out;
  }
}

/** Encoder (string headers only) — used by tests to build recorded-shape frames. */
export function encodeEventStreamMessage(headers: Record<string, string>, payload: Uint8Array | string): Uint8Array {
  const enc = new TextEncoder();
  const p = typeof payload === "string" ? enc.encode(payload) : payload;
  const hparts: number[] = [];
  for (const [k, v] of Object.entries(headers)) {
    const kb = enc.encode(k);
    const vb = enc.encode(v);
    hparts.push(kb.length, ...kb, 7, (vb.length >> 8) & 0xff, vb.length & 0xff, ...vb);
  }
  const h = Uint8Array.from(hparts);
  const total = 12 + h.length + p.length + 4;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, total);
  view.setUint32(4, h.length);
  view.setUint32(8, crc32(out, 0, 8));
  out.set(h, 12);
  out.set(p, 12 + h.length);
  view.setUint32(total - 4, crc32(out, 0, total - 4));
  return out;
}
