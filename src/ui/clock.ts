/** Monotonic millisecond clock. The meter only ever sees integer timestamps from here. */
export interface Clock {
  now(): number;
}

export const realClock: Clock = { now: () => Math.floor(performance.now()) };

/** Clock whose rate can change without jumping. Used only by the dev simulator. */
export class ScaledClock implements Clock {
  private baseReal = performance.now();
  private baseVirtual = 0;
  private rate = 1;
  now(): number {
    return Math.floor(this.baseVirtual + (performance.now() - this.baseReal) * this.rate);
  }
  setRate(rate: number): void {
    this.baseVirtual = this.now();
    this.baseReal = performance.now();
    this.rate = rate;
  }
  /** Jumps virtual time forward (dev simulator only). */
  skip(ms: number): void {
    this.baseVirtual += ms;
  }
  getRate(): number {
    return this.rate;
  }
}

/** Fully manual clock for tests. */
export class ManualClock implements Clock {
  constructor(private t = 0) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}
