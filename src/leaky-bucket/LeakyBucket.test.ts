import { LeakyBucket } from "./LeakyBucket";

describe("Leaky Bucket", () => {
  test("Compute factors correctly", async () => {
    const bucket = new LeakyBucket({
      capacity: 120,
      interval: 60,
      timeout: 300,
    });

    expect(bucket.capacity).toEqual(120);
    expect(bucket.interval).toEqual(60);
    expect(bucket.timeout).toEqual(300);

    expect(bucket.maxCapacity).toEqual(600);
    expect(bucket.refillRate).toEqual(2);
  });

  test("Excute items that are burstable and wait for the ones that cannot burst", async () => {
    const bucket = new LeakyBucket({
      capacity: 100,
      interval: 60,
      timeout: 300,
    });

    const start = Date.now();

    for (let i = 0; i < 101; i++) {
      await bucket.throttle();
    }

    const duration = Date.now() - start;
    expect(duration).toBeGreaterThan(200);
    expect(duration).toBeLessThan(400);
  });

  test("Overflow when an excess item is added", async () => {
    const bucket = new LeakyBucket({
      capacity: 100,
      interval: 60,
      timeout: 300,
    });

    bucket.throttle(500);
    await bucket.throttle(1).catch(async (err) => {
      expect(err).not.toBeUndefined();

      // since the throttle with a cost of 500 was 400 cost over the
      // cost that can be processed immediatelly, the bucket needs to be ended
      bucket.end();
    });
  });

  test("Overlow already added items when pausing the bucket", async () => {
    const bucket = new LeakyBucket({
      capacity: 60,
      interval: 60,
      timeout: 70,
    });

    bucket.throttle(60);
    bucket.throttle(5);
    bucket.throttle(5).catch(async (err) => {
      expect(err).not.toBeUndefined();

      // since the throttle with a cost of 500 was 400 cost over the
      // cost that can be processed immediatelly, the bucket needs to be ended
      bucket.end();
    });

    bucket.pause();
  });

  test("Empty bucket promise", async () => {
    const bucket = new LeakyBucket({
      capacity: 100,
      interval: 60,
      timeout: 70,
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
      interval: 60,
      timeout: 70,
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
      interval: 60,
      timeout: 120,
    });

    const start = Date.now();

    await bucket.throttle(10);
    await bucket.throttle(10);
    await bucket.pause(0.5);
    await bucket.throttle(0.5);

    const duration = Date.now() - start;
    expect(duration).toBeGreaterThanOrEqual(1000);
    expect(duration).toBeLessThan(1050);
  });
});
