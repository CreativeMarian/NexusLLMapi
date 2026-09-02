// 令牌桶限流：全局 + 渠道级。RPM=每分钟令牌数，桶容量=RPM（允许短时突发），0=不限。
class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(readonly rpm: number) {
    this.tokens = rpm;
    this.last = Date.now();
  }

  allow(): boolean {
    if (this.rpm <= 0) return true;
    const now = Date.now();
    const elapsedSec = (now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.rpm, this.tokens + elapsedSec * (this.rpm / 60));
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

export class RateLimiter {
  private global: TokenBucket | null = null;
  private channels = new Map<number, TokenBucket>();

  reloadGlobal(globalRpm: number) {
    this.global = globalRpm > 0 ? new TokenBucket(globalRpm) : null;
  }

  allowGlobal(): boolean {
    return this.global ? this.global.allow() : true;
  }

  allowChannel(channelId: number, rpm: number): boolean {
    if (rpm <= 0) {
      this.channels.delete(channelId);
      return true;
    }
    let bucket = this.channels.get(channelId);
    if (!bucket) {
      bucket = new TokenBucket(rpm);
      this.channels.set(channelId, bucket);
    }
    // RPM 变更重建
    if (bucket.rpm !== rpm) {
      bucket = new TokenBucket(rpm);
      this.channels.set(channelId, bucket);
    }
    return bucket.allow();
  }

  removeChannel(channelId: number) {
    this.channels.delete(channelId);
  }
}
