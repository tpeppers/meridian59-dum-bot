# doctrines

A doctrine is the drop-in file that says what DUM is for. Everything in this
directory is an example, is safe to read, and **names no characters** — see
`CLAUDE.md` rule 4. A doctrine that has to name one belongs in `local/`, which
is gitignored.

| file | what it is |
|---|---|
| [`survive.jsonc`](survive.jsonc) | the null doctrine. DUM watches, reports, and changes nothing. The thing to run first, and the control every other doctrine is measured against |
| [`valley-grind.jsonc`](valley-grind.jsonc) | a worked advancement ladder for a character strong enough to be out of the starter rooms |
| [`lowland-starter.jsonc`](lowland-starter.jsonc) | extends `survive` for a fragile character: report-only, plus the one economy threshold that matters when everything you own fits in a pocket |
| [`castle-crate.jsonc`](castle-crate.jsonc) | the first **errand** doctrine. Changes nobody's orders; occasionally walks one character one room down and back, to a crate whose timer, lockout and history are all invisible. The narrowest claim in this directory |

## The shape

```jsonc
{
  "extends": "survive.jsonc",       // optional, resolved relative to this file
  "fleet": "<your-fleet>",          // required to --commit. No default, ever
  "name": "valley grind",
  "why": "…",                       // what this doctrine is trying to prove

  "claim": { "work": "bot" },       // which decisions DUM takes
  "goals":  { "ladder": [ … ] },    // what a character is trying to become
  "prey":   { … },
  "placement": { … },
  "economy": { … },
  "party":  { … },

  "characters": {                   // per-character overrides, applied with --agent
    "role-scout": { "placement": { "rooms": [ … ] } }
  }
}
```

## Reading one back

```bash
node bin/dum.mjs explain --doctrine doctrines/valley-grind.jsonc
```

prints every effective value with the layer that set it. That output is the
answer to "why is this character banking at 500" and it is the reason the loader
tracks provenance at all — a fleet's settings drift by exactly the mechanism of
somebody passing a flag once and nobody being able to say later whether the
number was chosen or inherited.
