/** 简单令牌桶：capacity 为突发上限，refillPerSec 为持续速率 */
export class TokenBucket {
  constructor({ capacity, refill_per_sec }, now = Date.now) {
    this.capacity = capacity;
    this.rate = refill_per_sec;
    this.tokens = capacity;
    this.now = now;
    this.last = now();
  }

  take(n = 1) {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}
