// data/bestiary.js — generated from classic/index.html (names, glyphs and behaviours are VERBATIM).
// OWNER: Foreman B / data worker. YOUR JOB: set arch, acc and size on every record (archetype, accessory hints, size),
// keep everything else exactly as is. Contract: docs/ARCHITECTURE.md §8.B1.
//
// Enemy record: { id, b, t, ch, name, ai, arch, acc, size }
//   id    asset id suffix: "<biomeKey>-<tier 2 digits>"  -> sprite id "enemy/" + id  (e.g. enemy/jungle-00)
//   b,t   biome index 0..4 and tier 0..24 (24 = boss)      ch  classic ASCII glyph      ai  classic behaviour key
//   arch  body archetype for art/creatures.js, one of ARCHETYPES
//   acc   0-2 accessory hints from ACCESSORIES that sell the joke in the name (a tie, a microphone, a briefcase…)
//   size  "s" | "m" | "l"  (bosses are always drawn in the 64x72 boss box regardless)

export const ARCHETYPES = ["biped", "knight", "caster", "skeleton", "ghost", "beast", "brute", "bird", "bug", "serpent", "reptile", "dragon", "plant", "blob", "elemental", "object", "fish", "imp", "shark"];
export const ACCESSORIES = ["hat", "tie", "book", "mic", "briefcase", "crown", "staff", "bow", "sword", "flail", "shield", "halo", "glasses", "phone", "clipboard", "coins", "bottle", "fire", "ice", "leaf", "hood", "cape"];

/** Behaviour blurbs for the inspect popup (classic, verbatim). */
export const AIDESC = { chase: "wants to fight you", slow: "slow but stubborn", flit: "erratic, hard to pin down", sneak: "hits hard from the shadows", burn: "on fire, and generous with it", zap: "attacks from range", poison: "poisonous", root: "doesn't move. Neither should you, near it.", boss: "A boss. Running is a valid life choice.", swim: "lives in the water, and resents visitors" };

const E = (b, t, ch, name, ai, arch, acc = [], size = "m") => ({ id: KEYS[b] + "-" + String(t).padStart(2, "0"), b, t, ch, name, ai, arch, acc, size });
const KEYS = ["jungle", "swamp", "castle", "mountain", "desert"];

