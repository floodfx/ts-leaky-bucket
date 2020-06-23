interface LeakyBucketOptions {
  capacity: number;
  timeout: number;
  interval: number;
}

interface LeakyBucketApi {
  throttle(cost: number, append: boolean, isPause: boolean): Promise<void>;
  pause(seconds: number): void;
  awaitEmpty(): Promise<void>;
}

interface LeakyBucketItem {
  resolve: () => void;
  reject: (reason: Error) => void;
  cost: number;
  isPause: boolean;
}

export class LeakyBucket implements LeakyBucketApi {
  private defaultOptions: LeakyBucketOptions = {
    capacity: 60, // items
    timeout: 60, // wait in seconds
    interval: 60000, //MS
  };

  private options: LeakyBucketOptions;

  private queue: LeakyBucketItem[] = [];
  private totalCost: number = 0;
  private currentCapacity: number;
  private lastRefill: number = 0; // e.g. Date.now
  private timer?: NodeJS.Timeout;

  refillRate: number = 0;
  maxCapacity: number = 0;

  // used for awaitEmpty
  private emptyPromise?: Promise<void>;
  private emptyPromiseResolver?: () => void;

  constructor(options?: LeakyBucketOptions) {
    this.options = {
      ...this.defaultOptions,
      ...options,
    };

    this.currentCapacity = this.options.capacity;

    this.calcMaxCapacityAndRefillRate();
    this.maybeCreateEmptyPromiseResolver();
  }

  /**
   * The throttle method is used to throttle things. it is async and will resolve either
   * immediatelly, if there is space in the bucket, than can be bursted, or it will wait
   * until there is enough capacity left to execute the item with the given cost. if the
   * bucket is overflowing, and the item cannot be executed within the timeout of the bucket,
   * the call will be rejected with an error.
   *
   * @param {number} cost=1 the cost of the item to be throttled. is the cost is unknown,
   *                        the cost can be payed after execution using the pay method.
   *                        defaults to 1.
   * @param {boolean} append = true set to false if the item needs ot be added to the
   *                                beginning of the queue
   * @param {boolean} isPause = false defines if the element is a pause elemtn, if yes, it
   *                                  will not be cleaned off of the queue when checking
   *                                  for overflowing elements
   * @returns {promise} resolves when the item can be executed, rejects if the item cannot
   *                    be executed in time
   */
  async throttle(cost: number = 1, append: boolean = true, isPause: boolean = false) {
    const maxCurrentCapacity = this.getCurrentMaxCapacity();

    // if items are added at the beginning, the excess items will be remove
    // later on
    console.log("this.totalCost + cost", this.totalCost + cost);
    console.log("maxCurrentCapacity", maxCurrentCapacity);
    if (append && this.totalCost + cost > maxCurrentCapacity) {
      throw new Error(
        `Cannot throttle item, bucket is overflowing: the maximum capacity is ${maxCurrentCapacity}, the current total capacity is ${this.totalCost}!`,
      );
    }

    return new Promise<void>((resolve, reject) => {
      const item: LeakyBucketItem = {
        resolve,
        reject,
        cost,
        isPause,
      };

      this.totalCost += cost;

      if (append) {
        this.queue.push(item);
        console.log(`Appended an item with the cost of ${cost} to the queue`);
      } else {
        this.queue.unshift(item);
        console.log(`Added an item to the start of the queue with the cost of ${cost} to the queue`);
        this.cleanQueue();
      }

      this.startTimer();
    });
  }

