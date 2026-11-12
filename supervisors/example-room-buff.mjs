#!/usr/bin/env node
// EXAMPLE SUPERVISOR: ONE SINGER KEEPS A ROOM ENCHANTMENT UP WHILE THE FARMERS ARE THERE.
//
// A worked example of src/supervise/base.mjs — the plumbing (rpc, fleet cache, config
// re-read, log, stop file, heartbeat) is the base class's, and this file holds only the
// plan. Nothing is hardcoded: every character and room comes from the config file, which is
// re-read on every pass.
//
//   node supervisors/example-room-buff.mjs --fleet <fleet> --state-dir var/supervisors \
//        --config var/supervisors/room-buff.json
//
//   room-buff.json:
//   { "singer": "<agent>", "room": 552, "spell": "<room enchantment>",
//     "farmers": ["<agent>", "<agent>"], "min_farmers": 1, "exclude": [] }
//
// The singer is POSTED, not driven: the keeper's own `room_enchant` order casts the spell
// from a safe spot and keeps the stationary-caster safety armed, so this supervisor decides
// only WHEN the post is manned — while at least `min_farmers` of the configured farmers are
// standing in the room — and stands the singer down when they leave. A doctrine whose
// station only makes sense with the buff up declares this supervisor as `must`.

import { pathToFileURL } from 'node:url';
import { Supervisor, supervisorMain } from '../src/supervise/base.mjs';

export class RoomBuff extends Supervisor {
  constructor(o) {
    super({ ...o, defaults: { singer: null, room: null, spell: null, farmers: [], min_farmers: 1, exclude: [] } });
    this.posted = null;     // true / false once we have ordered either way
  }

  loops() { return [{ name: 'post', fn: () => this.pass(), everyMs: 15_000 }]; }

  async pass() {
    const c = this.conf();
    if (!c.singer || !Number.isFinite(Number(c.room)) || !c.spell) {
      this.log('not configured', { need: 'singer, room and spell' });
      return;
    }
    const rows = await this.fleet();
    const singer = rows.find(r => r.agent === c.singer);
    if (!this.hands(singer)) return;                      // piloted, dead, out of game, excluded
    const room = Number(c.room);
    const here = [].concat(c.farmers ?? []).filter(a => {
      const r = rows.find(x => x.agent === a);
      return this.hands(r) && Number(r.room_num) === room;
    });
    const want = here.length >= Number(c.min_farmers ?? 1);
    if (want === this.posted) return;
    const r = await this.withBusy(c.singer, () => want
      ? this.order(c.singer, { mode: 'survive', farm_strategy: null, assigned_room: room, confine_rooms: [room],
          roam: false, never_attack: true, use_safe_spots: true,
          room_enchant: { enabled: true, spells: [c.spell], rooms: [room] } },
          `${here.length} farmer(s) in ${room}: post the singer`)
      : this.order(c.singer, { room_enchant: null, confine_rooms: null, never_attack: false },
          'no farmers in the room: stand the singer down'));
    if (r === null) return;                               // another loop holds the singer
    const ok = this.didOrder(r);
    this.log(want ? 'posted' : 'stood down', { singer: c.singer, room, farmers: here.length,
      error: ok ? null : (r?.error ?? r?.reason ?? 'not confirmed') });
    if (ok) this.posted = want;
  }

  async teardown() {
    // Leave the singer unposted rather than casting into an empty room after we have gone.
    const c = this.conf();
    if (this.posted && c.singer) await this.order(c.singer, { room_enchant: null, confine_rooms: null,
      never_attack: false }, 'supervisor stopping');
  }
}

// Run only as an entry point, so tests can import the class.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await supervisorMain(RoomBuff, { id: 'example-room-buff', entryFile: import.meta.url });
