interface LeakyBucketOptions {
  capacity: number;
  timeout: number;
  interval: number;
}

interface LeakyBucketApi {
  throttle(cost: number, append: boolean, isPause: boolean): Promise<unknown>;
}

interface LeakyBucketItem {
  resolve: (value?: unknown) => void;
  reject: (reason?: any) => void;
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
  private lastRefill?: number; // e.g. Date.now
  private timer?: NodeJS.Timeout;
  private emptyPromise?: Promise<unknown>;
  private emptyPromiseResolver?: () => void;
  private refillRate?: number;
  private maxCapacity?: number;

  constructor(options?: LeakyBucketOptions) {
    this.options = {
      ...this.defaultOptions,
      ...options,
    };

    this.currentCapacity = this.options.capacity;
  }

  async throttle(cost: number = 1, append: boolean, isPause: boolean = false) {
    this.refill();
    const maxCurrentCapacity = this.getCurrentMaxCapacity();

    // if items are added at the beginning, the excess items will be remove
    // later on
    if (append && this.totalCost + cost > maxCurrentCapacity) {
      throw new Error(
        `Cannot throttle item, bucket is overflowing: the maximum capacity is ${maxCurrentCapacity}, the current total capacity is ${this.totalCost}!`,
      );
    }

    return new Promise((resolve, reject) => {
      const item: LeakyBucketItem = {
        resolve,
        reject,
        cost,
        isPause,
      };

      this.totalCost += cost;

      if (append) {
        this.queue.push(item);
        // log.debug(`Appended an item with the cost of ${cost} to the queue`);
      } else {
        this.queue.unshift(item);
        // log.debug(`Added an item to the start of the queue with the cost of ${cost} to the queue`);
        this.cleanQueue();
      }

      this.startTimer();
    });
  }

  startTimer() {
    if (!this.timer && this.queue.length > 0) {
      const item = this.getFirstItem();
      // log.debug(`Processing an item with the cost of ${item.cost}`);
      if (!item) {
        return;
      }

      this.refill();

      if (this.currentCapacity >= item.cost) {
        item.resolve();
        // log.info(`Resolved an item with the cost ${item.cost}`)

        // remove the item from the queue
        this.shiftQueue();

        // pay it's cost
        this.pay(item.cost);

        // go to the next item
        this.startTimer();
      } else {
        const requiredDelta = item.cost + this.currentCapacity * -1;
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
   *
   * @private
   */
  shiftQueue() {
    this.queue.shift();

    if (this.queue.length === 0 && this.emptyPromiseResolver) {
      this.emptyPromiseResolver();
    }
  }

  /**
   * is resolved as soon as the bucket is empty. is basically an event
   * that is emitted
   */
  async isEmpty() {
    if (!this.emptyPromiseResolver) {
      this.emptyPromise = new Promise((resolve) => {
        this.emptyPromiseResolver = () => {
          this.emptyPromiseResolver = undefined;
          this.emptyPromise = undefined;
          resolve();
        };
      });
    }

    return this.emptyPromise;
  }

  /**
   * ends the bucket. The bucket may be recycled after this call
   */
  end() {
    // log.warn(`Ending bucket!`);
    this.stopTimer();
    this.clear();
  }

  /**
   * removes all items from the queue, does not stop the timer though
   *
   * @privae
   */
  clear() {
    // log.debug(`Resetting queue`);
    this.queue = [];
  }

  /**
   * can be used to pay costs for items where the cost is clear after exection
   * this will devcrease the current capacity availabe on the bucket.
   *
   * @param {number} cost the ost to pay
   */
  pay(cost: number) {
    // log.debug(`Paying ${cost}`);

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
   * stops the running times
   *
   * @private
   */
  stopTimer() {
    if (this.timer) {
      // log.debug(`Stopping timer`);
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * refills the bucket with capacity which has become available since the
   * last refill. starts to refill after a call has started using capacity
   *
   * @private
   */
  refill() {
    const { capacity } = this.options;
    // don't do refills, if we're already full
    if (this.currentCapacity < capacity) {
      // refill the currently avilable capacity
      const refillAmount = ((Date.now() - this.lastRefill) / 1000) * this.refillRate;
      this.currentCapacity += refillAmount;
      // log.debug(`Refilled the bucket with ${refillAmount}, last refill was ${this.lastRefill}, current Date is ${Date.now()}, diff is ${(Date.now() - this.lastRefill)} msec`);

      // make sure, that no more capacity is added than is the maximum
      if (this.currentCapacity >= capacity) {
        this.currentCapacity = capacity;
        this.lastRefill = undefined;
        // log.debug(`Buckets capacity is fully recharged`);
      } else {
        // date of last refill, ued for the next refill
        this.lastRefill = Date.now();
      }
    }
  }

  /**
   * gets the currenlty avilable max capacity, respecintg
   * the capacity that is already used in the moment
   *
   * @private
   */
  getCurrentMaxCapacity() {
    // this.refill();
    return this.maxCapacity - (this.options.capacity - this.currentCapacity);
  }

  /**
   * removes all items that cannot be executed in time due to items
   * that were added in front of them in the queue (mostly pause items)
   *
   * @private
   */
  cleanQueue() {
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
   *
   * @private
   */
  getFirstItem() {
    if (this.queue.length > 0) {
      return this.queue[0];
    } else {
      return null;
    }
  }

  /**
   * pasue the bucket for the given cost. means that an item is added in the
   * front of the queue with the cost passed to this method
   *
   * @param {number} cost the cost to pasue by
   */
  pauseByCost(cost: number) {
    this.stopTimer();
    // log.debug(`Pausing bucket for ${cost} cost`);
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
    // log.debug(`Pausing bucket for ${seconds} seonds`);
    this.pauseByCost(cost);
  }

  /**
   * drains the bucket, so that nothing can be exuted at the moment
   *
   * @private
   */
  drain() {
    // log.debug(`Draining the bucket, removing ${this.currentCapacity} from it, so that the current capacity is 0`);
    this.currentCapacity = 0;
    this.lastRefill = Date.now();
  }

  /**
   * set the timeout value for the bucket. this is the amount of time no item
   * may longer wait for.
   *
   * @param {number} timeout in seonds
   */
  setTimeout(timeout: number) {
    // log.debug(`the buckets timeout is now ${timeout}`);
    this.options.timeout = timeout;
    this.updateVariables();
    return this;
  }

  /**
   * set the interval within whch the capacity can be used
   *
   * @param {number} interval in seonds
   */
  setInterval(interval: number) {
    // log.debug(`the buckets interval is now ${interval}`);
    this.options.interval = interval;
    this.updateVariables();
    return this;
  }

  /**
   * set the capacity of the bucket. this si the capacity that can be used per interval
   *
   * @param {number} capacity
   */
  setCapacity(capacity: number) {
    // log.debug(`the buckets capacity is now ${capacity}`);
    this.options.capacity = capacity;
    this.updateVariables();
    return this;
  }

  /**
   * claculates the values of some frequently used variables on the bucket
   *
   * @private
   */
  updateVariables() {
    const { timeout, interval, capacity } = this.options;
    // take one as default for each variable since this method may be called
    // before every variable was set
    this.maxCapacity = ((timeout || 1) / (interval || 1)) * (capacity || 1);

    // the rate, at which the leaky bucket is filled per second
    this.refillRate = (capacity || 1) / (interval || 1);

    // log.debug(`the buckets max capacity is now ${this.maxCapacity}`);
    // log.debug(`the buckets refill rate is now ${this.refillRate}`);
  }
}
