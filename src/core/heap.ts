/**
 * core/heap.ts — a binary min-heap, the engine room of A* pathfinding.
 *
 * A* repeatedly needs "give me the unexplored tile with the lowest score" —
 * thousands of times per path. A naive array scan makes that O(n) per query;
 * a binary heap makes it O(log n) by keeping items in a clever
 * partially-sorted order.
 *
 * The classic trick: store the tree in a flat array. The children of the
 * item at index i live at 2i+1 and 2i+2, its parent at floor((i-1)/2) — no
 * pointers, no node objects, very kind to the CPU cache. We keep two
 * parallel arrays (item payloads and their priorities) for the same reason.
 *
 * Invariant maintained at all times: every parent's priority ≤ its
 * children's. So the minimum is always sitting at index 0.
 */

export class MinHeap {
  private items: number[] = [];
  private prios: number[] = [];

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
    this.prios.length = 0;
  }

  push(item: number, prio: number): void {
    // Append at the end, then "sift up": swap with the parent while we're
    // smaller than it. At most log₂(n) swaps.
    let i = this.items.length;
    this.items.push(item);
    this.prios.push(prio);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.prios[parent] <= prio) break;
      this.items[i] = this.items[parent];
      this.prios[i] = this.prios[parent];
      i = parent;
    }
    this.items[i] = item;
    this.prios[i] = prio;
  }

  /** Remove and return the item with the smallest priority. */
  pop(): number {
    const top = this.items[0];
    const lastItem = this.items.pop()!;
    const lastPrio = this.prios.pop()!;
    if (this.items.length > 0) {
      // Move the last item to the root, then "sift down": keep swapping
      // with the smaller child until both children are bigger.
      let i = 0;
      const n = this.items.length;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        let smallestPrio = lastPrio;
        if (l < n && this.prios[l] < smallestPrio) {
          smallest = l;
          smallestPrio = this.prios[l];
        }
        if (r < n && this.prios[r] < smallestPrio) {
          smallest = r;
        }
        if (smallest === i) break;
        this.items[i] = this.items[smallest];
        this.prios[i] = this.prios[smallest];
        i = smallest;
      }
      this.items[i] = lastItem;
      this.prios[i] = lastPrio;
    }
    return top;
  }
}
