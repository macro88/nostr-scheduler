import { hexPubkey, npub, type HexPubkey, type Npub } from "./brand.ts";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: readonly number[]): number {
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i += 1) {
      if ((top >> i) & 1) chk ^= GENERATOR[i] ?? 0;
    }
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const char of hrp) out.push(char.charCodeAt(0) >> 5);
  out.push(0);
  for (const char of hrp) out.push(char.charCodeAt(0) & 31);
  return out;
}

function convertBits(data: readonly number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) throw new Error("invalid bech32 data");
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    throw new Error("invalid bech32 padding");
  }
  return out;
}

export function encodeBech32(hrp: string, data: Uint8Array): string {
  const five = convertBits([...data], 8, 5, true);
  const values = [...hrpExpand(hrp), ...five, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ 1;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i += 1) checksum.push((mod >> (5 * (5 - i))) & 31);
  return hrp + "1" + [...five, ...checksum].map((part) => CHARSET[part] ?? "").join("");
}

export function decodeBech32(value: string): { hrp: string; data: Uint8Array } {
  const lower = value.toLowerCase();
  if (value !== lower && value !== value.toUpperCase()) throw new Error("mixed-case bech32");
  const pos = lower.lastIndexOf("1");
  if (pos < 1 || pos + 7 > lower.length) throw new Error("invalid bech32");
  const hrp = lower.slice(0, pos);
  const words: number[] = [];
  for (const char of lower.slice(pos + 1)) {
    const index = CHARSET.indexOf(char);
    if (index === -1) throw new Error("invalid bech32 character");
    words.push(index);
  }
  if (polymod([...hrpExpand(hrp), ...words]) !== 1) throw new Error("bad bech32 checksum");
  const payload = convertBits(words.slice(0, -6), 5, 8, false);
  return { hrp, data: Uint8Array.from(payload) };
}

export function npubFromPubkey(pubkey: HexPubkey): Npub {
  const bytes = Uint8Array.from(Buffer.from(pubkey, "hex"));
  return npub(encodeBech32("npub", bytes));
}

export function pubkeyFromNpub(value: Npub): HexPubkey {
  const decoded = decodeBech32(value);
  if (decoded.hrp !== "npub" || decoded.data.length !== 32) {
    throw new Error("invalid npub");
  }
  return hexPubkey(Buffer.from(decoded.data).toString("hex"));
}
