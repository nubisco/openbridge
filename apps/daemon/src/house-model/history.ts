/**
 * Undo and redo for an editor: a list of states, each a JSON string of the
 * whole plan, with a cursor on the one in front of the person.
 *
 * Whole copies rather than a log of changes, because every edit then counts
 * without each one having to describe how to reverse itself. A plan is a few
 * tens of kilobytes, so a hundred states is a few megabytes at worst.
 *
 * Pure: the editor decides when a change has settled enough to be one step
 * (a drag ends, typing pauses) and calls `record`.
 */
export class History {
  private states: string[]
  private at = 0

  constructor(
    initial: string,
    private readonly limit = 100,
  ) {
    this.states = [initial]
  }

  /** The state in front of the person. */
  get current(): string {
    return this.states[this.at]
  }

  get canUndo(): boolean {
    return this.at > 0
  }

  get canRedo(): boolean {
    return this.at < this.states.length - 1
  }

  /**
   * Take a new state as one step. The same state again is not a step. A step
   * taken after undoing drops what could have been redone, as editors do.
   * Answers whether it was taken.
   */
  record(state: string): boolean {
    if (state === this.states[this.at]) return false
    this.states.length = this.at + 1
    this.states.push(state)
    if (this.states.length > this.limit) this.states.splice(0, this.states.length - this.limit)
    this.at = this.states.length - 1
    return true
  }

  /** The state before, or null at the first. */
  undo(): string | null {
    if (!this.canUndo) return null
    return this.states[--this.at]
  }

  /** The state after, or null at the last. */
  redo(): string | null {
    if (!this.canRedo) return null
    return this.states[++this.at]
  }
}
