// WHAT DUM IS ALLOWED TO ASK THE HARNESS FOR — an allow-list, and three refusals that
// are not negotiable.
//
// The harness exposes something like sixty tools. Most of them are fine and a few of
// them are account-lifecycle operations that would be catastrophic to reach by
// accident from a loop that runs every thirty seconds against twenty-one characters.
//
// This file is the boundary. It is deliberately data rather than scattered
// conditionals, so the answer to "can the bot do X" is one grep.

// The seven table pieces in the Duke's Feast Hall — the only things `activate` may touch.
// Pure data from src/decide/feast-hall.mjs, read off the kod; nothing from decide/ runs here.
import { FEAST_DISPENSER_NAMES } from '../decide/feast-hall.mjs';

// ---------------------------------------------------------------- never
//
// Each of these is here for a specific recorded reason, not for tidiness.
const NEVER = {
  // THE ROSTER FILES ARE THE ONLY RECORD OF THE ACCOUNT PASSWORDS, and `leave` drops
  // the roster. There is no recovery. This is the first rule in every instruction file
  // in this family of repositories and it is the first entry here.
  leave: 'drops the roster, which is the only record of the account passwords',
  // Creating and re-rolling characters is an operator decision with an irreversible
  // outcome, and a bot that can do it will eventually do it in a loop.
  reroll: 'creates or re-rolls a character — irreversible, and an operator decision',
  join: 'account lifecycle. DUM acts on characters the broker is already holding',
  // Godmode is a fork-only administrative channel. Nothing on the playing path may
  // depend on it, and a "deterministic mover" that uses it is not playing the game.
  godmode: 'administrative. A bot that uses it is not playing the game',
};

// ---------------------------------------------------------------- read
//
// Safe at any time, including with --dry-run. These are what `sense` is built from.
export const READ = new Set([
  'fleet', 'status', 'progress', 'inventory', 'equipment', 'abilities', 'spells',
  'loadout', 'look', 'map', 'safe_spots', 'hunting_grounds', 'prey', 'history', 'post_mortem',
  'who', 'safety', 'merchants', 'signets', 'bank', 'resolve_item_names', 'faction_status',
  // HOW LONG A WALK TAKES, from the harness's own recorded per-hop times. A pure local
  // computation over the transit books and the room graph — it sends nothing to the game
  // server, which is what makes it safe to ask on a tick. The night shift uses it to set
  // off early enough to be standing in the graveyard when the window opens rather than
  // walking through the first minute of it.
  'travel_estimate',
]);

// ---------------------------------------------------------------- write
//
// Everything DUM may change. Note what is NOT here: `say`, `chat`, `converse` and
// `inbox`. DUM does not talk. The harness's conversation boundary — deterministic
// acknowledgements, broadcast deduplication, a commitment classifier, an outbound leak
// detector — is stronger than anything this repository would grow, and a deterministic
// bot has nothing to say that is worth reopening that surface for.
export const WRITE = new Set([
  // The single most important one: orders to the keeper. Nearly everything DUM does is
  // a change to this.
  'autopilot',
  // Placement.
  'travel', 'spread', 'walk_to', 'cancel_movement',
  // Economy.
  'bank', 'sell', 'sell_all', 'shop', 'supply', 'quartermaster',
  // THE OTHER HALF OF SURVIVING A DEATH. A bank holds money and a vault holds OBJECTS, and
  // everything in neither is on the floor of wherever the character fell. It is on the write
  // list rather than in NOT_YET because the decision it encodes - "this pack has more in it
  // than the walk home is worth risking" - is an economy decision on a minutes clock, which
  // is DUM's side of the boundary. Storing is also the recoverable direction: a vaultman
  // sells your own deposit back at a retrieval fee, so the worst a wrong deposit costs is
  // that fee. Nothing here retrieves.
  'vault',
  // Errands the harness already knows how to run end to end.
  'loot_run', 'rest_up', 'equip_best', 'wear_best', 'escape_underworld',
  // One bounded, localhost-only planner errand. The harness chooses from the first
  // unfinished queue stage, funds one fixed-price ability, verifies it, and restores
  // the keeper; DUM cannot name an arbitrary purchase through this surface.
  'buy_next_planned_skills',
  // One source-audited quest primitive. It permits only the fixed join phrase and an
  // exact quest-item offer to an exact faction recipient; general say/trade stay out.
  'faction_join',
  // Source-audited promotion and explicitly opt-in token PvP. Both broker tools
  // enforce exact targets and faction/profile preconditions; general fight remains out.
  'faction_soldier', 'faction_game',
  // KEEPING A FACTION, WHICH IS A DIFFERENT OPERATION FROM GETTING ONE. Membership decays
  // on a wall-clock timer and is revoked 24 hours after the last service; the only notice
  // is prose the server sends the player. `faction_loyalty` is the same narrow shape as
  // `faction_join` — it speaks exactly the one fixed word "loyalty" to the character's
  // OWN liege, and offers only a source-defined quest item to a source-defined recipient.
  //
  // It is this rather than `say` for the reason the whole boundary exists: the trigger is
  // a sentence the SERVER sent, which the harness catches off its own event stream and
  // hands to DUM as a field on the row. So DUM still reads no chat, hears no player, and
  // composes no text — the one word it can cause to be spoken is a constant in the
  // harness, not a string that travels from here.
  'faction_loyalty',
  // Provisioning may cast exactly one audited, self-only service spell. The argument
  // guard below keeps widening this surface from also widening DUM into combat magic.
  'cast',
  // `act`, AND ONLY ITS `go` VERB — enforced in deny() below, because the tool name is
  // not enough. This is the narrowest widening that makes a PLACE-TRIGGERED room
  // reachable at all, and it is here for one of them: the crate under Castle Victoria
  // answers to BP_REQ_GO on a square and to nothing else. Every other verb `act` carries
  // (use, unuse, get, drop, eat) reaches into the character's pack, which is a
  // different kind of decision and is not one DUM claims. The one exception, also in
  // deny(): `activate` on a named food dispenser in the Duke's Feast Hall, which is how
  // the hall hands out its free food and touches nothing the character already holds.
  'act',
  // `approach` AND `say`, BOTH FOR THE DUKE'S TABLE AND BOTH FOR THE HUMANS WATCHING.
  //
  // Neither is needed to take the food. `UserTryActivate` checks only that the dispenser
  // is in the same ROOM (user.kod: GetOwner <> poOwner) — no distance test — so a
  // character can empty a table from the far side of the hall and the server allows it.
  //
  // The feast is a public event on a SHARED SERVER with human players standing at the same
  // tables, and a character that harvests forty slices of pork from a doorway twenty
  // squares away, in silence, reads as exactly what it is. So the grab errand walks up to
  // the table and says "Mmm, slice of pork!" when it is done. Operator's call, 2026-09-04.
  //
  // NARROW ON PURPOSE. `say` is local room speech; `chat`, `converse` and the private
  // channels stay out, and the only text DUM composes is that one fixed line naming the
  // food it just took. `approach` walks toward a target it can already see in the room —
  // it is not a route across the world, which is `travel`.
  'approach',
  'say',
]);

