// data/terrain.js — ARCHITECT-OWNED. The terrain table: gameplay flags ported 1:1 from the classic `T`,
// plus the 2.5D presentation fields every world/render/art module agrees on.
//
// Fields
//   key     terrain id (also the value stored in G.mods and pyramid floor maps)
//   name    inspect-popup name (classic text, verbatim)
//   glyph   the classic ASCII character (kept for the inspect popup and the minimap legend)
//   color   classic / Minecraft-palette colour (minimap colour; base colour for the procedural art)
//   blocks  1 = cannot be walked into (classic T[k][2])
//   deep    1 = deep water (swimmable; sharks; heavy armour drowns) (classic T[k][4])
//   kind    'ground'  flat walkable block           -> sprite  tile/<key>
//           'liquid'  animated, surface sits 1 ZU low -> sprite  tile/<key>  (frames: 4)
//           'solid'   a tall block column (wall, rock, pyramid) -> sprite tile/<key>, column height = h (+variation)
//           'prop'    a ground block + a sprite standing on it  -> tile/<ground> + prop/<key>
//           'none'    nothing is drawn (void)
//   h       column height above local ground, in ZU (4 art px). Solids only; world.heightAt() adds variation.
//   ground  for props: the ground terrain drawn underneath. 'auto' = the biome's base ground (world.groundKey()).
//   tall    1 = can hide whoever stands behind it; the renderer then draws them again, faintly, on top (see-through)
//   glow    light radius in tiles (0 = none); lighting.js adds a warm light there

const t = (key, glyph, color, blocks, name, kind, extra = {}) =>
  ({ key, glyph, color, blocks, name, deep: 0, kind, h: 0, ground: null, tall: 0, glow: 0, ...extra });

