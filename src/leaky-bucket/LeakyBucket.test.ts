import { LeakyBucket } from "./LeakyBucket";

describe("Leaky Bucket", () => {
  test("Compute factors correctly", async () => {
    const capacity = 120;
    const intervalMillis = 60_000;
    const additionalTimeoutMillis = 240_000;
    const bucket = new LeakyBucket({
      capacity,
      intervalMillis,
      additionalTimeoutMillis,
    });

    expect(bucket.capacity).toEqual(capacity);
    expect(bucket.intervalMillis).toEqual(intervalMillis);
    expect(bucket.additionalTimeoutMillis).toEqual(additionalTimeoutMillis);

    expect(bucket.maxCapacity).toEqual(600);
    expect(bucket.refillRatePerSecond).toEqual(2);
  });

  test("Compute factors default timeoutMillis", async () => {
    const capacity = 120;
    const intervalMillis = 60_000;
    const bucket = new LeakyBucket({
      capacity,
      intervalMillis,
    });

    expect(bucket.capacity).toEqual(capacity);
    expect(bucket.intervalMillis).toEqual(intervalMillis);
    expect(bucket.additionalTimeoutMillis).toEqual(0); // default additional timeout to 0

    expect(bucket.maxCapacity).toEqual(120);
    expect(bucket.refillRatePerSecond).toEqual(2);
  });

  test("Excute items that are burstable and wait for the ones that cannot burst", async () => {
    const bucket = new LeakyBucket({
      capacity: 100,
      intervalMillis: 60_000,
      additionalTimeoutMillis: 300_000,
    });

    const start = Date.now();

    for (let i = 0; i < 101; i++) {
      await bucket.maybeThrottle();
    }

    const duration = Date.now() - start;
    expect(duration).toBeLessThan(400);
  });

  test("Overflow when an excess item is added", async () => {
    expect.assertions(1);
    const bucket = new LeakyBucket({
      capacity: 100,
      intervalMillis: 60_000,
      additionalTimeoutMillis: 240_000,
    });

    bucket.maybeThrottle(500);
    await bucket.maybeThrottle(1).catch(async (err) => {
      expect(err).not.toBeUndefined();

      // since the throttle with a cost of 500 was 400 cost over the
      // cost that can be processed immediatelly, the bucket needs to be ended
      bucket.stopTimerAndClearQueue();
    });
  });

  test("Overlow already added items when pausing the bucket", async () => {
    expect.assertions(1);
    const bucket = new LeakyBucket({
      capacity: 60,
      intervalMillis: 60_000,
      additionalTimeoutMillis: 10_000,
    });

    bucket.maybeThrottle(80).catch(async (err) => {
      expect(err).not.toBeUndefined();
      await bucket.awaitEmpty();

      // since the throttle with a cost of 500 was 400 cost over the
      // cost that can be processed immediatelly, the bucket needs to be ended
      bucket.stopTimerAndClearQueue();
    });

    bucket.pause();
  });

  test("Empty bucket promise", async () => {
    const bucket = new LeakyBucket({
      capacity: 100,
      intervalMillis: 60_000,
      additionalTimeoutMillis: 10_000,
    });

    const start = Date.now();
    bucket.maybeThrottle(100);
    bucket.maybeThrottle(1);

    await bucket.awaitEmpty();

    const duration = Date.now() - start;
    expect(duration).toBeGreaterThanOrEqual(0);
    expect(duration).toBeLessThan(100);
  });

  test("Await empty bucket promise twice", async () => {
    const bucket = new LeakyBucket({
      capacity: 100,
      intervalMillis: 60_000,
      additionalTimeoutMillis: 10_000,
    });

    let start = Date.now();
    bucket.maybeThrottle(100);
    bucket.maybeThrottle(1);

    await bucket.awaitEmpty();

    let duration = Date.now() - start;
    expect(duration).toBeGreaterThanOrEqual(0);
    expect(duration).toBeLessThan(100);

    start = Date.now();
    bucket.maybeThrottle(100);
    bucket.maybeThrottle(1);

    await bucket.awaitEmpty();

    duration = Date.now() - start;
    expect(duration).toBeGreaterThanOrEqual(0);
    expect(duration).toBeLessThan(100);
  });

  test("pausing the bucket", async () => {
    const bucket = new LeakyBucket({
      capacity: 60,
      intervalMillis: 60_000,
      additionalTimeoutMillis: 60_000,
    });

    const start = Date.now();

    await bucket.maybeThrottle(10);
    await bucket.maybeThrottle(10);
    await bucket.pause(500);
    await bucket.maybeThrottle(0.5);

    const duration = Date.now() - start;
    expect(duration).toBeGreaterThanOrEqual(1000);
    expect(duration).toBeLessThan(1050);
  });
});