// Tools that exist and DUM has no business calling, listed so that adding one later is
// a deliberate act with a comment attached rather than a silent widening.
export const NOT_YET = new Set([
  'attack', 'fight', 'face', 'attack_intent', 'move_intent',
  'context_intent', 'pilot', 'recording', 'rescue', 'leave_raza', 'split', 'trade',
  'loot', 'chat', 'converse', 'inbox', 'describe', 'look_at', 'go_through',
  'movement_mode', 'cancel_action', 'wait_for_event',
]);

/**
 * Why this call must not be made, or null if it may be.
 * @param {string} tool
 * @param {object} args
 * @returns {string|null}
 */
export function deny(tool, args = {}) {
  if (NEVER[tool]) return `refused — ${NEVER[tool]}`;
  if (READ.has(tool) || WRITE.has(tool)) {
    // ARGUMENT-LEVEL CHECK, because the tool name is not enough for this one either.
    //
    // `act verb:"go"` IS A PLACE INTERACTION AND EVERY OTHER VERB IS AN OBJECT ONE. `go`
    // sends BP_REQ_GO, and the server answers on whatever square the character is
    // standing on — that is the whole mechanism behind stairs, doors, ladders and the
    // Castle Victoria crate. The rest (use, unuse, get, drop, activate, eat) reach into
    // the pack: they are how a bot ends up wearing the wrong armour or dropping a stack
    // of reagents, and none of those decisions is one DUM claims.
    //
    // It is worth knowing that `go` is not harmless either. On an EXIT square it takes
    // the exit, so a `go` is only safe where the caller knows which square it is on —
    // which is why the crate errand refuses to send one unless its `walk_to` reported
    // `arrived`, rather than sending it hopefully.
    //
    // THE ONE OTHER VERB, AND THE ONE OTHER TARGET SET: `activate` on a FOOD DISPENSER in
    // the Duke's Feast Hall. A dispenser is not in the pack and cannot be — `activate` on
    // it CREATES one item of food and hands it over (dispensr.kod TryActivate), which is
    // how the hall gives out its free food. It is still an object interaction, so the
    // widening is by name rather than by verb: the seven table pieces the hall places
    // (duke4.kod:123-176), and nothing else. `activate` on a lever, a door, a shop or a
    // player's item is refused exactly as before.
    if (tool === 'act' && args.verb === 'activate') {
      const target = String(args.target ?? '').trim().toLowerCase();
      if (!FEAST_DISPENSER_NAMES.includes(target))
        return `refused — act verb:"activate" is allowed only on a Feast Hall food dispenser ` +
               `(${FEAST_DISPENSER_NAMES.join(', ')}), not "${args.target ?? '?'}". See ` +
               `src/link/surface.mjs`;
    } else if (tool === 'act' && args.verb !== 'go')
      return `refused — act verb:"${args.verb ?? '?'}" reaches into the character's pack. ` +
             `DUM only claims verb:"go", which acts on the square underfoot, and ` +
             `verb:"activate" on a Feast Hall dispenser. See src/link/surface.mjs`;
    if (tool === 'cast' && !['create weapon', 'create food']
          .includes(String(args.spell ?? '').trim().toLowerCase()))
      return `refused — DUM may cast only the self-only provisioning spell "create weapon", ` +
             `not "${args.spell ?? '?'}"`;
    // `autopilot` is on the write list and `autopilot --hard` ENDS the keeper rather
    // than making it inert: no frames, no observe(), no death record, no post-mortem.
    // The harness's own note is that deaths kept happening in exactly the windows it
    // had chosen to stop looking. DUM standing a character down must never also turn
    // the instruments off.
    if (tool === 'autopilot' && args.hard === true)
      return 'refused — autopilot hard:true ENDS the keeper, so the character keeps ' +
             'playing while the instruments go dark. Use action:"inert", which stops it ' +
             'driving and leaves it watching';
    return null;
  }
  if (NOT_YET.has(tool))
    return `refused — "${tool}" is a harness capability DUM does not claim. If a rule ` +
           `needs it, add it to WRITE in src/link/surface.mjs with a comment saying why`;
  return `refused — "${tool}" is not on DUM's surface. See src/link/surface.mjs`;
}

/** Every tool DUM may call, for `doctor` to check against the broker's actual list. */
export const ALLOWED = new Set([...READ, ...WRITE]);