/** BEAST[biome][tier] — 5 x 25. Index = tier (24 = boss). */
export const BEAST = [
  [ // 0 jungle
    E(0, 0, "m", "Monkey Who Read One Book on Economics", "flit", "biped", ["book", "tie"], "m"),
    E(0, 1, "f", "Tree Frog Selling Supplements", "chase", "reptile", ["bottle"], "s"),
    E(0, 2, "s", "Snake With a Podcast", "chase", "serpent", ["mic"], "m"),
    E(0, 3, "q", "Mosquito With Venture Funding", "flit", "bug", ["briefcase"], "s"),
    E(0, 4, "p", "Parrot Repeating Things It Heard at a Wedding", "zap", "bird", ["mic"], "s"),
    E(0, 5, "a", "Ant Middle Management", "chase", "bug", ["tie", "clipboard"], "s"),
    E(0, 6, "S", "Leggy Steve, Spider of Some Renown", "poison", "bug", [], "s"),
    E(0, 7, "c", "Jaguar Who Is Between Jobs", "sneak", "beast", ["briefcase"], "m"),
    E(0, 8, "t", "Toucan Life Coach", "flit", "bird", ["mic"], "s"),
    E(0, 9, "v", "Vine With a Five-Year Plan", "root", "plant", ["clipboard"], "m"),
    E(0, 10, "F", "Carnivorous Fern Named Doug", "root", "plant", [], "m"),
    E(0, 11, "g", "Gorilla Who Insists It's Water Weight", "chase", "beast", ["bottle"], "l"),
    E(0, 12, "l", "Iguana Landlord (Utilities Not Included)", "burn", "reptile", ["briefcase", "tie"], "m"),
    E(0, 13, "k", "Kobold on a Wellness Retreat", "chase", "biped", ["leaf", "hood"], "s"),
    E(0, 14, "B", "Bat That Has Seen Things", "flit", "bird", ["glasses"], "s"),
    E(0, 15, "h", "Hippo, Statistically Your Biggest Problem", "chase", "beast", ["glasses"], "l"),
    E(0, 16, "n", "Sloth Assassin, Eventually", "sneak", "beast", ["hood"], "m"),
    E(0, 17, "C", "Crocodile Personal Injury Lawyer", "chase", "reptile", ["tie", "briefcase"], "l"),
    E(0, 18, "e", "Leaf Elemental of Mild Resentment", "chase", "elemental", ["leaf"], "m"),
    E(0, 19, "P", "Poison Dart Influencer", "zap", "biped", ["phone", "bottle"], "m"),
    E(0, 20, "w", "Witch Doctor Without Accreditation", "zap", "caster", ["staff", "hat"], "m"),
    E(0, 21, "A", "Ape Shaman Who Discovered Crypto", "zap", "beast", ["coins"], "m"),
    E(0, 22, "T", "Temple Guardian, Unpaid Intern", "slow", "knight", ["shield"], "l"),
    E(0, 23, "Y", "Jungle Yeti Fleeing Taxes", "chase", "brute", ["coins"], "l"),
    E(0, 24, "Q", "The Termite Queen, Chair of the Board", "boss", "bug", ["crown"], "l"),
  ],
  [ // 1 swamp
    E(1, 0, "r", "Bog Rat With Tenure", "chase", "beast", ["glasses"], "s"),
    E(1, 1, "j", "Sentient Pudding of Uncertain Ethics", "slow", "blob", [], "m"),
    E(1, 2, "x", "Leech, Licensed Debt Collector", "poison", "blob", ["briefcase"], "s"),
    E(1, 3, "f", "Frog Who Does Open Mic Nights", "zap", "reptile", ["mic"], "s"),
    E(1, 4, "s", "Swamp Adder Doing Its Own Taxes", "poison", "serpent", ["clipboard"], "m"),
    E(1, 5, "q", "Mosquito Union Local 404", "flit", "bug", ["clipboard"], "s"),
    E(1, 6, "o", "Ogre Who Wants a Hug, Legally", "chase", "brute", ["briefcase"], "l"),
    E(1, 7, "z", "Bonejangles, Former Mayor", "chase", "skeleton", ["hat", "tie"], "m"),
    E(1, 8, "G", "Alligator Who Only Eats Brunch", "chase", "reptile", ["glasses", "hat"], "l"),
    E(1, 9, "h", "Hag Selling Timeshares", "zap", "caster", ["phone"], "m"),
    E(1, 10, "w", "Will-o'-the-Wisp in Sales", "flit", "ghost", ["fire"], "s"),
    E(1, 11, "M", "Mud Golem Named Gary", "slow", "object", ["clipboard"], "l"),
    E(1, 12, "d", "Drowned Accountant, Still Billing", "chase", "ghost", ["glasses", "clipboard"], "m"),
    E(1, 13, "t", "Bridge Troll Disputing the Zoning", "chase", "brute", ["clipboard"], "l"),
    E(1, 14, "e", "Moss Elemental, Very Slowly Furious", "slow", "elemental", ["leaf"], "m"),
    E(1, 15, "n", "Newt Necromancer (Night Classes)", "zap", "caster", ["book", "hood"], "s"),
    E(1, 16, "c", "Catfish Running Three Profiles", "chase", "fish", ["phone"], "m"),
    E(1, 17, "b", "Bog Witch's Ex-Husband", "sneak", "biped", ["hat", "bottle"], "m"),
    E(1, 18, "l", "Log That Is Not a Log", "root", "object", [], "l"),
    E(1, 19, "g", "Swamp Gas Achieving Self-Awareness", "burn", "elemental", ["halo"], "m"),
    E(1, 20, "u", "Undead Duck With Unfinished Business", "chase", "bird", ["hood"], "s"),
    E(1, 21, "p", "Plague Pigeon Spreading Rumors", "poison", "bird", ["mic"], "s"),
    E(1, 22, "k", "Kraken's Disappointing Nephew", "root", "serpent", ["hood"], "l"),
    E(1, 23, "H", "Hydra in Middle Age (One Head Left)", "chase", "serpent", ["briefcase"], "l"),
    E(1, 24, "K", "Gloopus, Swamp King and Real Estate Developer", "boss", "blob", ["crown", "briefcase"], "l"),
  ],
  [ // 2 castle
    E(2, 0, "z", "Hollow Man Who Lost His Keys and Purpose", "chase", "skeleton", [], "m"),
    E(2, 1, "a", "Sneaky Gary, Assassin (Freelance)", "sneak", "biped", ["hood", "briefcase"], "m"),
    E(2, 2, "k", "Knight of the Mildly Round Table", "chase", "knight", ["shield"], "m"),
    E(2, 3, "r", "Rat Pope", "zap", "beast", ["hat"], "s"),
    E(2, 4, "g", "Gargoyle on Union Break", "root", "brute", ["flail"], "m"),
    E(2, 5, "s", "Skeleton Archer, Paid by the Arrow", "zap", "skeleton", ["bow"], "m"),
    E(2, 6, "m", "Mimic Pretending to Be a Chair", "root", "object", [], "m"),
    E(2, 7, "p", "Possessed Armor, Previous Owner Unknown", "slow", "knight", ["sword"], "m"),
    E(2, 8, "c", "Crossbow Butler", "zap", "biped", ["bow", "tie"], "m"),
    E(2, 9, "G", "Ghost of a Bad Decision", "flit", "ghost", [], "m"),
    E(2, 10, "W", "Wizard Who Forgot Everything but Your Name", "zap", "caster", ["staff", "hat"], "m"),
    E(2, 11, "h", "Halberd Enthusiast at a Party", "chase", "knight", ["sword"], "m"),
    E(2, 12, "b", "Bat Swarm With a Mission Statement", "flit", "bird", ["briefcase"], "s"),
    E(2, 13, "E", "Fire Elemental, Formerly the Kitchen", "burn", "elemental", ["fire"], "m"),
    E(2, 14, "n", "Nun With a Flail and Notes", "chase", "biped", ["flail", "book"], "m"),
    E(2, 15, "j", "Court Jester, Now a Political Commentator", "flit", "biped", ["hat", "mic"], "m"),
    E(2, 16, "v", "Vampire on a Keto Diet", "poison", "biped", ["cape"], "m"),
    E(2, 17, "f", "Fairy Building Inspector", "flit", "imp", ["clipboard", "halo"], "s"),
    E(2, 18, "B", "Big Door Knight", "chase", "knight", ["shield"], "l"),
    E(2, 19, "d", "Dragon Whelp With a Trust Fund", "burn", "dragon", ["coins"], "m"),
    E(2, 20, "l", "Lich Processing Your Paperwork", "zap", "caster", ["clipboard", "hood"], "m"),
    E(2, 21, "C", "Chandelier Holding a Grudge", "root", "object", ["fire"], "m"),
    E(2, 22, "O", "Onion-Shaped Knight, Weeping Openly", "chase", "knight", [], "m"),
    E(2, 23, "S", "Silver Knight Steve", "chase", "knight", ["shield", "sword"], "l"),
    E(2, 24, "K", "The Lord of Lords (Self-Appointed)", "boss", "knight", ["crown", "cape"], "l"),
  ],
  [ // 3 mountain
    E(3, 0, "g", "Mountain Goat of Pure Spite", "chase", "beast", [], "m"),
    E(3, 1, "y", "Yak With a Grievance", "chase", "beast", ["clipboard"], "l"),
    E(3, 2, "e", "Eagle That Steals Hats", "flit", "bird", ["hat"], "m"),
    E(3, 3, "r", "Rockling", "slow", "object", [], "s"),
    E(3, 4, "R", "Rock That Was Faking It", "root", "object", ["glasses"], "m"),
    E(3, 5, "t", "Frost Troll on a Cleanse", "chase", "brute", ["ice", "bottle"], "l"),
    E(3, 6, "w", "Wind Elemental With No Direction", "flit", "elemental", ["cape"], "m"),
    E(3, 7, "i", "Ice Elemental, Emotionally Unavailable", "slow", "elemental", ["ice"], "m"),
    E(3, 8, "E", "Earth Elemental, Very Grounded", "slow", "elemental", ["leaf"], "l"),
    E(3, 9, "F", "Fire Elemental Who Took a Wrong Turn", "burn", "elemental", ["fire", "glasses"], "m"),
    E(3, 10, "h", "Hermit Who Moved Here to Avoid You", "zap", "biped", ["hood", "staff"], "m"),
    E(3, 11, "d", "Dwarf Miner Who Struck Nothing", "chase", "biped", ["hat"], "s"),
    E(3, 12, "D", "Avalanche Drake", "burn", "dragon", ["ice"], "l"),
    E(3, 13, "b", "Snowball Gremlin", "zap", "imp", ["ice"], "s"),
    E(3, 14, "c", "Cave Bear Woken Before Its Alarm", "chase", "beast", [], "l"),
    E(3, 15, "Y", "Abominable Snowman (Socially)", "chase", "brute", ["tie"], "l"),
    E(3, 16, "s", "Storm Sprite", "zap", "imp", ["halo"], "s"),
    E(3, 17, "G", "Giant Who Doesn't Look Down", "slow", "brute", ["glasses"], "l"),
    E(3, 18, "o", "Ogre Mage With a Masterclass", "zap", "caster", ["staff", "book"], "l"),
    E(3, 19, "f", "Frost Fairy", "flit", "imp", ["ice"], "s"),
    E(3, 20, "a", "Avalanche Assassin", "sneak", "biped", ["hood", "ice"], "m"),
    E(3, 21, "m", "Monk of the Thousand Slaps", "chase", "biped", ["hood"], "m"),
    E(3, 22, "p", "Peak Phantom", "sneak", "ghost", ["cape"], "m"),
    E(3, 23, "T", "Toenail of a Sleeping Titan", "slow", "object", [], "l"),
    E(3, 24, "K", "Glacierbutt, Wyrm Who Was Promised a Pension", "boss", "dragon", ["ice", "coins"], "l"),
  ],
  [ // 4 desert
    E(4, 0, "r", "Desert Rat With a Get-Rich Scheme", "chase", "beast", ["coins"], "s"),
    E(4, 1, "l", "Lizard Doing Hot Yoga", "flit", "reptile", ["leaf"], "s"),
    E(4, 2, "v", "Vulture Waiting Patiently", "flit", "bird", [], "m"),
    E(4, 3, "s", "Sidewinder in Commercial Real Estate", "poison", "serpent", ["briefcase", "tie"], "m"),
    E(4, 4, "z", "Skeleton Who Died Waiting for a Refund", "chase", "skeleton", ["coins"], "m"),
    E(4, 5, "c", "Coyote Middleman", "sneak", "beast", ["briefcase"], "m"),
    E(4, 6, "j", "Jackal Influencer", "chase", "beast", ["phone"], "m"),
    E(4, 7, "b", "Scarab Rolling Its Life Savings", "slow", "bug", ["coins"], "s"),
    E(4, 8, "m", "Mirage With Opinions", "flit", "elemental", ["glasses"], "m"),
    E(4, 9, "k", "Skeleton Archer, Retired and Bored", "zap", "skeleton", ["bow"], "m"),
    E(4, 10, "d", "Dust Devil", "flit", "elemental", [], "m"),
    E(4, 11, "n", "Nomad Selling Bottled Air", "zap", "biped", ["bottle", "hood"], "m"),
    E(4, 12, "u", "Mummy With Unresolved Grievances", "slow", "skeleton", ["cape"], "m"),
    E(4, 13, "x", "Skeleton Legion, Cohort of One", "chase", "skeleton", ["sword"], "m"),
    E(4, 14, "S", "Big Scorpion. Very Big.", "poison", "bug", [], "l"),
    E(4, 15, "p", "Priest of a Sun God Nobody Calls", "zap", "caster", ["halo", "staff"], "m"),
    E(4, 16, "a", "Asp Accountant", "poison", "serpent", ["glasses", "clipboard"], "m"),
    E(4, 17, "w", "Sandworm With Abandonment Issues", "sneak", "serpent", [], "l"),
    E(4, 18, "g", "Golem of Sun-Baked Brick", "slow", "object", [], "l"),
    E(4, 19, "e", "Sand Elemental, Grainy", "chase", "elemental", [], "m"),
    E(4, 20, "G", "Ghoul From the HOA", "chase", "ghost", ["clipboard"], "m"),
    E(4, 21, "h", "Sphinx Who Asks Gotcha Questions", "zap", "beast", ["glasses", "crown"], "l"),
    E(4, 22, "M", "Pharaoh's Middle Manager", "chase", "biped", ["tie", "clipboard"], "m"),
    E(4, 23, "T", "Tomb Guard Bound by a Noncompete", "chase", "knight", ["shield", "clipboard"], "m"),
    E(4, 24, "K", "Pharaoh Ramset the Unaudited", "boss", "skeleton", ["crown"], "l"),
  ],
];

