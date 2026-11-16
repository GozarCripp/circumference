// data/folk.js — OWNED BY: world-life (builder D). Ambient folk: the people who live on the planet without wanting
// anything from you, or wanting only a little, or wanting everything but being polite about it.
// Behaviour lives in game/life.js (keyed by `kind`); this file is text and tuning only.
//
// Shape: { kind, title, names[], look, w (spawn weight), roam (leash radius in tiles; 0 = drifts freely),
//          greet[], barks[], ...kind-specific lines }
// Substitutions: {name} {cost} {k} {dir} {dist} {site} {quip} {kind} {color} {mon} {d} {far} {n} {tax}
// Voice: Douglas Adams deadpan + Tim Dillon satire. State something absurd as a plain administrative fact, then stop.

export const FOLK = [
  // ---------------------------------------------------------------------------------------------------------------
  { kind: 'merchant', title: 'Travelling Apothecary', look: 'folk-merchant', w: 4, roam: 6,
    names: ['Osric Vell', 'Madame Thessaly Prunk', 'Barnaby Ooze', 'Hollis Quaint', 'Ferdinand Gloam'],
    greet: [
      'Potions. Unlabelled, as the regulations require, there being no regulations.',
      'Every bottle is guaranteed to do something. I am not, at this time, in a position to say what.',
      'Step closer. Not that close. I sell remedies; I do not provide them.',
      'I buy wholesale from a man who buys wholesale from a hole in the ground. You are getting a fair price.',
    ],
    browse: 'These are the bottles. The colours are the colours. The prices are firm, like my belief in them.',
    bought: [
      'A pleasure. No refunds. I will be several miles away by the time it matters.',
      'Excellent choice. They were all the same choice, but excellent.',
      'Drink it in good health, or in bad health; it will change one of those.',
      'Sold. I would tell you what it does, but that is a separate service, with a separate fee.',
    ],
    poor: 'You are {k} gold short. I extend credit to no one, including myself.',
    soldout: 'Sold out. I restock when the planet comes round again, which it does, constantly.',
    noStock: 'My supplier is in a dispute with his hole in the ground. Nothing to sell. Come back in a later version of reality.',
    appraiseAsk: 'For {cost} gold I will tell you what one of your bottles is. I can tell by the smell. Also by the label I put on the crate.',
    appraised: 'That {color} one? That is {kind}. You are welcome, and also you have paid.',
    appraiseNone: 'Everything you carry is already known to you. A rare condition. Treasure it.',
    kinds: {
      heal: 'a healing draught. It closes wounds and opens wallets',
      tele: 'a teleport. It moves you somewhere at random, without consulting you, like a landlord',
      nuke: 'a small, portable apocalypse. Do not drink it near anything you like, including yourself',
      poison: 'poison. Some people throw it. Some people drink it. Only one of those groups learns anything',
    },
    barks: [
      '{name} rattles a crate of bottles at you, meaningfully.',
      '{name} calls out: "Potions! Potions of unknown provenance!"',
      '{name} holds a bottle up to the light, frowns, and puts it back for someone else.',
    ] },

  // ---------------------------------------------------------------------------------------------------------------
  { kind: 'gossip', title: 'Rumour-Monger', look: 'folk-gossip', w: 4, roam: 5,
    names: ['Mildred Ash', 'Old Nan Teague', 'Corvin Whisper', 'Delphine of No Fixed Address', 'Auntie Vex'],
    greet: [
      'I do not spread rumours. I curate them.',
      'You look like someone who has not heard. Sit. Do not sit, there is nowhere to sit. Listen.',
      'Everything I tell you is true somewhere. I will not say where. That is the one thing I will not say.',
    ],
    site: [
      'There is a place {dir}, maybe {dist} paces off. {site}. {quip}',
      'They say {site} is {dir} of here, about {dist} paces. {quip}',
      'Go {dir}, roughly {dist} paces, and you will find {site}. {quip} You did not hear it from me. You heard it from me.',
    ],
    quips: [
      'Damp, overgrown, and something in there has been promoted well beyond its ability.',
      'Built on a bog by people who were told it was a lake view.',
      'Old money. Very old. Most of it is still down there with the owners.',
      'Cold, high, and run by somebody who thinks altitude is a personality.',
      'Sand on the outside. Worse on the inside. Bring water, or regret.',
    ],
    quipAny: 'Nobody who went in has written a review. Draw your own conclusions; I have drawn several.',
    entered: 'Although I hear you have already been in. People talk. I am the people.',
    noSite: 'Nothing worth the walk within a day of here. It is the quiet places you want to worry about. Not this one. Generally.',
    more: [
      'The sharks are unionising. Nobody knows what they want. More sharks, I expect.',
      'Brenda from Onboarding has onboarded four hundred people. None of them have ever been offboarded. Think about that, and then stop.',
      'There is a man selling potions who does not know what is in them. He is the honest one.',
      'Somebody walked all the way round the planet once. He came back exactly where he started and was furious about it.',
      'The pyramids were built by a firm that went into administration halfway up. That is why they get smaller.',
      'Night is getting longer. It is not, actually. But you will feel it is, now, and that is my gift to you.',
      'The insurance man has paid out once. They still talk about it at the office. There is a plaque.',
      'A dragon in the mountains is writing a memoir. Early reviews are mostly screaming.',
    ],
    barks: [
      '{name} leans in as you pass: "You did not hear this from me."',
      '{name} is telling a tree something it did not want to know.',
      '{name} catches your eye with the look of someone who knows where the bodies are, approximately.',
    ] },

  // ---------------------------------------------------------------------------------------------------------------
  { kind: 'pilgrim', title: 'Pilgrim of the Long Way Round', look: 'folk-pilgrim', w: 3, roam: 0,
    names: ['Brother Anselm', 'Sister Wend', 'Pilgrim Gorm', 'Mother Ilse', 'Deacon Abernethy'],
    greet: [
      'We are walking around the planet to arrive where we started. It is the only destination with good reviews.',
      'Peace be upon you, in the reasonable quantities available.',
      'Every step brings us closer. Also further. It is a round planet; we have made our peace with that.',
    ],
    whither: 'Here. The long way round. We set off from this very spot some years ago and expect to arrive any decade now.',
    bless: 'You walk with them a while. Nobody says anything useful. You feel, against all evidence, better.',
    blessFull: 'You are already whole. The pilgrims find this suspicious and walk slightly faster.',
    blessed: 'You have had your blessing. There is one per customer. We are not, despite appearances, a charity.',
    barks: [
      '{name} walks past at the exact pace of someone with nowhere to be for forty years.',
      '{name} murmurs: "Closer. Further. Closer."',
      '{name} nods at you the way you nod at someone going the same way round.',
    ] },

  // ---------------------------------------------------------------------------------------------------------------
  { kind: 'tourist', title: 'Lost Tourist', look: 'folk-tourist', w: 3, roam: 9,
    names: ['Gunther, On Holiday', 'Pam and Also Doug', 'Yusuf, Day Tripper', 'Mrs. Abernathy-Klee', 'Bjorn With the Bum Bag'],
    greet: [
      'Excuse me, is this the scenic route? The leaflet said there would be a gift shop.',
      'We booked the all-inclusive. Nothing has been included. Is it far to the included bit?',
      'I have a map, but it is of somewhere else. Is that a problem here? It was a problem there.',
    ],
    directions: 'You point somewhere with total confidence. They thank you warmly and walk into a fern. They tip you {n} gold, which is the custom where they are from, which is not here.',
    tipped: 'They have already been helped by you, and it went as well as helping ever goes. They are taking photos of a rock now.',
    home: 'Home? Where people like you come from? There is a glade {dir}, about {dist} paces. Everyone over there was naked and confused. We assumed it was a resort.',
    atHome: 'You are standing more or less where you started. We have been here all week. It is not as nice as the brochure.',
    barks: [
      '{name} is photographing a puddle from several angles.',
      '{name} asks a passing beetle for directions, then writes down what it says.',
      '{name}: "Is this the bit with the views? Every bit has views. That is the problem."',
    ] },

  // ---------------------------------------------------------------------------------------------------------------
  { kind: 'mlm', title: 'Independent Wellness Ambassador', look: 'folk-mlm', w: 3, roam: 7,
    names: ['Kaylee Sunderland', 'Destinee Brook', 'Chad Prosper', 'Tammy-Lynn Vance', 'Brecken Hustle'],
    greet: [
      'Hey hun! Quick question: do you want to be your own boss? You would report to me, but spiritually you would be your own boss.',
      'Have you ever thought about financial freedom? I think about it constantly. It is all I think about. Help.',
      'I am not selling anything. I am inviting you into a family. The family sells things.',
    ],
    pitch: 'It is simple. You buy a starter kit for {cost} gold. Then you sell starter kits to two friends, and they sell to two friends, and eventually everyone on the planet owes everyone else a starter kit. The planet is small. We are nearly there.',
    kit: 'Your starter kit contains one (1) bottle of Essence. Results vary. Mostly downward. Welcome to the family; there is no leaving the family.',
    poor: 'You are {k} gold short of financial freedom. That is the closest anyone has ever been.',
    upline: 'Above me? Destiny. Above her, a man called Royce who lives on a boat. Above Royce, nobody has looked. It is upline all the way up.',
    noStock: 'We are out of starter kits. Corporate says this proves demand.',
    barks: [
      '{name} waves at you with the energy of someone forty gold into a quarterly target.',
      '{name}: "Hey! Long time! We have never met! Do you have a minute for an opportunity?"',
      '{name} is explaining a pyramid to a tree. The tree has no money, which makes it the smartest one here.',
    ] },

  // ---------------------------------------------------------------------------------------------------------------
  { kind: 'surveyor', title: 'Surveyor, Bureau of Roundness', look: 'folk-surveyor', w: 3, roam: 8,
    names: ['Ingram Pole', 'Theodora Plumb', 'Mr. Level', 'Assistant Surveyor Fitch', 'Cornelius Datum'],
    greet: [
      'I am measuring the planet. It is round. I have been asked to keep checking.',
      'Do not step there. That is where I have put zero. Everything else is measured from it, at public expense.',
      'The Bureau is confident the planet is round. We are less confident it is finished.',
    ],
    distance: 'You are {d} paces from where you woke up, as the crow flies, if any crow could be bothered. The far side of the planet begins at about {far}. {farNote}',
    farYes: 'You have already been to the far side. It is in my records. It looked like this.',
    farNo: 'You have not been there yet. Few people go. It is like here, but further.',
    surveyAsk: 'I can let you see my survey of the surrounding area for {cost} gold. It is accurate to within one or two monsters.',
    surveyed: 'The surveyor unrolls the survey. The surrounding countryside appears on your map, pre-explored, as though you had already been there and had not enjoyed it.',
    poor: 'Surveys are {cost} gold. You have {k} gold fewer than that. I have measured it.',
    barks: [
      '{name} plants a pole, squints at it, and writes down "still round".',
      '{name} measures the distance between you and a tree, and seems disappointed in both.',
      '{name}: "Mind the datum, please."',
    ] },

  // ---------------------------------------------------------------------------------------------------------------
  { kind: 'hermit', title: 'Hermit (Do Not Disturb)', look: 'folk-hermit', w: 2, roam: 3,
    names: ['Old Thaddeus', 'The Man Called Weatherby', 'Agnes of the Rock', 'Hermit Number Four', 'Silent Ruth'],
    greet: [
      'I moved here to get away from people. You are people. Sit, if you must. Quietly.',
      'Forty years alone on this rock. I recommend it. Do not do it near me.',
      'You may ask me one thing. You may not ask me a second thing. That was your one thing.',
    ],
    sit: 'You sit with the hermit. Neither of you says anything. Nothing is asked of you. For the first time in this life, you are not behind on anything.',
    sitFull: 'You sit. You were already fine. The hermit glares at you for wasting good silence.',
    sat: 'You have had your silence. The hermit is rationing it. There is only so much left on this planet.',
    wisdom: [
      'Everything that chases you wants something. Everything that ignores you wants something more.',
      'Water is deep where it is dark. So are most people. Neither is worth the swim.',
      'Never fight anything with a title. A title means it survived a meeting.',
      'A campfire heals. A home heals. A job does not, whatever they tell you at orientation.',
      'Throw what you would not drink. Drink what you would not throw. Figure out which is which by drinking.',
      'The far side of the planet is the near side of somebody else. Do not go there to find yourself; somebody else lives there.',
    ],
    barks: [
      '{name} sees you coming and closes their eyes, which is as close as a rock gets to a door.',
      '{name} mutters: "Not you. Not anyone. Particularly not you."',
      '{name} is not talking to you. It is going well.',
    ] },

  // ---------------------------------------------------------------------------------------------------------------
  { kind: 'flat', title: 'Missionary, Church of the Flat Planet', look: 'folk-flat', w: 2, roam: 8,
    names: ['Elder Pruitt', 'Elder Wexley', 'Brother Dunstable', 'Sister Calloway', 'Elder Ambrose Plane'],
    greet: [
      'Good day. Have you considered that the planet is flat, and that you have been lied to by people with globes?',
      'We are going door to door. There are no doors. That proves nothing, and we will not be drawn on it.',
      'May I leave some literature? It is printed on one side only, as a matter of doctrine.',
    ],
    pamphlet: 'You are handed a pamphlet titled "{t}". It has a diagram. The diagram is, unavoidably, flat.',
    pamphlets: ['The Edge Is Nearer Than You Think', 'Who Profits From Roundness?', 'Horizons: A Hoax in Three Parts', 'You Walked Around It? Prove It', 'The Gravity Lobby'],
    argue: 'You point out that you can walk all the way round. The missionary points out that you have not. You walk away having won an argument, which changes nothing, and learn something about patience.',
    argued: 'Your argument has been heard. A counter-argument has been prepared a counter-argument. It is a second pamphlet.',
    barks: [
      '{name} knocks politely on a tree.',
      '{name}: "Ask yourself: why does the horizon curve? Because they want you to think it does."',
      '{name} offers you a pamphlet from a respectful, doctrinally flat distance.',
    ] },

  // ---------------------------------------------------------------------------------------------------------------
  { kind: 'influencer', title: 'Wellness Influencer, Filming', look: 'folk-influencer', w: 2, roam: 6,
    names: ['Saffron Glow', 'Brayden Peak', 'Juniper Lux', 'Mackenzie Root', 'Odessa Vibe'],
    greet: [
      'Hi! Sorry, I am mid-content. This is my morning routine. It is the afternoon. It is a lot of work.',
      'I am naked and remember nothing, too! But mine is a lifestyle. Yours is just what happened.',
      'Can you not stand there? You are ruining the authenticity. Stand over there. Look authentic.',
    ],
    cameo: 'You stand in the background looking feral. It tests extremely well. You are paid {n} gold for the usage rights, in perpetuity, throughout the universe.',
    cameoDone: 'You are already in the content. You will be in it forever. That is what forever is now.',
    smoothie: 'It is moss, sand, and a crushed beetle. It is anti-inflammatory. Everything is, if you say it in the right voice.',
    barks: [
      '{name} films themselves eating a leaf: "Day ninety of eating what is near me."',
      '{name}: "Use my code. There is no code. The code is a feeling."',
      '{name} is narrating a sunrise. It is the middle of the day. Nobody corrects them.',
    ] },

  // ---------------------------------------------------------------------------------------------------------------
  { kind: 'ghost', title: 'Ghost of a Previous Adventurer', look: 'folk-ghost', w: 2, roam: 4,
    names: ['The Late Gerald', 'Former Hero Pell', 'Spectre of Middle Management', 'Ghost of Someone Very Like You', 'Wisp Formerly Known as Dale'],
    greet: [
      'I was you once. Not like you. You. Same planet, same lack of trousers. Learn from me.',
      'Do not worry, I am not here to haunt you. Haunting is a full-time job, and I am between jobs.',
      'Death is not the end. It is mostly forms.',
    ],
    cause: 'How did I die? Something called {mon}, {dir} of here, about {dist} paces. It is still there. It has my boots.',
    causeNone: 'Old age. On this planet that means about thirty. There is nothing near here that will do it to you today, which is not the same as a promise.',
    after: [
      'The afterlife is a waiting room. The magazines are about you. They are not flattering.',
      'There is a light at the end of the tunnel. It is a vending machine. It takes exact change.',
      'You get your memories back when you die. All of them. It is a lot, and none of it is useful now.',
    ],
    barks: [
      '{name} drifts past and says, without turning: "Not that way. Or that way. Fine, any way."',
      '{name} moans, then apologises: "Force of habit."',
      '{name} hovers near you with the air of a predecessor reviewing your work.',
    ] },

  // ---------------------------------------------------------------------------------------------------------------
  { kind: 'busker', title: 'Busker With One Song', look: 'folk-busker', w: 2, roam: 4,
    names: ['Wally Fret', 'Lark Tenpenny', 'Duncan on Kazoo', 'Pip Strummond', 'Rhoda Bellows'],
    greet: [
      'Requests welcome. I know one song. I will play it as though it were your request.',
      'This one is about a man who lost everything. It is called "Track One". It is also track two.',
      'I am not begging. I am performing. The hat is part of the costume, and it accepts gold.',
    ],
    song: 'The busker plays the one song. It is so persistent that your feet decide, independently, to be somewhere else, quickly.',
    poor: 'A song is {cost} gold. You are {k} short. The song is played anyway, quietly, at you, as a warning.',
    stop: 'You ask them to stop. They stop. The silence is worse, and everyone knows it.',
    barks: [
      '{name} is playing the song. It is the same one. It was always going to be.',
      '{name} tips their hat at you. The hat is empty and would like you to notice.',
      '{name}: "This next one goes out to anyone being chased by something."',
    ] },

  // ---------------------------------------------------------------------------------------------------------------
  { kind: 'coach', title: 'Life Coach (Between Clients)', look: 'folk-coach', w: 2, roam: 6,
    names: ['Trent Ascend', 'Coach Marla', 'Dr. Vance Impact (Not That Kind of Doctor)', 'Skyler Momentum', 'Gwendolyn Thrive'],
    greet: [
      'You look stuck. Not physically. Physically you look terrible. But also stuck.',
      'I help people unlock their potential. Yours is behind several doors, most of them load-bearing.',
      'Every setback is a setup for a comeback. Every comeback is billed by the hour.',
    ],
    session: 'Forty minutes of affirmations later, you feel motivated against your will. Your Motivation Points are full. The invoice is also full.',
    noMp: 'You do not have any Motivation Points. In the industry, we call that a baseline. Come back when you have something to lose.',
    fullMp: 'You are fully motivated. Frankly it is a little much. No charge; I do not take clients who are already fine.',
    poor: 'A session is {cost} gold. You are {k} short. That is your first lesson. The lesson is also {cost} gold.',
    barks: [
      '{name}: "What is your why? Mine is gold."',
      '{name} is giving a pep talk to a stump. The stump is making real progress.',
      '{name} points at you and says "You. Yes. You," and then nothing else, which was the whole session.',
    ] },

  // ---------------------------------------------------------------------------------------------------------------
  { kind: 'courier', title: 'Courier, Parcel for "Occupant"', look: 'folk-courier', w: 2, roam: 9,
    names: ['Dex From Dispatch', 'Rosalind Express', 'Courier Seven', 'Harold, Who Was Told There Would Be Roads', 'Mags Overnight'],
    greet: [
      'Parcel for "Occupant". Are you an occupant? You occupy that spot. That is good enough for the system.',
      'I have been trying to deliver this for three weeks. There are no addresses. There are barely places.',
      'Sign here. Or do not. Nobody has ever checked.',
    ],
    parcelGold: 'You open the parcel. It contains {n} gold and a note that reads "As discussed." Nothing was discussed.',
    parcelPot: 'You open the parcel. It contains a bottle and a packing slip that says "Fragile (Emotionally)".',
    delivered: 'Your parcel has been delivered. Please rate your delivery experience. You cannot. There is no way to do that.',
    barks: [
      '{name} checks a list, looks at you, and says "Occupant?" hopefully.',
      '{name} is leaving a "Sorry We Missed You" card on a boulder.',
      '{name}: "Signature required. Anyone\'s."',
    ] },

  // ---------------------------------------------------------------------------------------------------------------
  { kind: 'assessor', title: 'Tax Assessor, Planetary Revenue', look: 'folk-assessor', w: 2, roam: 7,
    names: ['Assessor Grimsby', 'Ms. Ledger-Hart', 'Deputy Assessor Nunn', 'Mr. Withholding', 'Audrey Arrears'],
    greet: [
      'Planetary Revenue. Do not be alarmed. Be the correct amount of alarmed, which I will now calculate.',
      'Everyone pays their fair share. I decide what fair is. I am very fair. Ask anyone who is still solvent.',
      'You have not filed a return. You have not filed anything. You have not, as far as we can tell, existed until recently.',
    ],
    assess: 'Your assessment is {tax} gold: ten percent of everything you carry, plus a rounding fee, rounded up, in our favour.',
    nothing: 'You have no gold. You are exempt. Congratulations; poverty is the only loophole we have never closed.',
    paid: 'Paid in full. Something is stamped. You feel the warm, specific glow of compliance, which is worth something, roughly experience.',
    dispute: 'You dispute the assessment. The assessor sighs and files your appeal under "Pending", which is a drawer with no bottom. You owe nothing today. You will owe it later, with feeling.',
    done: 'You are paid up for this life. We will see you in the next one. We always do.',
    barks: [
      '{name} looks at your gold, then at a clipboard, then at your gold.',
      '{name}: "Nice planet. Be a shame if it were reassessed."',
      '{name} is auditing a squirrel. The squirrel has been hiding nuts in seven jurisdictions.',
    ] },
];

/** kind -> definition. */
export const FOLK_BY = Object.fromEntries(FOLK.map(f => [f.kind, f]));

/** Spawn tuning (cheap on purpose: phones first). */
export const FOLK_TUNE = {
  cap: 12,            // ambient folk alive at once
  chunkOdds: 0.11,    // chance a freshly populated 16-tile chunk gets one
  minGap: 10,         // no two folk spawn within this many tiles of each other
  forget: 80,         // forgotten beyond this many tiles (like monsters)
  wanderR: 20,        // only folk within this many tiles of the hero wander
  wanderOdds: 3,      // 1-in-N chance per turn that a nearby folk takes a step
  barkR: 3,           // bark range (Chebyshev)
  barkGap: 30,        // turns between any two barks
  barkEach: 160,      // turns before the same person barks again
};

/** Shared lines used by game/life.js. */
export const FOLK_LINES = {
  bye: 'Goodbye',
  busy: 'They have nothing more to say to you, which is the most honest thing anyone has said all day.',
  meet: 'You have met {name}, {title}.',
};
