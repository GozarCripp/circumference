// data/flavor.js — ARCHITECT-OWNED. Shared flavour text. Classic lines are VERBATIM from classic/index.html;
// new lines were written by the art director to lock the voice:
//   Douglas Adams deadpan (the universe is vast, indifferent and slightly bureaucratic) +
//   Tim Dillon satire (grifts, landlords, wellness, paperwork). Dry, specific, never "lol random", never winking.
// Rule of thumb for anyone adding text elsewhere: state something absurd as a plain administrative fact, then stop.

// ---- classic, verbatim -------------------------------------------------------------------
export const HITS = ['hit', 'strike', 'wallop', 'introduce your weapon to', 'have a firm conversation with', 'apply blunt force to'];
export const DEATHS = ['ceases to be', 'dies, which it had been meaning to avoid', 'is removed from the economy', 'goes to its reward, which is nothing', 'expires, like a coupon', 'dies with remarkably little dignity'];
export const TIPS = [
  'Nobody is coming.', 'The planet is round. This has consequences.', 'Dog armor is, legally, a dog.',
  'Pyramids go up. So do prices.', 'Sharks do not care about your feelings, or your armor.',
  'You own nothing. You remember less. Welcome.', "Every boss was somebody's middle manager once.",
  // new for the 2.5D build
  'Consider an enemy before you fight it. It has not extended you the same courtesy.',
  'Night falls every day. Nobody has been able to get this fixed.',
  'A campfire is a house with fewer walls and no landlord.',
  'Insurance is available. Coverage is a separate matter.',
  'Scrolls teach spells. Reading is, regrettably, still required.',
  'Double-tap open ground to walk there. Everything else requires your written consent.',
];
export const INTRO = 'You wake face-down in a jungle, naked, owning nothing and remembering less. Nobody is coming to help. This is, broadly, the human condition. (Tap anything.)';

// ---- consider (EverQuest-style "con"), index 0 = trivial … 5 = lethal. Colours: config.CON / .con0-.con5 -------
// Entries 1, 3 and 5 keep the classic threat lines as their opening words.
export const CON_TEXT = [
  'Poses no threat. Fighting it would be closer to an eviction.',
  'Looks easy. Most things do, from here.',
  'You hold the advantage, which is not the same as a guarantee.',
  'Fair fight. Nobody involved wanted one of those.',
  'Quite a gamble, and the house is the other guy.',
  'This will end in tears. Yours.',
];

// ---- zones: "The <adj> <noun>" picked deterministically per 64x64 zone cell, by biome key ------------------------
export const HOME_ZONE = 'The Onboarding Glade';
export const ZONE_ADJ = {
  jungle: ['Greater', 'Lesser', 'Upper', 'Unincorporated', 'Overgrown', 'Humid', 'Pre-Approved', 'Gated', 'Unzoned', 'Sustainably Sourced'],
  swamp: ['Lower', 'Stagnant', 'Sunken', 'Refinanced', 'Probationary', 'Greater', 'Lesser', 'Disputed', 'Tidal', 'Uninsurable'],
  castle: ['Old', 'Outer', 'Condemned', 'Hereditary', 'Foreclosed', 'Historic', 'Inner', 'Abandoned', 'Listed', 'Contested'],
  mountain: ['High', 'Bleak', 'Windward', 'Unclimbed', 'Tax-Exempt', 'Frozen', 'Upper', 'Leeward', 'Remote', 'Thin-Aired'],
  desert: ['Great', 'Empty', 'Sun-Bleached', 'Subdivided', 'Unaudited', 'Shifting', 'Outer', 'Lesser', 'Blistering', 'Rezoned'],
};
export const ZONE_NOUN = {
  jungle: ['Deductible Jungle', 'Canopy of Mild Regret', 'Understory', 'Fern Belt', 'Vine Easement', 'Wellness Thicket', 'Monkey District', 'Mosquito Preserve', 'Green Annex', 'Tangle'],
  swamp: ['Escrow Marsh', 'Fen of Good Standing', 'Liability Bog', 'Timeshare Mire', 'Slough', 'Wetland Opportunity Zone', 'Backwater', 'Sump', 'Quagmire of Record', 'Drainage Dispute'],
  castle: ['Ruins of Lordship', 'Keep of Deferred Maintenance', 'Bailey', 'Halls of Precedent', 'Court of Small Claims', 'Ramparts', 'Gatehouse Estates', 'Battlements', 'Throne Annex', 'Crumbling Commons'],
  mountain: ['Pension Peaks', 'Summit of Diminishing Oxygen', 'Scree Fields', 'Glacier of Record', 'Hermitage', 'Goat Commons', 'Icefall', 'Pass of Last Resort', 'Cold Shoulder', 'Heights'],
  desert: ['Sands of Speculation', 'Dune Sea', 'Refund Wastes', 'Pyramid Scheme', 'Flats', 'Salt Pan of Regret', 'Mirage Estates', 'Caravan Route (Closed)', 'Barrens', 'Oasis (Under Offer)'],
};
export const ZONE_ENTER = zone => `You have entered ${zone}.`;
export const FAR_LINE = 'You are now as far from home as it is possible to be. It looks a lot like everywhere else.'; // classic

// ---- day and night ----------------------------------------------------------------------
export const DAY_LINES = {
  dusk: 'The sun begins to set. It will be back; it has nowhere else to be.',
  night: 'Night. Your eyes, never your best feature, give up early.',
  dawn: 'Dawn. The planet has completed another rotation without consulting you.',
};

// ---- camp ---------------------------------------------------------------------------------
export const CAMP = {
  make: 'You make camp. It is technically a home, in that nobody has evicted you from it yet.',
  noRoom: 'There is nowhere to put a fire. The universe has declined your request for housing.',
  danger: 'You cannot make camp with something actively trying to kill you. Zoning.',
  indoors: 'You cannot make camp inside a tomb. The previous tenant is still on the lease.',
  rest: 'You rest by the fire. For a moment, nothing is being asked of you.',
  rested: 'Fully rested. The universe remains indifferent.', // classic
  lost: 'Your camp, left unattended, is presumably now a rental.',
};

// ---- death ---------------------------------------------------------------------------------
export const EPITAPHS = [
  'Your ghost files a complaint. It is ignored.', // classic
  'Your estate consists of the clothes you were not wearing.',
  'The planet continues to be round without you.',
  'A memorial service was considered and then not held.',
  "Your remains are now somebody else's loot table.",
  'Cause of death: participation.',
  'You are survived by your debts, which are doing well.',
];
export const UNINSURED = 'You died uninsured. It said so on the box.';
/** Claim results when a policy was in force. {killer} is replaced with the killer's name. */
export const DENIALS = [
  'Claim denied. Death is a pre-existing condition.',
  'Claim denied. The policy covers acts of God. This was an act of {killer}.',
  'Claim denied. You were out of network. The network is a single building on another planet.',
  'Claim denied. Form 27-B was not filed in triplicate.',
  'Claim denied. Your deductible exceeds the assessed value of your life. We did assess it.',
];
export const CLAIM_APPROVED = 'Claim approved, to the visible surprise of everyone involved. You are restored to life, less the deductible, which is everything you own in cash.';
