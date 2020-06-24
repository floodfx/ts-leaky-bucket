import { LeakyBucket } from "./LeakyBucket";

describe("Leaky Bucket", () => {
  test("Compute factors correctly", async () => {
    const capacity = 120;
    const intervalMillis = 60 * 1000;
    const timeoutMillis = 300 * 1000;
    const bucket = new LeakyBucket({
      capacity,
      intervalMillis,
      timeoutMillis,
    });

    expect(bucket.capacity).toEqual(capacity);
    expect(bucket.intervalMillis).toEqual(intervalMillis);
    expect(bucket.timeoutMillis).toEqual(timeoutMillis);

    expect(bucket.maxCapacity).toEqual(600);
    expect(bucket.refillRate).toEqual(2);
  });

  test("Excute items that are burstable and wait for the ones that cannot burst", async () => {
    const bucket = new LeakyBucket({
      capacity: 100,
      intervalMillis: 60 * 1000,
      timeoutMillis: 300 * 1000,
    });

    const start = Date.now();

    for (let i = 0; i < 101; i++) {
      await bucket.throttle();
    }

    const duration = Date.now() - start;
    expect(duration).toBeLessThan(400);
  });

  test("Overflow when an excess item is added", async () => {
    expect.assertions(1);
    const bucket = new LeakyBucket({
      capacity: 100,
      intervalMillis: 60 * 1000,
      timeoutMillis: 300 * 1000,
    });

    bucket.throttle(500);
    await bucket.throttle(1).catch(async (err) => {
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
      intervalMillis: 60 * 1000,
      timeoutMillis: 70 * 1000,
    });

    bucket.throttle(80).catch(async (err) => {
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
      intervalMillis: 60 * 1000,
      timeoutMillis: 70 * 1000,
    });

    const start = Date.now();
    bucket.throttle(100);
    bucket.throttle(1);

    await bucket.awaitEmpty();

    const duration = Date.now() - start;
    expect(duration).toBeGreaterThanOrEqual(0);
    expect(duration).toBeLessThan(100);
  });

  test("Await empty bucket promise twice", async () => {
    const bucket = new LeakyBucket({
      capacity: 100,
      intervalMillis: 60 * 1000,
      timeoutMillis: 70 * 1000,
    });

    let start = Date.now();
    bucket.throttle(100);
    bucket.throttle(1);

    await bucket.awaitEmpty();

    let duration = Date.now() - start;
    expect(duration).toBeGreaterThanOrEqual(0);
    expect(duration).toBeLessThan(100);

    start = Date.now();
    bucket.throttle(100);
    bucket.throttle(1);

    await bucket.awaitEmpty();

    duration = Date.now() - start;
    expect(duration).toBeGreaterThanOrEqual(0);
    expect(duration).toBeLessThan(100);
  });

  test("pausing the bucket", async () => {
    const bucket = new LeakyBucket({
      capacity: 60,
      intervalMillis: 60 * 1000,
      timeoutMillis: 120 * 1000,
    });

    const start = Date.now();

    await bucket.throttle(10);
    await bucket.throttle(10);
    await bucket.pause(500);
    await bucket.throttle(0.5);

    const duration = Date.now() - start;
    expect(duration).toBeGreaterThanOrEqual(1000);
    expect(duration).toBeLessThan(1050);
  });
});
