/**
 * Exact money arithmetic for the builder. Every amount and quantity is an integer number of
 * millionths (1 JOD = 1,000,000 micro-JOD), held as a bigint so products of large quantities and
 * prices cannot lose precision. Documents are written with six decimals.
 */
export type Micro = bigint;

export const SCALE = 1_000_000n;

/** A non-negative decimal number from user input, in micro units (half-up rounding). */
export function toMicro(n: number): Micro {
  if (!Number.isFinite(n)) throw new RangeError(`${n} is not a finite number`);
  const [int, frac = ''] = Math.abs(n).toFixed(7).split('.');
  const micro = BigInt(int) * SCALE + BigInt(frac.slice(0, 6)) + (Number(frac[6]) >= 5 ? 1n : 0n);
  return n < 0 ? -micro : micro;
}

/** A decimal string from a document ("5.138889", "12", "0.5") in micro units (half-up rounding). */
export function parseMicro(s: string): Micro | undefined {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) return undefined;
  const frac = (m[3] ?? '').padEnd(7, '0');
  const micro = BigInt(m[2]) * SCALE + BigInt(frac.slice(0, 6)) + (Number(frac[6]) >= 5 ? 1n : 0n);
  return m[1] ? -micro : micro;
}

/** Six-decimal text for a micro amount: 5138889n → "5.138889". */
export function format6(v: Micro): string {
  const sign = v < 0n ? '-' : '';
  const a = v < 0n ? -v : v;
  return `${sign}${a / SCALE}.${String(a % SCALE).padStart(6, '0')}`;
}

export const toNumber = (v: Micro): number => Number(v) / 1e6;

/** a ÷ b rounded half-up, for a ≥ 0 and b > 0. */
export function divRound(a: bigint, b: bigint): bigint {
  return (2n * a + b) / (2n * b);
}

/** a × b ÷ d rounded half-up, for non-negative a, b and positive d. */
export const mulDiv = (a: bigint, b: bigint, d: bigint): bigint => divRound(a * b, d);

/** Quantity (micro) × unit price (micro) in micro-JOD. */
export const times = (quantity: Micro, price: Micro): Micro => mulDiv(quantity, price, SCALE);

/**
 * Split `total` over `weights` in proportion, so the shares sum to `total` exactly. The units left
 * after rounding down go to the largest remainders (earlier lines first on ties).
 */
export function allocate(total: Micro, weights: Micro[]): Micro[] {
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (total === 0n) return weights.map(() => 0n);
  if (sum <= 0n) throw new RangeError('cannot split an amount over lines that total zero');
  const shares = weights.map((w) => (total * w) / sum);
  let left = total - shares.reduce((a, b) => a + b, 0n);
  const order = weights
    .map((w, i) => ({ i, rem: (total * w) % sum }))
    .sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  for (const { i } of order) {
    if (left === 0n) break;
    shares[i] += 1n;
    left -= 1n;
  }
  return shares;
}
