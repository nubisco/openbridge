import { describe, it, expect } from 'vitest'
import { History } from '../house-model/history.js'

describe('edit history', () => {
  it('undoes and redoes in order', () => {
    const h = new History('a')
    expect(h.canUndo).toBe(false)
    h.record('b')
    h.record('c')
    expect(h.undo()).toBe('b')
    expect(h.undo()).toBe('a')
    expect(h.undo()).toBeNull()
    expect(h.redo()).toBe('b')
    expect(h.redo()).toBe('c')
    expect(h.redo()).toBeNull()
    expect(h.current).toBe('c')
  })

  it('does not count the same state twice', () => {
    const h = new History('a')
    expect(h.record('a')).toBe(false)
    expect(h.record('b')).toBe(true)
    expect(h.record('b')).toBe(false)
    expect(h.undo()).toBe('a')
    expect(h.canUndo).toBe(false)
  })

  it('drops what could be redone when something new is done', () => {
    const h = new History('a')
    h.record('b')
    h.record('c')
    h.undo()
    h.record('d')
    expect(h.canRedo).toBe(false)
    expect(h.undo()).toBe('b')
    expect(h.undo()).toBe('a')
  })

  it('a state undone to is not a new step', () => {
    const h = new History('a')
    h.record('b')
    h.undo()
    // The editor records what is on screen after an undo. That is the state
    // undone to, so redo still works.
    expect(h.record('a')).toBe(false)
    expect(h.redo()).toBe('b')
  })

  it('keeps the latest steps only', () => {
    const h = new History('0', 3)
    for (const s of ['1', '2', '3', '4']) h.record(s)
    expect(h.undo()).toBe('3')
    expect(h.undo()).toBe('2')
    expect(h.undo()).toBeNull()
  })
})
