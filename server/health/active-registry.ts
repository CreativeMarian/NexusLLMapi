// 活跃请求注册表：跟踪所有进行中的请求/流，供健康检测与优雅关闭使用
export interface ActiveRequest {
  requestId: string;
  route: string;
  model: string;
  channelId: number | null;
  stream: boolean;
  startTime: number;
  lastActivity: number;
  controller: AbortController;
}

export class ActiveRequestRegistry {
  private requests = new Map<string, ActiveRequest>();

  register(req: ActiveRequest): void {
    this.requests.set(req.requestId, req);
  }

  touch(requestId: string): void {
    const r = this.requests.get(requestId);
    if (r) r.lastActivity = Date.now();
  }

  unregister(requestId: string): void {
    this.requests.delete(requestId);
  }

  get(requestId: string): ActiveRequest | undefined {
    return this.requests.get(requestId);
  }

  count(): number {
    return this.requests.size;
  }

  streamCount(): number {
    let n = 0;
    for (const r of this.requests.values()) if (r.stream) n++;
    return n;
  }

  list(): ActiveRequest[] {
    return [...this.requests.values()];
  }

  /** 找出超过指定毫秒仍无活动的僵死请求 */
  findStale(idleMs: number, now = Date.now()): ActiveRequest[] {
    const stale: ActiveRequest[] = [];
    for (const r of this.requests.values()) {
      if (now - r.lastActivity > idleMs) stale.push(r);
    }
    return stale;
  }

  /** 中止所有活跃请求（优雅关闭时调用） */
  abortAll(reason: string): void {
    for (const r of this.requests.values()) {
      r.controller.abort(new Error(reason));
    }
  }
}
