// THE SWARM — twenty keepers that do nothing at all until a human logs in, and then do
// exactly what that human does.
//
// WHAT IT IS FOR. The Graveyard of Tos is open thirty-five minutes in every hundred and
// twenty (tosgrave.kod gates TryCreateMonster on the game hour), so most of a day the
// fleet's best ground generates nothing. This is what the other eighty-five minutes are
// for: instead of parking the fleet on prey that cannot advance it, park it INERT and let
// the operator drive one character by hand with twenty at its back.
//
// THE WHOLE DESIGN TURNS ON ONE PROTOCOL FACT, AND IT IS THE FACT THAT BREAKS THE OBVIOUS
// IMPLEMENTATION. Meridian allows ONE CONNECTION PER CHARACTER. The moment the operator
// opens a client on a fleet character, the server drops the broker's connection to it —
// so the leader becomes the one character in the world the fleet cannot see. Every naive
// version of this ("read the leader's position, tell the others to walk there") is asking
// for a reading that no longer exists.
//
// The harness already solved this for a different reason. `m59-proxy.mjs` sits between
// the client and the game server on 5961; `m59-shortcuts.mjs --proxy` writes the
// click-to-play shortcuts pointing at it. With the operator connected THROUGH the proxy,
// the broker keeps its own view of that character — position, room, and the packets that
// describe what it is swinging at — while the human plays normally and notices nothing.
//
// SO THE PROXY IS NOT AN OPTIMISATION HERE, IT IS THE PRECONDITION. A swarm whose leader
// logged in directly is a swarm with no leader, and it must say so rather than quietly
// following the last position it saw. `leaderOf` returns a REASON when it cannot find
// one, and the rule reports that reason instead of acting.
//
// WHO THE LEADER IS, AND WHY WE DO NOT ASK THE OPERATOR TO SAY. The broker already tracks
// exactly this: `resumeFleet` reads the command line of every running `meridian.exe`
// (`/U:` is the account, which `m59-shortcuts.mjs` puts there), matches it against the
// roster, and records the agent as piloted — `piloted: { pid, since, objectId, character,
// keeperWasRunning }`, surfaced as `piloted` on each fleet row. It then CHECKS by reading
// the who list, because a command line says what a process was asked to do rather than
// that anybody reached the world. That is a better answer than a doctrine naming a leader,
// and it is free.

// A swarm that has to be told who is leading is a swarm that is wrong every time the
// operator changes their mind. The leader is whoever is at the controls, full stop.
export function leaderOf(rows = []) {
  const piloted = rows.filter(r => r.piloted);
  if (!piloted.length)
    return { leader: null,
             why: 'nobody is piloting a character — the swarm sleeps until an operator ' +
                  'launches one from the fleet terminal (L). This is the resting state, ' +
                  'not a fault' };
  if (piloted.length > 1)
    return { leader: null,
             why: `${piloted.length} characters are piloted at once and a swarm has one ` +
                  `head. Close all but one client; the swarm will not guess which of them ` +
                  `is meant to be followed` };
  const leader = piloted[0];
  // A PILOTED ROW WITH NO ROOM IS THE DIRECT-LOGIN CASE. It is NOT fatal — see
  // `leaderBySight` — but it is a different and much worse mode, so it is labelled.
  if (leader.room == null) return { leader, sighted: false, why: null };
  return { leader, sighted: true, why: null };
}

