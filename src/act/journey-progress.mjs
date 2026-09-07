// Progress is new ground or an improving recovery, never an activity label or
// a timer tick. Repeated visits to the same squares cannot keep a stuck loop alive.
export class JourneyProgress {
  constructor({ now = Date.now(), stallMs = 90000, maxMs = 1800000 } = {}) {
    Object.assign(this, { started: now, lastProgress: now, stallMs, maxMs,
      seen: new Set(), recovery: null });
  }
  observe(row, now = Date.now()) {
    if (row && !(Number(row.snapshot_age_ms ?? 0) > 15000)) {
      const room = row.room_num ?? row.room?.num;
      const pos = row.position;
      if (room != null) {
        const key = room + ':' + (pos ? pos.row + ':' + pos.col : '?');
        if (!this.seen.has(key)) { this.seen.add(key); this.lastProgress = now; }
      }
      const resting = /rest|holding|heal|mend/i.test(String(row.activity ?? ''));
      const hp = Number(typeof row.health === 'string' ? row.health.split('/')[0]
        : row.health?.value);
      const vigor = Number(row.vigor);
      if (resting) {
        if (!this.recovery || this.recovery.room !== room)
          this.recovery = { room, hp, vigor };
        else {
          if (hp > this.recovery.hp || vigor > this.recovery.vigor) this.lastProgress = now;
          this.recovery.hp = Math.max(this.recovery.hp, hp);
          this.recovery.vigor = Math.max(this.recovery.vigor, vigor);
        }
      } else this.recovery = null;
    }
    if (now - this.started >= this.maxMs) return 'journey exceeded the overall backstop';
    if (now - this.lastProgress >= this.stallMs)
      return 'no new ground or recovery progress for ' + Math.round(this.stallMs / 1000) + 's';
    return null;
  }
}
