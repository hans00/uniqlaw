/** Single-consumer async queue backing AgentSession.events. */
export class EventQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting?: (r: IteratorResult<T>) => void;
  private closed = false;

  push(item: T) {
    if (this.closed) return;
    if (this.waiting) { const w = this.waiting; this.waiting = undefined; w({ done: false, value: item }); }
    else this.items.push(item);
  }

  close() {
    this.closed = true;
    if (this.waiting) { const w = this.waiting; this.waiting = undefined; w({ done: true, value: undefined }); }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ done: false, value: this.items.shift()! });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((r) => (this.waiting = r));
      },
    };
  }
}