export const TERRAIN = {
  // Jungle
  grass:  t('grass',  '.', '#7FB238', 0, 'jungle floor',     'ground'),
  tree:   t('tree',   '♣', '#2E6B1E', 1, 'jungle tree',      'prop',   { ground: 'grass', tall: 1 }),
  bush:   t('bush',   '"', '#5FA83A', 0, 'ferns',            'prop',   { ground: 'grass' }),
  water:  t('water',  '~', '#3F76E4', 0, 'shallow river',    'liquid'),
  stump:  t('stump',  '.', '#6E4E2C', 0, 'tree stump',       'prop',   { ground: 'auto' }),
  // Swamp
  mud:    t('mud',    ',', '#866043', 0, 'bog mud',          'ground'),
  bogw:   t('bogw',   '~', '#3E6E7E', 0, 'murky water',      'liquid'),
  dtree:  t('dtree',  'ϒ', '#9C7A4E', 1, 'dead tree',        'prop',   { ground: 'mud', tall: 1 }),
  reed:   t('reed',   '"', '#9BC44A', 0, 'reeds',            'prop',   { ground: 'mud' }),
  // Castle Ruins
  stone:  t('stone',  '.', '#8C8C8C', 0, 'flagstones',       'ground'),
  wall:   t('wall',   '#', '#6B6B6B', 1, 'castle wall',      'solid',  { h: 6, tall: 1 }),
  rubble: t('rubble', ':', '#5E5E5E', 0, 'rubble',           'ground'),
  pillar: t('pillar', 'O', '#E9E4D8', 1, 'pillar',           'prop',   { ground: 'stone', tall: 1 }),
  // Mountains
  snow:   t('snow',   '.', '#F7FBFF', 0, 'snow',             'ground'),
  rock:   t('rock',   '▲', '#7F7F7F', 1, 'mountain rock',    'solid',  { h: 5, tall: 1 }),
  ice:    t('ice',    '_', '#A5D8FF', 0, 'ice',              'ground'),
  scree:  t('scree',  ':', '#A3A09A', 0, 'scree',            'ground'),
  // Seas and rivers
  deep:   t('deep',   '≈', '#2448B0', 0, 'deep water',       'liquid', { deep: 1 }),
  // Desert
  sand:   t('sand',   '.', '#DBD3A0', 0, 'sand',             'ground'),
  dune:   t('dune',   ':', '#E6D08C', 0, 'dunes',            'ground', { h: 1 }),
  cactus: t('cactus', '¥', '#3E8E2E', 1, 'cactus',           'prop',   { ground: 'sand', tall: 1 }),
  srock:  t('srock',  '▲', '#B8653A', 1, 'sandstone',        'solid',  { h: 4, tall: 1 }),
  pyr:    t('pyr',    '▲', '#E6B93C', 1, 'pyramid',          'solid',  { h: 3, tall: 1 }),   // stepped: see world.heightAt
  pdoor:  t('pdoor',  '∏', '#FFE27A', 0, 'pyramid entrance', 'prop',   { ground: 'pfloor', glow: 2 }),
  // Inside pyramids
  pwall:  t('pwall',  '#', '#C7A86A', 1, 'tomb wall',        'solid',  { h: 6, tall: 1 }),
  pfloor: t('pfloor', '.', '#8B6F45', 0, 'tomb floor',       'ground'),
  // stairs and chests stand on the current dungeon's own floor (world.groundKey resolves 'auto' inside a dungeon)
  up:     t('up',     '<', '#FFFF55', 0, 'stairs up',        'prop',   { ground: 'auto', glow: 2 }),
  down:   t('down',   '>', '#FFFF55', 0, 'stairs down',      'prop',   { ground: 'auto', glow: 1 }),
  chest:  t('chest',  '■', '#B5833C', 0, 'treasure chest',   'prop',   { ground: 'auto', glow: 3 }),
  // v0.3 dungeons (builder A): one entrance per biome (dd: 1 marks an entrance), interior walls/floors, twist props
  ddoor0: t('ddoor0', '∩', '#5FA83A', 0, 'overgrown temple entrance', 'prop', { ground: 'auto', glow: 2, dd: 1 }),
  ddoor1: t('ddoor1', '∩', '#9C7A4E', 0, 'swamp shack entrance',      'prop', { ground: 'auto', glow: 2, dd: 1 }),
  ddoor2: t('ddoor2', '∩', '#8C8C8C', 0, 'ruined gatehouse entrance', 'prop', { ground: 'auto', glow: 2, dd: 1 }),
  ddoor3: t('ddoor3', '∩', '#A5D8FF', 0, 'cave mouth',                'prop', { ground: 'auto', glow: 2, dd: 1 }),
  ddoor4: t('ddoor4', '∩', '#C7A86A', 0, 'sandstone shrine entrance', 'prop', { ground: 'auto', glow: 2, dd: 1 }),
  jwall:  t('jwall',  '#', '#5E7A4A', 1, 'temple wall',      'solid',  { h: 6, tall: 1 }),
  jfloor: t('jfloor', '.', '#6E7F52', 0, 'mossy flagstones', 'ground'),
  swall:  t('swall',  '#', '#6E5238', 1, 'rotten timber wall', 'solid', { h: 6, tall: 1 }),
  sfloor: t('sfloor', '.', '#8A6E48', 0, 'boardwalk',        'ground'),
  cwall:  t('cwall',  '#', '#4E4E56', 1, 'dungeon wall',     'solid',  { h: 6, tall: 1 }),
  cfloor: t('cfloor', '.', '#5E5E5E', 0, 'dungeon flagstones', 'ground'),
  mwall:  t('mwall',  '#', '#5A6070', 1, 'cave wall',        'solid',  { h: 6, tall: 1 }),
  mfloor: t('mfloor', '.', '#6E6A66', 0, 'cave floor',       'ground'),
  dlock:  t('dlock',  '+', '#B5833C', 1, 'locked door',      'prop',   { ground: 'auto', tall: 1 }),
  dopen:  t('dopen',  "'", '#9C7A4E', 0, 'unlocked door',    'prop',   { ground: 'auto' }),
  dkey:   t('dkey',   '¬', '#E6B93C', 0, 'a key',            'prop',   { ground: 'auto', glow: 2 }),
  trap:   t('trap',   '.', '#8B6F45', 0, 'suspiciously clean floor', 'prop', { ground: 'auto' }),
  trapd:  t('trapd',  '^', '#D8D8D8', 0, 'sprung spike trap', 'prop',  { ground: 'auto' }),
  void:   t('void',   ' ', '#000000', 1, 'nothing',          'none'),
};

/** Base ground per biome index (0 Jungle, 1 Swamp, 2 Castle Ruins, 3 Mountains, 4 Desert). Used for ground:'auto'. */
export const BIOME_GROUND = ['grass', 'mud', 'stone', 'snow', 'sand'];

/** Terrain keys the player must confirm before stepping onto (never auto-walked by double-tap). Classic rule. */
export const SPECIAL_STEP = ['pdoor', 'up', 'down', 'chest', 'ddoor0', 'ddoor1', 'ddoor2', 'ddoor3', 'ddoor4'];

/** Dungeon entrance terrain key per biome index (pyramids keep 'pdoor'). */
export const DOOR_KEYS = ['ddoor0', 'ddoor1', 'ddoor2', 'ddoor3', 'ddoor4'];

/** Every id the art pipeline must be able to draw, for the gallery and for Dave's drop-in art checklist. */
export const TILE_IDS = Object.values(TERRAIN).filter(d => d.kind === 'ground' || d.kind === 'liquid' || d.kind === 'solid').map(d => 'tile/' + d.key);
export const PROP_IDS = Object.values(TERRAIN).filter(d => d.kind === 'prop').map(d => 'prop/' + d.key).concat(['prop/campfire']);
