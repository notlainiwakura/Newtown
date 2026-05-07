# Fixture System Design

**Date**: 2026-04-09
**Status**: Approved

## Purpose

Inhabitants requested furniture for their buildings via the postboard. The existing object system allows pickup/drop/destroy, so furniture would get snatched. Fixtures are immovable objects with custom procedural sprites that become permanent parts of a building.

## Design Decisions

- **Placement**: Admin-only. Inhabitants request via postboard, admin seeds fixtures.
- **Sprites**: Per-fixture procedural canvas renderers (like character sprites).
- **Agent awareness**: DB-backed query at prompt-build time. No code changes needed to add new fixtures.

## Data Layer

Fixtures use the existing `objects` table. No schema migration. Distinguished by metadata flags:

```json
{
  "fixture": true,
  "spriteId": "lamp_desk",
  "tileX": 7,
  "tileY": 5
}
```

- `fixture: true` — marks as immovable, triggers sprite lookup and tool guards
- `spriteId` — key into the procedural sprite registry
- `tileX` / `tileY` — optional fixed tile position within building zone (prevents random repositioning on poll)

Created via direct DB insert or CLI helper. Example:

```sql
INSERT INTO objects (id, name, description, creator_id, creator_name, owner_id, owner_name, location, created_at, updated_at, metadata)
VALUES ('fixture_lamp_lh', 'desk lamp', 'A brushed steel task lamp with an adjustable arm, casting warm light. Requested by John.', 'admin', 'Administrator', NULL, NULL, 'lighthouse', <now>, <now>, '{"fixture":true,"spriteId":"lamp_desk"}');
```

## Visual Layer

### Sprite Registry (`fixtures.js`)

New file: `src/web/public/game/js/fixtures.js`

A map of `spriteId -> draw function`. Each function receives a Phaser canvas context and draws the fixture at a fixed size (48x48 default). Example:

```js
const FIXTURE_SPRITES = {
  lamp_desk: (ctx, theme) => {
    // Base plate
    // Steel arm (angled)
    // Lamp head
    // Warm yellow glow circle
  },
};
```

### ObjectManager Changes

In `_createObjectSprite`:

1. Check `obj.metadata?.fixture` — if true, use fixture rendering path
2. Look up `FIXTURE_SPRITES[obj.metadata.spriteId]` for the draw function
3. Use `metadata.tileX`/`tileY` if present instead of random tile pick
4. No float animation (fixtures are static)
5. Still clickable for name + description popup

## Agent Context

In the system prompt builder, after injecting building description, query fixtures at the character's current location:

```
CURRENT LOCATION: Lighthouse — solitude, seeking, clarity
Contains: a brushed steel task lamp with adjustable arm (warm glow, on the desk)
```

Implementation: query objects where `location = <building>` and `metadata LIKE '%"fixture":true%'`, format as a "Contains:" line. Appended to the building context already injected in `town-life.ts` and `index.ts`.

## Tool Guards

In `character-tools.ts`, the following tools check `metadata.fixture` before executing:

- `pickup_object` — "This is part of the building and can't be picked up."
- `drop_object` — N/A (fixtures have no owner)
- `give_object` — N/A (fixtures have no owner)
- `destroy_object` — "This is part of the building and can't be removed."

`examine_objects` and `reflect_on_object` work normally — characters can observe and derive meaning from fixtures.

## Files Changed

| File | Change |
|------|--------|
| `src/web/public/game/js/fixtures.js` | **New** — sprite registry |
| `src/web/public/game/js/systems/ObjectManager.js` | Fixture rendering branch, fixed tile position, no float |
| `src/agent/character-tools.ts` | Guard pickup/destroy for fixtures |
| `src/agent/town-life.ts` | Inject fixtures into building context |
| `src/web/public/game/index.html` | Script tag for `fixtures.js` |

## First Fixture

**John's desk lamp** at the Lighthouse:
- name: "desk lamp"
- description: "A brushed steel task lamp with an adjustable arm, casting warm light. Requested by John."
- location: "lighthouse"
- spriteId: "lamp_desk"
- Procedural sprite: steel base, angled arm, warm glow
