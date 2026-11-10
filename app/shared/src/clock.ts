/** Injectable clock so the scheduler and gateway are testable. */
export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };
