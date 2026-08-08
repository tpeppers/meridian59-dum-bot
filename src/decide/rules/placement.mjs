// WHERE CHARACTERS STAND, AND WHY LEAVING THEM ALONE IS USUALLY RIGHT.
//
// The harness records the shape of this failure precisely, and it is not the one you
// would guess. A fleet does not collapse into one room because someone moves it there.
// It collapses because every keeper independently does the correct thing: standing
// anywhere its prey does not spawn — a town, an inn, the room it woke up in after
// dying — the keeper leaves for the best-ranked room it knows, and that is the SAME
// ROOM for every character hunting the same creature. Twenty-one characters placed
// across six rooms were back in two within the hour, one death at a time, each one
// individually behaving correctly.
//
// So placement is genuinely a fleet-level decision and genuinely belongs out here. The
// harness already has the mechanism (`assigned_room`, and `spread` to set a whole
// fleet's at once); what it does not have is a standing opinion about who goes where,
// because that is a decision about what the fleet is FOR.
//
// AND THE COUNTERWEIGHT, which is the harder half. Every relocation stops a keeper and
// walks a character across the world. The harness's supervisor learned that re-deciding
// placement each round is a thrash rather than self-healing: the assignment reshuffles
// constantly and nobody arrives before being reassigned. So the rules here are
// hysteretic by construction — they only ever move a character that is in the WRONG
// place, never one that is merely in a suboptimal one.

export const placementRules = [
  {
    id: 'assign-room',
    faculty: 'movement',
    why: 'without a standing assignment every keeper walks to the same best-ranked room, ' +
         'and a spread fleet collapses into one or two rooms one death at a time',
    enabled: doctrine => doctrine.placement?.spread === true,
    offWhy: 'placement.spread is off, so DUM does not move anyone',
    decide(obs, doctrine) {
      const rooms = doctrine.placement?.rooms ?? [];
      if (!rooms.length) return null;

      // ALREADY ASSIGNED SOMEWHERE THIS DOCTRINE ALLOWS: leave it. This is the
      // hysteresis. A character assigned to room B when room A ranks marginally better
      // stays in B, because the walk costs more than the margin and the reshuffle costs
      // more than the walk.
      if (obs.keeper?.policy?.assignedRoom != null &&
          rooms.includes(obs.keeper.policy.assignedRoom)) return null;

      // A PARTNERED CHARACTER IS NOT RELOCATED ALONE. Its partner is standing in a
      // field expecting it in the same room; moving one half is how a pair becomes two
      // characters that will not start a fight. Pair placement is a fleet decision and
      // belongs in the fleet tick.
      if (obs.commitment?.kind === 'partner' || obs.keeper?.policy?.partner) return {
        kind: 'none',
        why: `${obs.agent} is paired, and relocating one half of a pair leaves the other ` +
             `waiting in a field for somebody who is now in another room`,
        evidence: { partner: obs.keeper?.policy?.partner ?? null },
      };

      // TODO(placement): choose from `rooms` by what the fleet is already using, so
      // that per_room is respected. That needs the fleet observation, so this rule will
      // move to the fleet tick once it does more than assign the first allowed room.
      // Until then it is honest about being a placeholder: it assigns the first room
      // the doctrine lists, which is correct for a single character and wrong for a
      // fleet, and the fleet path is gated behind placement.spread being opt-in.
      const room = rooms[0];
      return {
        kind: 'orders',
        orders: { action: 'start', assigned_room: room },
        why: `${obs.agent} has no assignment this doctrine recognises, so it will walk to ` +
             `whichever room ranks best — the same room every other character picks. ` +
             `Pinning it to ${room}`,
        evidence: { rooms, had: obs.keeper?.policy?.assignedRoom ?? null },
      };
    },
  },
];

// TODO(placement, fleet): `spread-fleet` — assign pairs across `placement.rooms`
// respecting `per_room`, using the fleet observation. The harness has a `spread` tool
// that sets a whole fleet's assignments in one call, which is the right target: doing
// it character-by-character is N writes and N chances to half-apply.
export const placementFleetRules = [];