// FOLLOWING A LEADER THE BROKER CANNOT SEE, BY BORROWING THE SWARM'S OWN EYES.
//
// The proxy is the good answer and not the only one. When the operator logs in directly
// the server drops OUR connection to that character — but it does not make the character
// invisible to everyone else. A player standing in a room is an ordinary room object
// carrying `OF_PLAYER`, with a row and a column, and every follower in that room reports
// it in its own room contents like anything else.
//
// And we know WHICH object to look for. The pilot claim records the leader's `objectId`
// (`piloted: { pid, since, objectId, character, keeperWasRunning }`), so this is an id
// match rather than a guess by name — which matters, because names are not unique on a
// shared server and there are real players about.
//
// WHAT THIS BUYS AND WHAT IT DOES NOT, because the difference is exactly the doors:
//
//   IN THE SAME ROOM — full function. Followers see the leader's square, close to it, and
//   can watch what it is fighting. No proxy needed at all.
//
//   THROUGH A DOOR — blind. When the leader leaves, followers see the object REMOVED and
//   nothing else: no packet says which exit it took. The swarm is stranded in the old room
//   until the leader comes back or somebody happens to be standing where it went.
//
// So the honest rule is: without the proxy a swarm can follow a leader around a room and
// cannot follow one out of it. That is why `requires_proxy` exists and why this fallback
// reports itself on every pass rather than passing for the real thing.
// THE BEST CHANNEL IS THE ONE ALREADY INJECTED INTO THE LEADER'S OWN CLIENT, and it needs
// neither a proxy nor line of sight.
//
// `tools/m59-agent/m59agent.dll` is injected into every client the fleet terminal launches
// (L), and it exists precisely to drive a client "without a proxy in the path". It runs a
// socket thread, and it already answers `pos` with the client's own player struct
// (m59agent.c:169) —
//
//     {"port":..,"pid":..,"id":..,"room":<room_id>,"x":..,"y":..,"angle":..}
//
// `room_id` is read from `GetPlayerInfo()`, which the client exports, so it is the CLIENT'S
// OWN idea of where it is and it changes the instant the client loads a new map. That is
// the door problem solved outright: no inference from a vanished object, no guessing which
// exit, and nothing for the swarm to lose track of.
//
// This is why `requires_proxy` in the doctrine is a preference rather than a law. The order
// of preference is:
//
//   1. THE AGENT SOCKET (this). Works through doors. No proxy. Already built.
//   2. THE PROXY. Works through doors, at the cost of running m59-proxy.mjs and putting a
//      rewriting shim on the leader's connection.
//   3. BY SIGHT (`leaderBySight`). No extra machinery at all, and blind at every door.
//
// The agent reports its port on the same struct, so the swarm does not need to be told
// where to look — the pilot claim already carries the pid, and the agent answers on the
// port it announces.
export function leaderFromAgent(agentPos) {
  if (!agentPos || typeof agentPos !== 'object')
    return { room: null, at: null,
             why: 'the leader\'s client is not answering its agent socket — either the DLL ' +
                  'was never injected (launch from the terminal with L, which injects) or ' +
                  'the client has gone' };
  if (agentPos.room == null)
    return { room: null, at: null,
             why: 'the agent answered but reported no room, which is what it does before the ' +
                  'first map has finished loading — try again on the next pass' };
  return { room: agentPos.room, at: { row: agentPos.y, col: agentPos.x }, why: null };
}

export function leaderBySight(leader, roomViews = []) {
  const wantId = leader?.piloted?.objectId;
  if (wantId == null)
    return { room: null, at: null,
             why: 'the pilot claim recorded no object id, so there is nothing to match on' };
  for (const v of roomViews) {
    const hit = (v.objects ?? []).find(o => o.id === wantId);
    if (hit) return { room: v.room, at: { row: hit.row, col: hit.col },
                      seenBy: v.agent, why: null };
  }
  return { room: null, at: null,
           why: 'no follower can see the leader. Without the proxy the swarm only knows ' +
                'where the leader is while somebody is standing in the room with it — a ' +
                'leader that has gone through a door is simply gone until it comes back' };
}

// WHO FOLLOWS. Everybody in the world except the leader — but a follower that is dead, in
// the Underworld, or being held by somebody else's errand is not available, and saying so
// is better than issuing an order that silently does nothing.
export function followersOf(rows = [], leader) {
  const out = { follow: [], holdback: [] };
  for (const r of rows) {
    if (!leader || r.agent === leader.agent) continue;
    if (!r.in_game) { out.holdback.push({ ...r, whyNot: 'not in game' }); continue; }
    if (r.room === UNDERWORLD) { out.holdback.push({ ...r, whyNot: 'in the Underworld' }); continue; }
    if (r.committed) { out.holdback.push({ ...r, whyNot: `committed: ${r.committed.label ?? r.committed.kind}` }); continue; }
    out.follow.push(r);
  }
  return out;
}

export const UNDERWORLD = 1;

// HOW CLOSE IS FOLLOWING. Melee reach is a disc of radius 2-3 SQUARES — both sides run
// `SquaredDistanceTo <= GetAttackRange^2` on square coordinates (nomoveon.kod:121), and
// fine coordinates are read by nothing except which way a monster is drawn facing. So a
// swarm packed tighter than about two squares is buying nothing and getting in its own
// way; one that trails further than three cannot hit what the leader is hitting.
export const FOLLOW_WITHIN = 2;

// A ROOM CHANGE IS THE EVENT, NOT THE POSITION. Following a leader square by square is
// both expensive and wrong: the server paces movement at roughly one action a second, so
// a swarm that re-issues a walk every tick spends its whole budget on micro-corrections
// and never arrives. What actually matters is the ROOM — and rooms are what doors change.
//
// "If the swarm leader goes through doors, they follow" is therefore not a special case.
// A door is an exit that `travel` already knows how to take (`act verb=go` for doors and
// stairs, which walking off an outdoor edge does not need). Following the leader's ROOM
// covers doors, stairs, portals and edges with one rule instead of four.
export function followPlan(leader, followers, { within = FOLLOW_WITHIN } = {}) {
  const plan = [];
  for (const f of followers) {
    if (f.room !== leader.room) {
      plan.push({ agent: f.agent, do: 'travel', to: leader.room,
                  why: `leader is in room ${leader.room}, this one is in ${f.room ?? '?'}` });
      continue;
    }
    plan.push({ agent: f.agent, do: 'approach', target: leader.agent, distance: within,
                why: `same room as the leader; close to within ${within} squares` });
  }
  return plan;
}

// EVERYONE ON ONE TARGET, AND THE REASON IS ARITHMETIC RATHER THAN ENTHUSIASM.
// Advancement is a PER-CHARACTER flag rather than a split pot (AdvancementCheck), so
// twenty characters on one corpse each roll for the gain that one corpse pays. Focus fire
// is the whole point of a swarm and it is why this is not "everyone fights whatever is
// nearest".
//
// WHAT WE CAN ACTUALLY READ. The leader is a human and does not tell us its intent, so the
// target is inferred, in this order, and the order matters:
//
//   1. what the leader is recorded as swinging at (the broker keeps this per session);
//   2. failing that, the thing in the room that is TAKING damage — a creature whose
//      health is falling is being fought by somebody, and in a room holding only the
//      swarm that somebody is the leader;
//   3. failing both, nothing. NOT "the nearest creature": guessing here turns a swarm
//      into twenty characters starting twenty separate fights in one room, which is the
//      worst outcome available and looks identical to working.
export function swarmTarget(leader, room = {}, observed = null) {
  // THE PROXY'S READING FIRST, because it is the only one that is not an inference. An
  // attack is a client-to-server packet carrying the target object id, and m59-proxy reads
  // it straight off the wire — no guessing which of three wounded creatures the human
  // meant. `observe.mjs` drops it once it is older than 8 seconds, so a target arriving
  // here is one the leader is swinging at NOW.
  if (observed?.id != null)
    return { target: observed.id,
             how: `read off the leader's own ${observed.how} packet ${observed.age_ms}ms ago` };
  if (leader?.attacking) return { target: leader.attacking, how: 'the leader is swinging at it' };
  const hurt = (room.creatures ?? []).filter(c => c.health_falling);
  if (hurt.length === 1) return { target: hurt[0].id, how: 'the only creature in the room losing health' };
  if (hurt.length > 1)
    return { target: null,
             how: `${hurt.length} creatures are taking damage and none is clearly the ` +
                  `leader's; the swarm holds rather than splitting itself` };
  return { target: null, how: 'the leader is not fighting anything we can see' };
}

// THE FLOOR STAYS WITH THE KEEPER EVEN HERE. A follower that is losing still breaks off:
// the swarm is a work decision, and `survival` is not ours to claim unless the doctrine
// says outright that the character may die for it. So this returns the followers that
// should NOT be told to pile in, and the caller leaves them to their keeper.
export function tooHurtToPileIn(followers, fleeBelow = 0.4) {
  return followers.filter(f => {
    const frac = f.health_max ? f.health / f.health_max : 1;
    return frac <= fleeBelow;
  });
}

