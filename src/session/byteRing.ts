/** Fixed-capacity output cache. Appending never shifts existing scrollback. */
export class ByteRing {
  private readonly bytes: Uint8Array
  private end = 0
  private size = 0
  totalBytes = 0
  readonly capacity: number

  constructor(capacity = 65536) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("Invalid ring capacity")
    this.capacity = capacity
    this.bytes = new Uint8Array(capacity)
  }

  append(input: Uint8Array | readonly number[]): void {
    this.totalBytes += input.length
    if (input.length >= this.capacity) {
      const tail = input instanceof Uint8Array
        ? input.subarray(input.length - this.capacity)
        : input.slice(input.length - this.capacity)
      this.bytes.set(tail)
      this.end = 0
      this.size = this.capacity
      return
    }
    const data = input instanceof Uint8Array ? input : Uint8Array.from(input)
    const first = Math.min(data.length, this.capacity - this.end)
    this.bytes.set(data.subarray(0, first), this.end)
    this.bytes.set(data.subarray(first), 0)
    this.end = (this.end + data.length) % this.capacity
    this.size = Math.min(this.capacity, this.size + data.length)
  }

  snapshot(): Uint8Array {
    const result = new Uint8Array(this.size)
    const start = (this.end - this.size + this.capacity) % this.capacity
    const first = Math.min(this.size, this.capacity - start)
    result.set(this.bytes.subarray(start, start + first))
    result.set(this.bytes.subarray(0, this.size - first), first)
    return result
  }
}
