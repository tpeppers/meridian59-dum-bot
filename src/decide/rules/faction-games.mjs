// COUNCIL TOKEN PVP IS NEVER AN ACCIDENTAL CONSEQUENCE OF A COMBAT POLICY.
// This table is reachable only through the explicit play-faction-games strategy. The
// broker still owns the decisive safety check: a current profile must prove both the
// token and a different known faction immediately before it attacks.

import { factionDefinition } from '../../factions/catalog.mjs';
import { STRATEGY_IDS, strategyRows } from '../../strategies/catalog.mjs';

export const factionGameFleetRules = [{
  id: 'deliver-faction-game-token', faculty: 'work', scope: 'fleet',
  why: 'a strategy-selected faction player is carrying a recovered Council token',
  decide(observation, doctrine) {
    for (const row of strategyRows(observation, doctrine, STRATEGY_IDS.PLAY_FACTION_GAMES)) {
      if (row.commitment || row.parked || row.piloted) continue;
      const token = row.faction_game?.carrying?.[0];
      const factionId = row.faction_game?.faction;
      if (!token || !factionId) continue;
      const faction = factionDefinition(factionId);
      return { kind: 'errand', orders: { errand: 'faction-game-deliver', agent: row.agent,
        label: `deliver ${token.name} to ${faction.leader}`, steps: [
          { tool: 'travel', args: { agent: row.agent, to: faction.room },
            timeout_ms: 300_000, estimate_ms: 150_000, expect: 'arrived',
            why: `take the Council token to ${faction.leader}` },
          { tool: 'faction_game', args: { agent: row.agent, action: 'deliver', token: token.id },
            collect: 'messages', estimate_ms: 180_000, timeout_ms: 600_000,
            why: 'deliver to the own liege rather than an unverified strong-believer councilor' },
        ] }, why: `deliver ${token.name} for ${faction.title}`,
        evidence: { agent: row.agent, faction: factionId, token } };
    }
    return null;
  },
}, {
  id: 'engage-opposing-token-carrier', faculty: 'work', scope: 'fleet',
  why: 'a strategy-selected unit has just verified an opposing faction player carrying a Council token',
  decide(observation, doctrine) {
    for (const row of strategyRows(observation, doctrine, STRATEGY_IDS.PLAY_FACTION_GAMES)) {
      if (row.commitment || row.parked || row.piloted || row.health?.pct < 0.8) continue;
      const target = row.faction_game?.targets?.[0];
      if (!target) continue;
      return { kind: 'errand', orders: { errand: 'faction-game-engage', agent: row.agent,
        label: `intercept ${target.name}`, steps: [
          { tool: 'faction_game', args: { agent: row.agent, action: 'engage', target: target.id },
            estimate_ms: 150_000,
            why: 'reverify, defeat the opposing token carrier, and recover the dropped token' },
        ] }, why: `intercept ${target.name}, a verified ${target.faction} ${target.token} carrier`,
        evidence: { agent: row.agent, target } };
    }
    return null;
  },
}];
