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

function convertBits(data: readonly number[], from: number, to: number): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (bits > 0) out.push((acc << (to - bits)) & maxv);
  return out;
}

function encodeBech32(hrp: string, data: Uint8Array): string {
  const five = convertBits([...data], 8, 5);
  const values = [...hrpExpand(hrp), ...five, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ 1;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i += 1) checksum.push((mod >> (5 * (5 - i))) & 31);
  return hrp + "1" + [...five, ...checksum].map((part) => CHARSET[part] ?? "").join("");
}

export function npubFromHex(pubkey: string): string {
  if (!/^[0-9a-f]{64}$/.test(pubkey)) return pubkey;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = Number.parseInt(pubkey.slice(i * 2, i * 2 + 2), 16);
  return encodeBech32("npub", bytes);
}

function convertBitsStrict(data: readonly number[], from: number, to: number): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) throw new Error("invalid bech32 padding");
  return out;
}

export function isNpub(value: string): boolean {
  try {
    if (!value.startsWith("npub1") || value !== value.toLowerCase()) return false;
    const pos = value.lastIndexOf("1");
    const hrp = value.slice(0, pos);
    const words: number[] = [];
    for (const char of value.slice(pos + 1)) {
      const index = CHARSET.indexOf(char);
      if (index === -1) return false;
      words.push(index);
    }
    if (polymod([...hrpExpand(hrp), ...words]) !== 1) return false;
    return convertBitsStrict(words.slice(0, -6), 5, 8).length === 32;
  } catch {
    return false;
  }
}

export function shortNpub(pubkey: string): string {
  const npub = npubFromHex(pubkey);
  if (!npub.startsWith("npub1") || npub.length < 16) return npub;
  return `${npub.slice(0, 9)}…${npub.slice(-4)}`;
}
