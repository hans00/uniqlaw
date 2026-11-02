/** Unbounded single-consumer async queue that ends on close(). */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiter?: () => void;
  private closed = false;
  push(v: T) { if (this.closed) return; this.items.push(v); this.waiter?.(); }
  close() { this.closed = true; this.waiter?.(); }
  get isClosed() { return this.closed; }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        while (!this.items.length && !this.closed) await new Promise<void>((r) => (this.waiter = r));
        if (this.items.length) return { done: false, value: this.items.shift()! };
        return { done: true, value: undefined as never };
      },
    };
  }
}