export const swarmFleetRules = [
  {
    id: 'swarm-follow',
    faculty: 'movement',
    scope: 'fleet',
    why: 'a swarm is twenty characters that do nothing until an operator takes the ' +
         'controls, and then go where that operator goes — which is what makes a human ' +
         'worth more than a supervisor on the days the graveyard is shut',
    enabled: doctrine => doctrine.swarm?.follow === true,
    offWhy: 'swarm.follow is off. With it on, every unpiloted character stops doing its ' +
            'own work entirely and does nothing at all until somebody logs in',

    decide(fleetObs, doctrine) {
      const rows = fleetObs.characters ?? [];
      const { leader, sighted, why } = leaderOf(rows);
      // THE SLEEPING STATE IS THE COMMON ONE AND IT IS NOT AN ERROR. Reported every pass
      // so that "the swarm is doing nothing" and "the swarm is broken" never look alike.
      if (!leader) return { kind: 'pass', why };

      // DIRECT LOGIN: borrow the swarm's own eyes. Degraded, and it says so — in this mode
      // the swarm holds together inside a room and loses the leader at every door.
      let head = leader, degraded = null;
      if (!sighted) {
        // THE AGENT SOCKET FIRST. It is the only source that survives a door, and the
        // terminal's launch key already injected the DLL that serves it.
        const fromAgent = leaderFromAgent(fleetObs.leader_pos ?? null);
        if (fromAgent.room != null) {
          head = { ...leader, room: fromAgent.room };
        } else {
          // Line of sight is the last resort and is announced as one, because a swarm
          // that is about to lose its leader at the next door should not read as healthy.
          const seen = leaderBySight(leader, fleetObs.room_views ?? []);
          if (seen.room == null)
            return { kind: 'pass',
                     why: `${leader.agent} is piloted and the broker cannot see it ` +
                          `(direct login takes our connection). ${fromAgent.why}; ${seen.why}` };
          head = { ...leader, room: seen.room };
          degraded = `following BY SIGHT — ${seen.seenBy} can see the leader in room ` +
                     `${seen.room}, and the swarm will lose it at the next door. The fix is ` +
                     `the agent socket (relaunch from the terminal so the DLL is injected)`;
        }
      }

      const { follow, holdback } = followersOf(rows, head);
      if (!follow.length)
        return { kind: 'pass',
                 why: `${leader.agent} is leading and nobody can follow: ` +
                      (holdback.map(h => `${h.agent} ${h.whyNot}`).join(', ') || 'the fleet is empty') };

      // `head`, not `leader` — in the sighted-fallback case they differ by exactly the
      // room, which is the only field followPlan reads. Passing `leader` here would plan
      // every follower against `room: null` and send the whole swarm nowhere.
      const plan = followPlan(head, follow, { within: doctrine.swarm?.within ?? FOLLOW_WITHIN });
      return { kind: 'act', plan, degraded,
               why: `${leader.agent} is at the controls in room ${head.room}; ` +
                    `${plan.length} following, ${holdback.length} held back` +
                    (degraded ? ` — ${degraded}` : '') ,
               holdback };
    },
  },

  {
    id: 'swarm-focus',
    faculty: 'work',
    scope: 'fleet',
    why: 'advancement is a per-character flag rather than a split pot, so twenty ' +
         'characters on one creature each gain from the one corpse — focus fire is the ' +
         'entire reason a swarm beats twenty characters in the same room',
    enabled: doctrine => doctrine.swarm?.focus_fire === true,
    offWhy: 'swarm.focus_fire is off; followers move with the leader but pick their own ' +
            'fights, which is a crowd rather than a swarm',

    decide(fleetObs, doctrine) {
      const rows = fleetObs.characters ?? [];
      const { leader, why } = leaderOf(rows);
      if (!leader) return { kind: 'pass', why };

      const { target, how } = swarmTarget(leader, fleetObs.room ?? {}, fleetObs.leader_target);
      if (!target) return { kind: 'pass', why: `no target to share — ${how}` };

      const here = rows.filter(r => r.agent !== leader.agent && r.room === leader.room && r.in_game);
      const hurt = tooHurtToPileIn(here, doctrine.prey?.flee_below ?? 0.4);
      const hurtSet = new Set(hurt.map(h => h.agent));
      const swing = here.filter(r => !hurtSet.has(r.agent));
      if (!swing.length)
        return { kind: 'pass',
                 why: `${here.length} in the room with the leader and all of them are ` +
                      `under the flee line — the survival floor is the keeper's and this ` +
                      `does not override it` };

      return { kind: 'act',
               plan: swing.map(r => ({ agent: r.agent, do: 'attack', target,
                                       why: `focus fire: ${how}` })),
               why: `${swing.length} swinging at the leader's target (${how})` +
                    (hurt.length ? `; ${hurt.length} left to their keeper, too hurt` : '') };
    },
  },
];
