# Reflective human controls

The running control server exposes `GET /controls?agents=<comma list>` and
`POST /controls`. Reads contain a field schema, strategy templates, per-agent
current/restart values, and a revision bound to the running controller and keeper
processes. POST accepts `fleet`, `pid`, `revision`, `agents`, `patch`, and optional
`inherit`. Only an explicit POST applies the desired state.

`strategy.<catalogue ID>.enabled` and each catalogue setting are reflected without
separate website or terminal field lists. `order.<broker policy key>` comes from the
live harness policy schema. `room_lock` is the convenience form of confinement to
an assigned/current farming room. Its off action clears confinement and releases
movement. Base doctrine and strategy source files are never edited by these UIs.

The harness's DBFST terminal and authenticated chat interface use this endpoint;
the strategy-game DUM page forwards through its local server. DUM registers its
URL, fleet and process identity with the attached broker at startup and heartbeat.
Registration is a verified loopback handshake, not process lifecycle management.

StrategyStore keeps the running assignments in memory. External file edits appear
in restart preview without altering current state. Saves update the live store and
atomic runtime file. Keeper overrides live beside it in an ignored `.controls.json`
file. They capture the previous value for Inherit, filter rule output before
first-match selection, and filter requests again at dispatch. A save reserves its
selected agents against new DUM writes and refuses while an earlier write remains
in flight. Partial results identify which bots accepted their changes.

Adding/removing catalogue settings updates all interfaces on controller restart.
Retired persisted strategy IDs/settings are ignored while recognized settings are
preserved. New keeper policy options appear through the broker's schema. The
generated FleetScratch templates are declarative `extends: strategy:<id>` patches;
they do not execute arbitrary source or bypass the errand compiler.

Contract additions: `policy_control read/save` returns verified keeper policy,
restart policy, schema, revision and per-agent save receipts. `dum_controls
register/list` verifies controller identity and advertises discovery. They are
human control operations; ordinary decision rules do not emit these calls.

Run `node tests/run.mjs human-controls` for reflection, live/file separation,
revision checks, overlays, room locks and inherited release.
