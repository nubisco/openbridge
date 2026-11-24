/** The plan the IFC tests export: two floors, a room of each kind, every kind of opening, coverings, furniture and devices. */
import { fromV1 } from '../../house-model/convert.js'
import type { Door, Plan, Window } from '../../house-model/v2.js'
import type { HousePlan } from '../../house.js'

export function plan(): Plan {
  const v1: HousePlan = {
    version: 1,
    grid: 0.5,
    plot: { w: 30, h: 20 },
    floors: [
      {
        id: 'g',
        name: 'Rez-de-chaussée',
        level: 0,
        rooms: [
          { id: 'garden', name: 'Garden', kind: 'outdoor', x: 0, y: 0, w: 30, h: 20 },
          {
            id: 'living',
            name: "Sam's living",
            kind: 'room',
            x: 2,
            y: 2,
            w: 10,
            h: 6,
            parts: [{ x: 2, y: 8, w: 4, h: 4 }],
          },
          { id: 'kitchen', name: 'Kitchen', kind: 'room', x: 12, y: 2, w: 6, h: 6 },
          { id: 'deck', name: 'Deck', kind: 'paved', x: 19, y: 9, w: 8, h: 6 },
          { id: 'pool', name: 'Pool', kind: 'pool', x: 20, y: 10, w: 6, h: 4 },
        ],
        openings: [
          { id: 'win', type: 'window', axis: 'h', x: 4, y: 2, len: 2 },
          { id: 'slide', type: 'slider', axis: 'v', x: 2, y: 3.5, len: 2 },
          { id: 'gd', type: 'door', axis: 'h', x: 7, y: 8, len: 1, glass: true, hinge: 'end', opens: 'down' },
          { id: 'wood', type: 'door', axis: 'v', x: 12, y: 3, len: 1, opens: 'left' },
          { id: 'gap', type: 'open', axis: 'v', x: 12, y: 6, len: 1.5 },
        ],
        placements: [
          { ref: 'device:lamp', x: 6.5, y: 5, mount: 'ceiling' },
          { ref: 'device:shutter', x: 5, y: 2, opening: 'win' },
          { ref: 'device:unknown', x: 8, y: 5 },
        ],
        radiators: [{ id: 'rad', x: 12, y: 2.5, axis: 'v', len: 1.5, side: 'right' }],
        furniture: [
          { id: 'sofa', kind: 'sofa', x: 3, y: 3, w: 4, d: 1.5, back: 'up' },
          { id: 'bath', kind: 'bath', x: 13, y: 3, w: 3, d: 1.5 },
          { id: 'planter', kind: 'planter', x: 20, y: 16, w: 1, d: 1 },
        ],
      },
      {
        id: 'f1',
        name: 'First floor',
        level: 1,
        rooms: [{ id: 'bed', name: 'Bedroom', kind: 'room', x: 2, y: 2, w: 8, h: 8 }],
        openings: [{ id: 'bw', type: 'window', axis: 'h', x: 4, y: 2, len: 2 }],
        placements: [],
      },
    ],
  }
  const p = fromV1(v1).plan
  const g = p.storeys[0]
  ;(g.openings.find((o) => o.id === 'win') as Window).coverings!.push({ id: 'cur', kind: 'curtain', side: 'inside' })
  ;(g.openings.find((o) => o.id === 'slide') as Door).coverings = [{ id: 'aw', kind: 'awning', side: 'outside' }]
  return p
}