  /**
   * either executes directly when enough capacity is present or delays the
   * execution until enough capacity is available.
   */
  private startTimer() {
    if (!this.timer && this.queue.length > 0) {
      const item = this.getFirstItem();
      console.log(`Processing an item with the cost of ${item?.cost}`);

      this.refill();

      if (item?.cost && this.currentCapacity >= item.cost) {
        item.resolve();
        // log.info(`Resolved an item with the cost ${item.cost}`)

        // remove the item from the queue
        this.shiftQueue();

        // pay it's cost
        this.pay(item.cost);

        // go to the next item
        this.startTimer();
      } else {
        const requiredDelta = (item?.cost || 0) + this.currentCapacity * -1;
        const timeToDelta = (requiredDelta / this.refillRate) * 1000;

        // log.info(`Waiting ${timeToDelta} for topping up ${requiredDelta} capacity until the next item can be processed ...`);
        // wait until the next item can be handled
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.startTimer();
        }, timeToDelta);
      }
    }
  }

  /**
   * removes the first item in the queue, resolves the promise that indicated
   * that the bucket is empty and no more items are waiting
   */
  private shiftQueue() {
    this.queue.shift();

    if (this.queue.length === 0 && this.emptyPromiseResolver) {
      this.emptyPromiseResolver();
    }
  }

  private maybeCreateEmptyPromiseResolver() {
    if (!this.emptyPromiseResolver) {
      this.emptyPromise = new Promise((resolve) => {
        this.emptyPromiseResolver = () => {
          this.emptyPromiseResolver = undefined;
          this.emptyPromise = undefined;
          resolve();
        };
      });
    }
  }

  /**
   * is resolved as soon as the bucket is empty. is basically an event
   * that is emitted
   */
  async awaitEmpty() {
    // ensure empty promise resolver created
    this.maybeCreateEmptyPromiseResolver();

    // handle race condition if awaitEmpty is called after throttle
    // loop has already completed `shiftQueue` call
    if (this.queue.length === 0 && this.emptyPromiseResolver) {
      this.emptyPromiseResolver();
    }

    return this.emptyPromise;
  }

  /**
   * ends the bucket. The bucket may be recycled after this call
   */
  stopTimerAndClearQueue() {
    this.stopTimer();
    this.clear();
  }

  /**
   * removes all items from the queue, does not stop the timer though
   */
  private clear() {
    this.queue = [];
  }

  /**
   * can be used to pay costs for items where the cost is clear after exection
   * this will devcrease the current capacity availabe on the bucket.
   *
   * @param {number} cost the ost to pay
   */
  pay(cost: number) {
    console.log(`Paying ${cost}`);

    // reduce the current capacity, so that bursts
    // as calculated correctly
    this.currentCapacity -= cost;

    // keep track of the total cost for the bucket
    // so that we know when we're overflowing
    this.totalCost -= cost;

    // store the date the leky bucket was starting to leak
    // so that it can be refilled correctly
    if (this.lastRefill === null) {
      this.lastRefill = Date.now();
    }
  }

  /**
   * pause the bucket for the given cost. means that an item is added in the
   * front of the queue with the cost passed to this method
   *
   * @param {number} cost the cost to pasue by
   */
  pauseByCost(cost: number) {
    this.stopTimer();
    console.log(`Pausing bucket for ${cost} cost`);
    this.throttle(cost, false, true);
  }

  /**
   * pause the bucket for n seconds. means that an item with the cost for one
   * second is added at the beginning of the queue
   *
   * @param {number} seconds the number of seconds to pause the bucket by
   */
  pause(seconds = 1) {
    this.drain();
    this.stopTimer();
    const cost = this.refillRate * seconds;
    console.log(`Pausing bucket for ${seconds} seonds`);
    this.pauseByCost(cost);
  }

  /**
   * stops the running times
   */
  private stopTimer() {
    if (this.timer) {
      console.log(`Stopping timer`);
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * refills the bucket with capacity which has become available since the
   * last refill. starts to refill after a call has started using capacity
   */
  private refill() {
    const { capacity } = this.options;
    // don't do refills, if we're already full
    if (this.currentCapacity < capacity) {
      // refill the currently avilable capacity
      const refillAmount = ((Date.now() - this.lastRefill) / 1000) * this.refillRate;
      this.currentCapacity += refillAmount;
      console.log(
        `Refilled the bucket with ${refillAmount}, last refill was ${
          this.lastRefill
        }, current Date is ${Date.now()}, diff is ${Date.now() - this.lastRefill} msec`,
      );

      // make sure, that no more capacity is added than is the maximum
      if (this.currentCapacity >= capacity) {
        this.currentCapacity = capacity;
        this.lastRefill = 0;
        console.log(`Buckets capacity is fully recharged`);
      } else {
        // date of last refill, ued for the next refill
        this.lastRefill = Date.now();
      }
    }
  }

  /**
   * gets the currenlty avilable max capacity, respecintg
   * the capacity that is already used in the moment
   */
  private getCurrentMaxCapacity() {
    this.refill();
    return this.maxCapacity - (this.options.capacity - this.currentCapacity);
  }

  /**
   * removes all items that cannot be executed in time due to items
   * that were added in front of them in the queue (mostly pause items)
   */
  private cleanQueue() {
    const maxCapacity = this.getCurrentMaxCapacity();
    let currentCapacity = 0;

    // find the first item, that goes over the thoretical maximal
    // capacity that is available
    const index = this.queue.findIndex((item) => {
      currentCapacity += item.cost;
      return currentCapacity > maxCapacity;
    });

    // reject all items that cannot be enqueued
    if (index >= 0) {
      this.queue.splice(index).forEach((item) => {
        if (!item.isPause) {
          // log.warn(`Rejecting item with a cost of ${item.cost} because an item was added in front of it!`);
          item.reject(
            new Error(
              `Cannot throttle item because an item was added in front of it which caused the queue to overflow!`,
            ),
          );
          this.totalCost -= item.cost;
        }
      });
    }
  }

  /**
   * returns the first item from the queue
   */
  private getFirstItem() {
    if (this.queue.length > 0) {
      return this.queue[0];
    } else {
      return null;
    }
  }

  /**
   * drains the bucket, so that nothing can be exuted at the moment
   */
  private drain() {
    console.log(`Draining the bucket, removing ${this.currentCapacity} from it, so that the current capacity is 0`);
    this.currentCapacity = 0;
    this.lastRefill = Date.now();
  }

  get capacity() {
    return this.options.capacity;
  }

  get timeout() {
    return this.options.timeout;
  }

  get interval() {
    return this.options.interval;
  }

  /**
   * calculates the values maxCapacity and refillRate
   */
  private calcMaxCapacityAndRefillRate() {
    const { timeout, interval, capacity } = this.options;
    // take one as default for each variable since this method may be called
    // before every variable was set
    this.maxCapacity = ((timeout || 1) / (interval || 1)) * (capacity || 1);

    // the rate, at which the leaky bucket is filled per second
    this.refillRate = (capacity || 1) / (interval || 1);

    console.log(`the buckets max capacity is now ${this.maxCapacity}`);
    console.log(`the buckets refill rate is now ${this.refillRate}`);
  }
}
