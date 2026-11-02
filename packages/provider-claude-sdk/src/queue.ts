// Single-consumer async event queue.
export class EventQueue<T> implements AsyncIterable<T> {
  private q: T[] = [];
  private wake?: () => void;
  private ended = false;

  push(v: T) { if (this.ended) return; this.q.push(v); this.wake?.(); }
  end() { this.ended = true; this.wake?.(); }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (this.q.length) yield this.q.shift()!;
      if (this.ended) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = undefined;
    }
  }
}