/** Deep-water sharks (classic, verbatim). Glyph Λ, behaviour "swim". */
export const SHARKS = ["Shark Who Smelled Your Ambition", "Great White-Collar Shark", "Hammerhead in Middle Management", "Loan Shark (Literal)", "Tiger Shark With Nothing to Lose"]
  .map((name, t) => ({ id: "shark-" + t, b: -1, t, ch: "Λ", name, ai: "swim", arch: "shark", acc: [], size: "m" }));

/** Named rare spawns (EverQuest "nameds"). Written by the art director — keep verbatim.
 *  base = tier whose stats/sprite it upgrades. Rules: game/monsters.js (ARCHITECTURE §9.3). Sprite id: enemy/<id>
 *  (art/creatures.js draws the base creature at 1.25x with a gold trim unless a PNG is dropped in). */
export const RARES = [
  { id: "rare-jungle-0", b: 0, base: 3, name: "Regional Manager Kevin, Apex Mosquito", ai: "flit", arch: "bug", acc: ["tie", "briefcase"], size: "l" },
  { id: "rare-jungle-1", b: 0, base: 7, name: "Old Deductible, the Jaguar Nobody Covers", ai: "sneak", arch: "beast", acc: ["briefcase"], size: "l" },
  { id: "rare-swamp-0", b: 1, base: 2, name: "The Mother of All Leeches (Collections Dept.)", ai: "poison", arch: "blob", acc: ["briefcase", "phone"], size: "l" },
  { id: "rare-swamp-1", b: 1, base: 11, name: "Gary's Dad, a Larger Mud Golem", ai: "slow", arch: "object", acc: ["tie"], size: "l" },
  { id: "rare-castle-0", b: 2, base: 2, name: "Sir Reginald, Knight of the Unreturned Deposit", ai: "chase", arch: "knight", acc: ["shield", "crown"], size: "l" },
  { id: "rare-castle-1", b: 2, base: 20, name: "The Notary, Whose Seal Is Final", ai: "zap", arch: "caster", acc: ["clipboard", "hat"], size: "l" },
  { id: "rare-mountain-0", b: 3, base: 0, name: "Greg, the Goat the Other Goats Warn You About", ai: "chase", arch: "beast", acc: ["hat"], size: "l" },
  { id: "rare-mountain-1", b: 3, base: 21, name: "Auditor of the Thousand Slaps", ai: "chase", arch: "biped", acc: ["clipboard", "tie"], size: "l" },
  { id: "rare-desert-0", b: 4, base: 14, name: "Sandra. Also a Scorpion. Bigger.", ai: "poison", arch: "bug", acc: ["glasses"], size: "l" },
  { id: "rare-desert-1", b: 4, base: 21, name: "Timeshare Sphinx, Presenting Until You Sign", ai: "zap", arch: "beast", acc: ["briefcase", "glasses"], size: "l" },
];

/** Every enemy record, flat (125 + 5 sharks). Rares are separate. */
export const ALL_ENEMIES = BEAST.flat().concat(SHARKS);
const BY_ID = new Map(ALL_ENEMIES.map(e => [e.id, e]));
for (const r of RARES) BY_ID.set(r.id, { ...BEAST[r.b][r.base], ...r, t: r.base, rare: true });
/** Look up an enemy (or rare) record by id ("jungle-00", "shark-2", "rare-swamp-1"). */
export const enemyById = id => BY_ID.get(id) || null;
/** All sprite ids the art pipeline must cover. */
export const ENEMY_IDS = ALL_ENEMIES.map(e => "enemy/" + e.id).concat(RARES.map(r => "enemy/" + r.id));
