import * as nodeZlib from "node:zlib";

/** `zlib.crc32` exists from Node 22.2; typed loosely so older @types/node still compile. */
export const zlib = nodeZlib as typeof nodeZlib & { crc32(data: Buffer): number };
