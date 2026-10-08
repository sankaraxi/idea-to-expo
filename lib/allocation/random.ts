import { createHmac, randomBytes } from "node:crypto";

/**
 * Deterministic, cryptographically strong random stream derived from a seed
 * (HMAC-SHA256 in counter mode). The same seed always reproduces the same
 * stream, which lets the server re-derive a previewed allocation on confirm
 * without trusting the client or persisting a draft.
 */
export class SeededRandom {
  private counter = 0;
  private buffer = Buffer.alloc(0);
  private offset = 0;

  constructor(private readonly seed: string) {
    if (!seed) throw new Error("Seed must be a non-empty string");
  }

  static newSeed(): string {
    return randomBytes(32).toString("hex");
  }

  private nextUint32(): number {
    if (this.offset + 4 > this.buffer.length) {
      this.buffer = createHmac("sha256", this.seed).update(String(this.counter++)).digest();
      this.offset = 0;
    }
    const value = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  /** Uniform integer in [0, maxExclusive) using rejection sampling (no modulo bias). */
  int(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 2 ** 32) {
      throw new RangeError(`maxExclusive must be an integer in (0, 2^32], got ${maxExclusive}`);
    }
    const limit = 2 ** 32 - (2 ** 32 % maxExclusive);
    let value: number;
    do {
      value = this.nextUint32();
    } while (value >= limit);
    return value % maxExclusive;
  }
}

/** In-place-free Fisher–Yates shuffle; returns a new array. */
export function shuffle<T>(items: readonly T[], random: SeededRandom): T[] {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = random.int(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
