/** Source of the current time. Inject a fixed or controllable clock in tests. */
export interface Clock {
  now(): Date;
}

/** The real wall clock. */
export const systemClock: Clock = {
  now: () => new Date()
};
