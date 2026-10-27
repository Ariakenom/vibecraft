"use strict";
const WASM_B64 = "/*WASM_BASE64*/";

// ===========================================================================
// Constants shared with the Rust side
const ENT_STRIDE = 18;
const PROJ_STRIDE = 10; // x, y, px, py, loosed from x, y, shooter kind, at a building, target x, y
const TILE = 32; // pixels per tile in the baked terrain texture
const SIM_MS = 50;
// Units are kinds 0–63, buildings 64 and up (defs.rs).
const K = { Worker: 0, Spearman: 1, Archer: 2, Horseman: 3, Swordsman: 5, Crossbowman: 6, Knight: 7, Trebuchet: 8, Musketeer: 9, Dragoon: 10, Cannon: 11, Rifleman: 12, MachineGunner: 13, FieldGun: 14, Infantry: 15, Tank: 16, Fighter: 17, Bomber: 18, RocketArtillery: 19, Jet: 20,
  Capitol: 64, Barracks: 65, Range: 66, Stable: 67, Tower: 68, Farm: 69,
  LumberCamp: 70, Quarry: 71, FishingHut: 72, HuntingLodge: 73, Orchard: 74, Pasture: 75, Hut: 77,
  Cottage: 78, SheepFarm: 79, IronMine: 80, Brickworks: 81, Bakery: 82, Weaver: 83, Brewery: 84, SiegeWorkshop: 85,
  Townhouse: 86, SaltpeterWorks: 87, PowderMill: 88, Carpenter: 89, Printer: 90, Circus: 91,
  Tenement: 92, CoalMine: 93, SteelMill: 94, ExplosivesWorks: 95, Cannery: 96, CoalYard: 97, Press: 98, Factory: 99,
  Apartment: 100, OilWell: 101, BauxiteMine: 102, PowerPlant: 103, HaberBosch: 104, RadioFactory: 105, TankWorks: 106, Airfield: 107,
  TowerBlock: 108, UraniumMine: 109, Reactor: 110, CarPlant: 111, TvPlant: 112, MissileSilo: 113,
  Sawmill: 114, Stoneworks: 115, AirDefense: 116, Kiln: 117 };
// Aircraft fly above everything (drawn high up; see defs.rs Kind::is_air).
const isAir = k => k === K.Fighter || k === K.Bomber || k === K.Jet;
// Mounted units: a horse under them (sounds, drawing).
const isMounted = k => k === K.Horseman || k === K.Knight || k === K.Dragoon;
// Firearms: a bang and a puff of smoke instead of the twang of a bow.
const isGun = k => k === K.AirDefense || k === K.Musketeer || k === K.Dragoon || k === K.Cannon || k === K.Rifleman || k === K.MachineGunner || k === K.FieldGun ||
  k === K.Infantry || k === K.Tank || k === K.Fighter || k === K.Jet || k === K.RocketArtillery;
// Big guns: a boom, a big puff, a shell you can see.
const isBigGun = k => k === K.AirDefense || k === K.Cannon || k === K.FieldGun || k === K.Tank || k === K.RocketArtillery;
const isBld = k => k >= 64;
const NAMES = { [K.Worker]: "Worker", [K.Hut]: "Hut", [K.Spearman]: "Spearman", [K.Archer]: "Archer", [K.Horseman]: "Horseman", [K.Capitol]: "Capitol", [K.Barracks]: "Barracks",
  [K.Range]: "Archery Range", [K.Stable]: "Stable", [K.Tower]: "Watch Tower", [K.Farm]: "Farm", [K.LumberCamp]: "Lumber Camp", [K.Quarry]: "Quarry",
  [K.FishingHut]: "Fishing Hut", [K.HuntingLodge]: "Hunting Lodge", [K.Orchard]: "Orchard", [K.Pasture]: "Pasture",
  [K.Swordsman]: "Swordsman", [K.Crossbowman]: "Crossbowman", [K.Knight]: "Knight", [K.Trebuchet]: "Trebuchet",
  [K.Cottage]: "Cottage", [K.SheepFarm]: "Sheep Farm", [K.IronMine]: "Iron Mine", [K.Brickworks]: "Brickworks", [K.Bakery]: "Bakery",
  [K.Weaver]: "Weaver", [K.Brewery]: "Brewery", [K.SiegeWorkshop]: "Siege Workshop",
  [K.Musketeer]: "Musketeer", [K.Dragoon]: "Dragoon", [K.Cannon]: "Cannon",
  [K.Townhouse]: "Townhouse", [K.SaltpeterWorks]: "Saltpeter Works", [K.PowderMill]: "Powder Mill", [K.Carpenter]: "Carpenter",
  [K.Printer]: "Printer", [K.Circus]: "Circus",
  [K.Rifleman]: "Rifleman", [K.MachineGunner]: "Machine Gunner", [K.FieldGun]: "Field Gun",
  [K.Tenement]: "Tenement", [K.CoalMine]: "Coal Mine", [K.SteelMill]: "Steel Mill", [K.ExplosivesWorks]: "Explosives Works",
  [K.Cannery]: "Cannery", [K.CoalYard]: "Coal Yard", [K.Press]: "Press", [K.Factory]: "Factory",
  [K.Infantry]: "Infantry", [K.Tank]: "Tank", [K.Fighter]: "Fighter", [K.Bomber]: "Bomber",
  [K.Apartment]: "Apartment Block", [K.OilWell]: "Oil Well", [K.BauxiteMine]: "Bauxite Mine", [K.PowerPlant]: "Power Plant",
  [K.HaberBosch]: "Haber–Bosch Plant", [K.RadioFactory]: "Radio Factory", [K.TankWorks]: "Tank Works", [K.Airfield]: "Airfield",
  [K.RocketArtillery]: "Rocket Artillery", [K.Jet]: "Jet", [K.TowerBlock]: "Tower Block", [K.UraniumMine]: "Uranium Mine",
  [K.Reactor]: "Reactor", [K.CarPlant]: "Car Plant", [K.TvPlant]: "TV Plant", [K.MissileSilo]: "Missile Silo",
  [K.Sawmill]: "Sawmill", [K.Stoneworks]: "Stone Works", [K.Kiln]: "Kiln", [K.AirDefense]: "Air Defense" };
const DESC = {
  [K.Worker]: "Works at producers, builds (and then works at what they built, if it needs a crew), or waits in the town square. Free workers go where they're needed by themselves; training a soldier turns one into the soldier.",
  [K.Hut]: "A home. It gets 2 beds for each different food it receives, up to 3 kinds (6 people). Full, with all 3, you can upgrade it to a Cottage (1 more wood and 1 stone). Bigger houses get 3 beds for each good past the third.",
  [K.Cottage]: "A bigger home, grown from a full hut with 3 goods. It can use up to 5 goods, Medieval ones too (12 people). Ten cottages bring the Medieval era. Full, with 5 goods, you can upgrade it to a Townhouse from the Medieval era (1 more stone and 2 brick).",
  [K.Townhouse]: "A brick townhouse, grown from a full cottage with 5 goods. It uses up to 7 goods, Gunpowder ones too (18 people). Ten bring the Gunpowder era. Full, with 7 goods, you can upgrade it to a Tenement from the Gunpowder era (2 more brick).",
  [K.Tenement]: "A tall tenement block, grown from a full townhouse with 7 goods. It uses up to 9 goods, Industrial ones too (24 people). Ten bring the Industrial era. Full, with 9 goods, you can upgrade it to an Apartment Block from the Industrial era (2 steel).",
  [K.Apartment]: "A modern apartment block, grown from a full tenement with 9 goods. It uses up to 11 goods, electricity and radios too (30 people). Ten bring the Modern era. Full, with 11 goods, you can upgrade it to a Tower Block from the Modern era (1 more steel and 1 aluminum).",
  [K.TowerBlock]: "A high-rise, grown from a full apartment block with 11 goods. It uses up to 13 goods, cars and TVs too (36 people). Ten bring the Atomic era.",
  [K.Spearman]: "Sturdy infantry. Deals heavy damage to horsemen.",
  [K.Swordsman]: "Armoured infantry. Like spearmen, deadly to riders, but tougher and harder-hitting. Costs iron.",
  [K.Crossbowman]: "Shoots further and harder than an archer. Strong against infantry, weak against riders. Costs iron.",
  [K.Knight]: "Heavy cavalry in iron. Runs down archers and crossbowmen.",
  [K.Trebuchet]: "A slow siege engine with a long reach. Smashes buildings; poor against people, so guard it.",
  [K.Musketeer]: "Line infantry with muskets: shoots, and its bayonet keeps riders off. Costs iron and gunpowder.",
  [K.Dragoon]: "Fast riders who shoot from the saddle. Run down archers and crossbowmen. Costs horses and gunpowder.",
  [K.Cannon]: "Outranges every tower and trebuchet, and brings walls down. Slow, and poor against people.",
  [K.Rifleman]: "Line infantry with a rifle: long reach, steady fire, and keeps riders off. Costs steel and gunpowder.",
  [K.MachineGunner]: "Sprays fire at infantry. Strong against foot soldiers, weak against riders. Costs steel and two gunpowder.",
  [K.FieldGun]: "Horse-drawn artillery firing shells. The longest reach of all; flattens buildings. Costs steel, explosives and a horse.",
  [K.Infantry]: "Modern foot soldiers with automatic rifles. They can shoot at aircraft too. Costs steel and explosives.",
  [K.Tank]: "Armour: tough, fast and hard-hitting, it runs down guns and gunners. Infantry beat it. Costs steel, oil and explosives.",
  [K.Fighter]: "Flies over everything. Shoots down aircraft, and strafes the ground a little. Costs aluminum and oil.",
  [K.Bomber]: "Flies over everything and bombs buildings to rubble. Can't hit aircraft: escort it with fighters. Costs aluminum, oil and explosives.",
  [K.RocketArtillery]: "Fires salvoes of rockets from further than anything else can shoot. Flattens buildings; poor against people.",
  [K.Jet]: "A faster, tougher fighter. Owns the air. Costs aluminum and oil.",
  [K.Archer]: "Fires from range. Strong against foot soldiers, weak against riders.",
  [K.Horseman]: "Fast cavalry. Runs down archers.",
  [K.Capitol]: "Your seat of power: it makes a little wood, stone, grain and fruit by itself, and shoots at enemies. It has 4 beds of its own. From the Medieval era you can found more (8 wood, 8 stone, 6 brick, 4 builders); you're out only when the last one falls.",
  [K.Barracks]: "Trains spearmen; swordsmen, musketeers, riflemen and infantry as the eras come.",
  [K.Range]: "Trains archers; crossbowmen from the Medieval era and machine gunners from the Industrial.",
  [K.Stable]: "Trains horsemen and knights, and dragoons from the Gunpowder era.",
  [K.Tower]: "Shoots at enemies in range.",
  [K.Farm]: "Grows grain anywhere on open ground.",
  [K.LumberCamp]: "Cuts wood from a forest next to it. Costs nothing. For more, a Sawmill from the Medieval era.",
  [K.Quarry]: "Cuts stone from rock next to it. For more, a Stone Works from the Gunpowder era.",
  [K.FishingHut]: "Catches fish from the water next to it.",
  [K.HuntingLodge]: "Hunts the game grazing next to it.",
  [K.Orchard]: "Picks fruit from the wild bushes next to it.",
  [K.Pasture]: "Breeds horses from the wild herd next to it.",
  [K.SheepFarm]: "Raises sheep for wool on the hills next to it.",
  [K.IronMine]: "Digs iron from the ore next to it. Iron arms the Medieval army.",
  [K.Brickworks]: "Fires bricks from the clay next to it. Needs no wood. For more, a Kiln from the Gunpowder era.",
  [K.Bakery]: "Bakes bread from grain. It holds its grain while it stands, working or not.",
  [K.Weaver]: "Weaves clothes from wool. It holds its wool while it stands, working or not.",
  [K.Brewery]: "Brews beer from grain. It holds its grain while it stands, working or not.",
  [K.SiegeWorkshop]: "Builds trebuchets, and cannon from the Gunpowder era.",
  [K.SaltpeterWorks]: "Scrapes nitrate from the saltpeter crusts next to it.",
  [K.PowderMill]: "Grinds nitrate and wood into gunpowder, for muskets, dragoons and cannon.",
  [K.Carpenter]: "Makes furniture from wood, for townhouses.",
  [K.Printer]: "Prints books (on paper made from wood), for townhouses.",
  [K.Circus]: "Puts on shows for four houses. Costly, and it holds two horses while it stands.",
  [K.CoalMine]: "Digs coal from the seam next to it.",
  [K.SteelMill]: "Makes steel from iron and coal. Steel builds tenements, factories and the modern army.",
  [K.ExplosivesWorks]: "Makes explosives from nitrate and coal: shells for field guns.",
  [K.Cannery]: "Cans fish and meat: canned food for tenements.",
  [K.CoalYard]: "Sells coal for heating, for tenements.",
  [K.Press]: "Prints newspapers, for tenements.",
  [K.Factory]: "Builds field guns, and rocket artillery from the Atomic era.",
  [K.OilWell]: "Pumps oil from the oil field next to it.",
  [K.BauxiteMine]: "Mines bauxite next to it and smelts it into aluminum.",
  [K.PowerPlant]: "Burns coal to make electricity, for apartment blocks, radio factories and the Haber–Bosch plant.",
  [K.HaberBosch]: "Makes nitrate from coal and electricity: no saltpeter needed.",
  [K.RadioFactory]: "Makes radios from steel and electricity, for apartment blocks.",
  [K.TankWorks]: "Builds tanks.",
  [K.Airfield]: "Builds fighters, bombers and, from the Atomic era, jets.",
  [K.UraniumMine]: "Mines uranium from the ore next to it.",
  [K.Reactor]: "Makes a great deal of electricity from a little uranium.",
  [K.CarPlant]: "Makes cars from steel and oil, for tower blocks.",
  [K.TvPlant]: "Makes TVs from aluminum and electricity, for tower blocks.",
  [K.Sawmill]: "Saws wood in bulk from a forest next to it: as much as two lumber camps, with two workers. Needs no wood to build.",
  [K.Stoneworks]: "Cuts stone in bulk from rock next to it: more than two quarries, with two workers.",
  [K.Kiln]: "Fires bricks in bulk from the clay next to it: more than three brickworks, with two workers. Needs no wood.",
  [K.AirDefense]: "A surface-to-air missile battery. Every 5 seconds it fires a missile that brings down any aircraft in one hit, out to 10 tiles. It shoots down any nuke falling within 10 tiles of it, then needs 90 seconds to reload. It can't hit anything on the ground.",
  [K.MissileSilo]: "Arms a nuke (2 uranium and 2 explosives, held until it's launched; 2 minutes), then launches it anywhere on the map. Everyone sees it coming, and is told when a silo is built and when it starts arming: 20 seconds after launch everything within 15 tiles of where it lands is destroyed, and a crater stays. An enemy Air Defense near the target shoots it down.",
};
// The six eras, and the house each brings. Which kinds and resources
// belong to which era comes from Rust (kind_era, res_era); so do the
// requirements (Kind::requires) and the era a player has reached.
const ERA_NAMES = ["Ancient", "Medieval", "Gunpowder", "Industrial", "Modern", "Atomic"];
const HOUSE_NAMES = ["Hut", "Cottage", "Townhouse", "Tenement", "Apartment", "Tower block"];
// Resources, in the order of `enum Res` in defs.rs.
const RES_NAMES = ["wood", "stone", "grain", "fish", "meat", "fruit", "horses", "wool", "iron", "brick", "bread", "clothes", "beer", "nitrate",
  "gunpowder", "furniture", "books", "circus shows", "coal", "steel", "explosives", "canned food", "heating", "newspapers", "electricity", "oil",
  "aluminum", "radios", "uranium", "cars", "TVs"];
const R = { wood: 0, stone: 1, grain: 2, fish: 3, meat: 4, fruit: 5, horses: 6 };
// What an extractor has to stand next to, in the order of `enum Dep`.
const DEP_NAMES = ["wild fruit bushes", "a forest", "rock", "wild horses", "game", "water", "iron ore", "clay", "sheep hills", "saltpeter", "a coal seam", "an oil field", "bauxite", "uranium ore"];
const ORDER_TEXT = ["Idle", "Moving", "Attack-moving", "Fighting", "", "", "On the way to build", "Working", "On the way to enlist"];
// Player colours: 0 is nature, then blue, red, green, gold.
const PCOL = ["#999", "#3f86e0", "#d2452f", "#3fae5a", "#e0b23a"];
const PDARK = ["#555", "#1f4f8f", "#7f2216", "#1f6b33", "#8c6a12"];
const PLIGHT = ["#bbb", "#8cb9f0", "#ec8a77", "#86d69a", "#f2d27f"];
const PNAME = ["Nature", "Blue", "Red", "Green", "Gold"];
// The names people pick for themselves (kept in the browser), and this
// game's: slot -> name, for the seats people play. A seat without one (the
// computer's, or someone who didn't pick a name) goes by its colour.
const NAME_KEY = "vibecraft.name";
const cleanName = s => typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f<>&"'`]/g, "").replace(/\s+/g, " ").trim().slice(0, 16) : "";
// Until you pick one, you're a famous name from history (kept, like a picked one).
const RANDOM_NAMES = ["Hannibal", "Boudica", "Cleopatra", "Ashoka", "Leonidas", "Hypatia", "Saladin", "Tomyris", "Charlemagne", "Theodora", "Ramesses", "Sargon", "Hammurabi", "Pericles", "Zenobia", "Attila", "Alaric", "Cnut", "Harald", "Birger Jarl", "Gustav Vasa", "Kristina", "Isabella", "Pachacuti", "Mansa Musa", "Sundiata", "Nzinga", "Wu Zetian", "Akbar", "Suleiman", "Babur", "Cyrus", "Darius", "Nefertiti", "Trajan", "Hatshepsut", "Ragnar", "Eleanor", "Justinian", "Tamar", "Carthage", "Babylon", "Uruk", "Thebes", "Knossos", "Byzantium", "Samarkand", "Timbuktu", "Cuzco", "Tenochtitlan", "Kyoto", "Luoyang", "Uppsala", "Birka", "Visby", "Novgorod", "Venice", "Cordoba", "Aachen", "Antioch", "Petra", "Palmyra", "Persepolis", "Nineveh", "Angkor", "Axum", "Great Zimbabwe", "Ur", "Sparta", "Corinth", "Syracuse", "Alexandria", "Memphis", "Kish", "Mycenae", "Pataliputra"];
const randomName = (not = "") => { const l = RANDOM_NAMES.filter(n => n !== not); return l[Math.floor(Math.random() * l.length)]; };
let myName = "";
try { myName = cleanName(localStorage.getItem(NAME_KEY) || ""); } catch { /* storage blocked */ }
if (!myName) { myName = randomName(); try { localStorage.setItem(NAME_KEY, myName); } catch { /* storage blocked */ } }
const pnames = {};
const pn = p => pnames[p] || PNAME[p];                                        // in tables and labels
const pnc = p => pnames[p] ? `${pnames[p]} (${PNAME[p]})` : PNAME[p] || "";   // in sentences: who, and which colour
// Replace this game's names (from the host, a snapshot, a replay).
function setNames(o) {
  for (const k of Object.keys(pnames)) delete pnames[k];
  if (o && typeof o === "object") for (let p = 1; p <= 4; p++) { const n = cleanName(o[p]); if (n) pnames[p] = n; }
}
// The build menu has a page per era: Tab goes to the next page, Shift+Tab
// back. Each page hands out the same hotkeys in order (`PAGE_KEYS`, which
// avoid W, A, S and D, the camera keys). Buildings in tech-tree order:
const BUILD_ORDER = [K.Hut, K.Farm, K.LumberCamp, K.Quarry, K.FishingHut, K.HuntingLodge, K.Orchard, K.Pasture, K.Barracks, K.Range, K.Stable, K.Tower,
  K.Sawmill, K.SheepFarm, K.Weaver, K.IronMine, K.Brickworks, K.Bakery, K.Brewery, K.SiegeWorkshop, K.Capitol,
  K.Stoneworks, K.Kiln, K.SaltpeterWorks, K.PowderMill, K.Carpenter, K.Printer, K.Circus,
  K.CoalMine, K.SteelMill, K.ExplosivesWorks, K.Cannery, K.CoalYard, K.Press, K.Factory,
  K.OilWell, K.BauxiteMine, K.PowerPlant, K.HaberBosch, K.RadioFactory, K.TankWorks, K.Airfield, K.AirDefense,
  K.UraniumMine, K.Reactor, K.CarPlant, K.TvPlant, K.MissileSilo];
const PAGE_KEYS = "QERTFGCVBYUIOJLN"; // the left hand's keys first (Y is a stretch)
// Every building (for code that wants them all; keys are per page).
const BUILD_MENU = BUILD_ORDER.map(k => [k, ""]);
let buildPage = 0;
// The eras with a page: those reached, and the next once its first house stands.
function buildPages() {
  if (W.cheat()) return [0, 1, 2, 3, 4, 5]; // cheat mode: every era's buildings
  const last = Math.min(W.era_progress(2), W.era() + (W.era_progress(0) > 0 ? 1 : 0));
  return Array.from({ length: last + 1 }, (_, e) => e);
}
function buildMenu() {
  const pages = buildPages();
  buildPage = Math.min(buildPage, pages.length - 1);
  const ks = BUILD_ORDER.filter(k => W.kind_era(k) === buildPage);
  return ks.map((k, n) => [k, PAGE_KEYS[n] || ""]);
}
const TRAIN_KEYS = PAGE_KEYS; // enough for every unit when several kinds of building are selected
const TRAINS = { [K.Barracks]: [K.Spearman, K.Swordsman, K.Musketeer, K.Rifleman, K.Infantry], [K.Range]: [K.Archer, K.Crossbowman, K.MachineGunner],
  [K.Stable]: [K.Horseman, K.Knight, K.Dragoon], [K.SiegeWorkshop]: [K.Trebuchet, K.Cannon], [K.Factory]: [K.FieldGun, K.RocketArtillery],
  [K.TankWorks]: [K.Tank], [K.Airfield]: [K.Fighter, K.Bomber, K.Jet] };

// Small icons for the resources. Later eras' resources get a lettered disc until they have their own.
const RES_ICON = [
  '<svg viewBox="0 0 16 16"><rect x="1.5" y="5" width="11" height="6.5" rx="1" fill="#8a5a33"/><ellipse cx="12.5" cy="8.25" rx="2.2" ry="3.25" fill="#c8995f"/><ellipse cx="12.5" cy="8.25" rx="1" ry="1.5" fill="#8a5a33"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M2 12l2-6 4-3 5 2 1 6-4 3H5z" fill="#9b958a"/><path d="M4 6l4-3 5 2-4 2z" fill="#c7c2b8"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M8 15V5" stroke="#b58f3c" stroke-width="1.3"/><g fill="#e2bd5a"><ellipse cx="8" cy="3" rx="1.3" ry="2.2"/><ellipse cx="6" cy="6" rx="1.2" ry="2" transform="rotate(-30 6 6)"/><ellipse cx="10" cy="6" rx="1.2" ry="2" transform="rotate(30 10 6)"/><ellipse cx="6.2" cy="9.4" rx="1.2" ry="2" transform="rotate(-30 6.2 9.4)"/><ellipse cx="9.8" cy="9.4" rx="1.2" ry="2" transform="rotate(30 9.8 9.4)"/></g></svg>',
  '<svg viewBox="0 0 16 16"><path d="M2 8c2.5-3.5 7-3.5 9.5 0-2.5 3.5-7 3.5-9.5 0z" fill="#7fa6bf"/><path d="M11 8l3.5-3v6z" fill="#5f87a0"/><circle cx="5" cy="7.3" r=".8" fill="#1d2a33"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M3 9c0-3.5 3-6 6.5-5.5S14 8 12.5 11 6 14 4.2 12.3C3.4 11.6 3 10.4 3 9z" fill="#b8473a"/><path d="M9 7.5c1.2 0 2 .8 2 1.8s-.8 1.7-2 1.7-2-.7-2-1.7.8-1.8 2-1.8z" fill="#ead2b5"/><path d="M2.5 13.5l2-2" stroke="#ead2b5" stroke-width="1.6" stroke-linecap="round"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M8 4.2c2.6-1.6 6 .2 6 4 0 3.4-2.7 6.6-6 6.6S2 11.6 2 8.2c0-3.8 3.4-5.6 6-4z" fill="#c9473a"/><path d="M8 4.5C8 2.8 9 1.6 10.6 1.2" stroke="#6fa046" stroke-width="1.5" fill="none"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M4 14l.6-5.5C3.5 7 3.6 4.6 5.5 3.3L7 1.5l.6 2c2.6.3 5.1 2.4 6 5.4l-1.7.8-2.2-1.4-.2 5.7z" fill="#8a5a33"/><path d="M7 1.5l.6 2-1.2 2.6-1.5-1.3z" fill="#3b2618"/><circle cx="9.6" cy="5.6" r=".7" fill="#1d1208"/></svg>',
  // wool, iron, brick, bread, clothes, beer
  '<svg viewBox="0 0 16 16"><g fill="#ece6d6"><circle cx="5" cy="9" r="3.2"/><circle cx="9" cy="7" r="3.4"/><circle cx="11" cy="10.5" r="3"/><circle cx="7" cy="11.5" r="2.8"/></g><path d="M6 9.5c1.5-1 3-1 4.5 0" stroke="#c9bfa8" fill="none"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M2 11l3-5h9l-3 5z" fill="#6f7680"/><path d="M2 11h9v2.5H2z" fill="#4c525a"/><path d="M11 11l3-5v2.5l-3 5z" fill="#5b6169"/><path d="M5.5 7h6" stroke="#a7aeb7" stroke-width=".8"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M1.5 6.5h13v6h-13z" fill="#a8452e"/><path d="M1.5 6.5l2-2.5h13l-2 2.5z" fill="#c8664a"/><path d="M14.5 6.5l2-2.5v6l-2 2.5z" fill="#86331f"/><path d="M1.5 9.5h13M6 6.5v3M10 9.5v3" stroke="#e2b7a2" stroke-width=".6"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M2 10c0-3.6 2.7-6 6-6s6 2.4 6 6v1.5H2z" fill="#d9a25a"/><path d="M5 6.5l1 1.5M8 5.5v2M11 6.5l-1 1.5" stroke="#9c6a2e" stroke-width="1" stroke-linecap="round"/><path d="M2 11.5h12v1.5H2z" fill="#b07c3c"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M5 2l3 1.5L11 2l3.5 3-2 2.2-1-.7V14h-7V6.5l-1 .7-2-2.2z" fill="#4f7aa8"/><path d="M6 2.5c.5 1.3 1.2 2 2 2s1.5-.7 2-2" stroke="#2f5379" fill="none"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M3.5 4h8v10h-8z" fill="#d79b2a"/><path d="M3 3c0-1.4 1.5-2 4.5-2S12 1.6 12 3v1.5H3z" fill="#f4ecd8"/><path d="M11.5 6h1.8c.9 0 1.2.6 1.2 1.3v3.4c0 .7-.4 1.3-1.2 1.3h-1.8" stroke="#b07a1d" stroke-width="1.2" fill="none"/></svg>',
  // nitrate, gunpowder, furniture, books, circus shows
  '<svg viewBox="0 0 16 16"><path d="M1.5 13l2.5-5 3 2 2.5-5 3 4 2 4z" fill="#e8e4d6"/><path d="M4 8l3 2 2.5-5" stroke="#b9b2a0" fill="none"/><circle cx="11" cy="11" r="1" fill="#cfc8b6"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M4 3h8l1 2v8.5c0 .8-.7 1.5-1.5 1.5h-7C3.7 15 3 14.3 3 13.5V5z" fill="#3b3a37"/><path d="M5 1.5h6V3H5z" fill="#6b5a44"/><path d="M5.5 8h5v4h-5z" fill="#d8c8a4"/><path d="M7 9.5h2" stroke="#3b3a37"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M3 3h10v6H3z" fill="#9a6a3c"/><path d="M2 9h12v2.5H2z" fill="#7d5631"/><path d="M3 11.5h1.5V15H3zM11.5 11.5H13V15h-1.5z" fill="#5e3f22"/><path d="M4.5 4.5h7v3h-7z" fill="#b9854e"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M2 3.5c2-1 4-1 6 .5v10c-2-1.5-4-1.5-6-.5z" fill="#8a3a2a"/><path d="M14 3.5c-2-1-4-1-6 .5v10c2-1.5 4-1.5 6-.5z" fill="#a8452e"/><path d="M3 5c1.5-.6 3-.6 4.2.4M3 7c1.5-.6 3-.6 4.2.4" stroke="#e9d9b8" stroke-width=".6" fill="none"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M8 1l6.5 6H1.5z" fill="#c8453a"/><path d="M8 1l3 6H5z" fill="#efe6d1"/><path d="M2.5 7h11v7h-11z" fill="#e8d9b0"/><path d="M6.5 14v-4c0-1 .7-1.5 1.5-1.5s1.5.5 1.5 1.5v4z" fill="#3a2c20"/><path d="M8 1V0" stroke="#d2a33a"/></svg>',
  // coal, steel, explosives, canned food, heating, newspapers
  '<svg viewBox="0 0 16 16"><path d="M2 12l2-5 4-2 3 2 3 4-2 3H4z" fill="#26262a"/><path d="M4 7l4-2 3 2-3 1.5z" fill="#4a4a52"/><path d="M9 10l2-1" stroke="#5c5c66"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M1.5 10h13v3.5h-13z" fill="#5b6470"/><path d="M1.5 10l2-3h13l-2 3z" fill="#9aa4b2"/><path d="M14.5 10l2-3v3.5l-2 3z" fill="#47505b"/><path d="M4 8.5h8" stroke="#d3dae2" stroke-width=".7"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M5 4h6v10.5H5z" fill="#c8453a"/><path d="M5 6.5h6M5 12h6" stroke="#f0e2b8" stroke-width=".8"/><path d="M8 4V2.5c0-.8 1-1.4 2-1" stroke="#7a6a50" fill="none"/><path d="M10.5 1.2l1 .5-.6.8z" fill="#f4c542"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M3.5 4.5h9v9.5h-9z" fill="#b9c2cc"/><ellipse cx="8" cy="4.5" rx="4.5" ry="1.4" fill="#dfe5eb"/><path d="M3.5 7.5h9v4h-9z" fill="#c8453a"/><path d="M6 9.5h4" stroke="#f0e2b8"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M8 14.5c-3 0-4.5-2-4.5-4.3 0-2.6 2.2-3.7 2.6-6.7 1.4 1 2 2.4 1.9 3.6.9-.6 1.4-1.6 1.4-2.8 2 1.6 3.1 3.6 3.1 5.9 0 2.3-1.5 4.3-4.5 4.3z" fill="#e8742c"/><path d="M8 14.5c-1.4 0-2.2-1-2.2-2.2 0-1.4 1.2-2.2 1.5-3.6.8.7 1 1.5 1 2.1.6-.3.9-.9 1-1.6 1 .9 1.1 1.9 1.1 3.1 0 1.2-.8 2.2-2.4 2.2z" fill="#f6c84a"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M2 3h10.5v11H3.5C2.7 14 2 13.3 2 12.5z" fill="#ece6d6"/><path d="M12.5 5H14v7.5c0 .8-.7 1.5-1.5 1.5z" fill="#c9c2b0"/><path d="M3.5 4.5h7.5v2.5H3.5z" fill="#3a3a3a"/><path d="M3.5 8.5h3.5M3.5 10h3.5M3.5 11.5h3.5M8 8.5h3M8 10h3M8 11.5h3" stroke="#8a8478" stroke-width=".7"/></svg>',
  // electricity, oil, aluminum, radios
  '<svg viewBox="0 0 16 16"><path d="M9.5 1L3 9h4.5L6 15l7-8.5H8.5z" fill="#f4c542" stroke="#b8862a" stroke-width=".6"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M8 1.5C6 5 3.5 7.5 3.5 10.3a4.5 4.5 0 0 0 9 0C12.5 7.5 10 5 8 1.5z" fill="#1e1e22"/><path d="M6 10.5c0 1.3.8 2.2 2 2.4" stroke="#5c5c66" fill="none"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M2 10.5l3-5h9l-3 5z" fill="#d7dde4"/><path d="M2 10.5h9V13H2z" fill="#a9b2bd"/><path d="M11 10.5l3-5V8l-3 5z" fill="#8a939e"/><path d="M5.5 7h7" stroke="#f4f7fa" stroke-width=".7"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M2 5.5h12v8.5H2z" fill="#8a5a33"/><path d="M3.5 7h5.5v5.5H3.5z" fill="#3a2c20"/><path d="M4 8h4.5M4 9.3h4.5M4 10.6h4.5M4 11.9h4.5" stroke="#6b5a44" stroke-width=".5"/><circle cx="11.5" cy="8.5" r="1.1" fill="#d8c8a4"/><circle cx="11.5" cy="11.5" r="1.1" fill="#d8c8a4"/><path d="M4 5.5l7-4" stroke="#5b6169"/></svg>',
  // uranium, cars, TVs
  '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="#2a2c20"/><circle cx="8" cy="8" r="1.4" fill="#9ed14a"/><path d="M8 6.2L5.6 2.1A6.5 6.5 0 0 1 10.4 2.1zM9.6 8.9l4.5.1a6.5 6.5 0 0 1-2.4 4.2zM6.4 8.9l-2.1 4.3A6.5 6.5 0 0 1 1.9 9z" fill="#9ed14a"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M1.5 11V8.5l2.5-.5 2-3h5l2.5 3H15v3z" fill="#c8453a"/><path d="M6.5 5.7h4l1.7 2.3H5z" fill="#9fc3d6"/><circle cx="4.5" cy="11.5" r="1.7" fill="#2a2a2a"/><circle cx="11.5" cy="11.5" r="1.7" fill="#2a2a2a"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M1.5 4h13v9h-13z" fill="#5b4a3a"/><path d="M3 5.5h8v6H3z" fill="#9fc3d6"/><circle cx="12.7" cy="7" r=".9" fill="#d8c8a4"/><circle cx="12.7" cy="10" r=".9" fill="#d8c8a4"/><path d="M5 4L3.5 1.5M11 4l1.5-2.5" stroke="#3e4146"/></svg>',
];
const resIcon = r => RES_ICON[r] || `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="#6d6455"/><text x="8" y="11" text-anchor="middle" font-size="8" fill="#efe6d1" font-family="sans-serif">${RES_NAMES[r][0].toUpperCase()}</text></svg>`;

// ===========================================================================
// Mouse cursors, drawn as tiny SVGs. Each shows what a right-click will do.
// Lines are drawn twice, dark and wide then light and narrow, so they read
// on any ground.
const svgCursor = (body, hx, hy) =>
  `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${body}</svg>`)}") ${hx} ${hy}, auto`;
const DK = "#1a140c", HANDLE = `<path d="M{a}" stroke="${DK}" stroke-width="5" stroke-linecap="round"/><path d="M{a}" stroke="#8a5a33" stroke-width="2.6" stroke-linecap="round"/>`;
const handle = d => HANDLE.replaceAll("{a}", d);
const CURSORS = {
  // 1 move: an arrow with a green target ring
  1: svgCursor(`<path d="M3 2v20l5.5-5 3.5 8 3-1.4-3.4-7.6H19z" fill="#fff" stroke="${DK}" stroke-width="1.6" stroke-linejoin="round"/>
    <circle cx="24" cy="25" r="5" fill="none" stroke="${DK}" stroke-width="4"/><circle cx="24" cy="25" r="5" fill="none" stroke="#7be864" stroke-width="2"/>`, 3, 2),
  // 2 attack: a sword
  2: svgCursor(`<path d="M2 2l5 1 15 15-4 4L3 7z" fill="#e3e6ea" stroke="${DK}" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M15 25l10-10" stroke="${DK}" stroke-width="6" stroke-linecap="round"/><path d="M15 25l10-10" stroke="#b5321f" stroke-width="3" stroke-linecap="round"/>
    ${handle("21 21l6 6")}<circle cx="28" cy="28" r="2.6" fill="#b5321f" stroke="${DK}" stroke-width="1.4"/>`, 2, 2),
  // 4 build: a hammer
  4: svgCursor(`${handle("13 13l14 14")}<path d="M3 10l7-7 9 9-7 7z" fill="#9da3ab" stroke="${DK}" stroke-width="1.6" stroke-linejoin="round"/>`, 6, 6),
  // 5 rally point: a flag
  5: svgCursor(`<path d="M6 30V3" stroke="${DK}" stroke-width="4" stroke-linecap="round"/><path d="M6 30V3" stroke="#d9c9a8" stroke-width="2"/>
    <path d="M7 4l17 5-17 6z" fill="#3f86e0" stroke="${DK}" stroke-width="1.6" stroke-linejoin="round"/>`, 6, 30),
};

CURSORS[6] = CURSORS[4]; // 6: send workers to work at a producer

// ===========================================================================
// Boot the WebAssembly module
let W, mem;
async function loadWasm() {
  const bin = Uint8Array.from(atob(WASM_B64), c => c.charCodeAt(0));
  const { instance } = await WebAssembly.instantiate(bin, {});
  W = instance.exports;
  mem = W.memory;
}
// Views must be re-created after wasm memory grows, so always get fresh ones.
const f32 = (ptr, n) => new Float32Array(mem.buffer, ptr, n);
const u8 = (ptr, n) => new Uint8Array(mem.buffer, ptr, n);

// ===========================================================================
// DOM
const $ = id => document.getElementById(id);
const view = $("view");
const over = $("over"), octx = over.getContext("2d"); // 2D overlay: health bars, drag box
const mini = $("mini"), mctx = mini.getContext("2d");
const stage = $("stage");

let MW = 80, MH = 80;
let terrainCanvas, terrainSmall, fogCanvas, fogCtx, fogImg;
let difficulty = 1, seed = 1;
// The camera looks at map point (x, y) from `dist` away, tilted down by `pitch`,
// turned by `yaw` (middle-drag rotates).
let cam = { x: 40, y: 40, dist: 24, pitch: 0.95, yaw: 0 };
let paused = false, speed = 1, running = false;
let acc = 0, last = performance.now(), simTime = 0;
let ents = new Float32Array(0), entCount = 0;
// Entity id -> its row in `ents` this frame. Like a Map, but emptying it is
// just bumping `gen` (a Map's clear() makes garbage every frame).
const byId = {
  row: new Int32Array(1024), stamp: new Int32Array(1024), gen: 1,
  reset() { this.gen++; },
  set(id, i) {
    if (id >= this.row.length) {
      const n = Math.max(id + 1, this.row.length * 2), row = new Int32Array(n), stamp = new Int32Array(n);
      row.set(this.row); stamp.set(this.stamp); this.row = row; this.stamp = stamp;
    }
    this.row[id] = i; this.stamp[id] = this.gen;
  },
  get(id) { return id >= 0 && id < this.row.length && this.stamp[id] === this.gen ? this.row[id] : undefined; },
  has(id) { return this.get(id) !== undefined; },
};
let resBuf = new Float32Array(0), resCount = 0;
let projBuf = new Float32Array(0), projCount = 0;
let mouse = { x: 0, y: 0, inside: false };
// Where the pointer is in the whole browser window, for scrolling at its edges.
const page = { x: 0, y: 0, inside: false };
window.addEventListener("pointermove", e => { page.x = e.clientX; page.y = e.clientY; page.inside = true; }, { passive: true });
window.addEventListener("pointerout", e => { if (!e.relatedTarget) page.inside = false; }); // left the window
let drag = null, orbit = null;
let placing = null, amode = false;
// Aiming a nuke: the silo it launches from (attack-move's targeting mode).
let aimSilo = null;
let groups = {};
let lastClick = { t: 0, x: 0, y: 0 };
let lastAlert = null;
let keys = new Set();
let selKey = "";
let hoverTip = null;
let frame = 0;

function resizeView() {
  const r = stage.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  view._w = r.width; view._h = r.height;
  over.width = Math.max(1, Math.round(r.width * dpr));
  over.height = Math.max(1, Math.round(r.height * dpr));
  over._dpr = dpr;
  resizeRenderer();
}
window.addEventListener("resize", resizeView);

function clampCam() {
  cam.x = Math.max(0, Math.min(MW, cam.x));
  cam.y = Math.max(0, Math.min(MH, cam.y));
  cam.dist = Math.max(9, Math.min(48, cam.dist));
  cam.pitch = Math.max(0.6, Math.min(1.35, cam.pitch));
}
function centerOn(tx, ty) { cam.x = tx; cam.y = ty; clampCam(); }

// ===========================================================================
// Small helpers
function hash2(x, y) { let h = (x * 374761393 + y * 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function ellipse(c, x, y, rx, ry) { c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); }
function rr(c, x, y, w, h, r) { c.beginPath(); c.roundRect ? c.roundRect(x, y, w, h, r) : c.rect(x, y, w, h); }
function fmtTime(s) { s = Math.floor(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }
// A kind's slot lists as [[resource, amount], ...]: which 0 cost, 1 makes, 2 consumes.
function slotsOf(k, which = 0) { const out = []; for (let n = 0; n < W.kind_slots_n(k, which); n++) out.push([W.kind_slots_res(k, which, n), W.kind_slots_amt(k, which, n)]); return out; }
function stat(k, i) { return W.kind_stat(k, i); }
function free(r) { return W.supply(r) - W.used(r); }
function canAfford(k) { return W.short_of(k) < 0; }
// The building that makes each resource (for "build a lumber camp" hints).
let PRODUCER = null;
function producerOf(r) {
  if (!PRODUCER) { PRODUCER = {}; for (const k of Object.values(K)) for (const [p] of slotsOf(k, 1)) if (k !== K.Capitol && PRODUCER[p] == null) PRODUCER[p] = k; }
  return PRODUCER[r];
}
// "2 Spearmen", "1 Barracks", "3 Lumber Camps".
function plural(k, n) {
  const name = NAMES[k];
  if (n === 1 || name.endsWith("s")) return `${n} ${name}`;
  return `${n} ${name.endsWith("man") ? name.slice(0, -3) + "men" : name + "s"}`;
}
function slotsHtml(list, mark = true) {
  return list.map(([r, c]) => `<span class="${mark && free(r) < c ? "short" : ""}" title="${RES_NAMES[r]}">${resIcon(r)}${c}</span>`).join("");
}
// The resource icons as images, for drawing on the overlay canvas.
const resImages = [];
function resImage(r) {
  if (!resImages[r]) {
    const img = new Image();
    img.src = "data:image/svg+xml," + encodeURIComponent(resIcon(r).replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" '));
    resImages[r] = img;
  }
  return resImages[r];
}
function costHtml(k) {
  const c = slotsOf(k);
  return '<div class="cost">' + (c.length ? slotsHtml(c) : '<span class="free">free</span>') + "</div>";
}

// ===========================================================================
// Terrain: paint tile colours into a tiny canvas, then let the browser scale
// it up with smoothing — that blends the tile edges for free.
// Smooth value noise for large-scale colour variation (meadow patches).
function vnoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const sm = t => t * t * (3 - 2 * t), u = sm(fx), v = sm(fy);
  const hsh = (a, b) => hash2(a * 31 + seed, b * 17 - seed);
  const top = hsh(xi, yi) + (hsh(xi + 1, yi) - hsh(xi, yi)) * u;
  const bot = hsh(xi, yi + 1) + (hsh(xi + 1, yi + 1) - hsh(xi, yi + 1)) * u;
  return top + (bot - top) * v;
}
const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// Paint the ground texture. A small per-tile image feeds the minimap; the big
// one (32 px per tile) is the 3D terrain's texture.
function bakeTerrain() {
  MW = W.map_w(); MH = W.map_h();
  computeHeights();
  const ter = u8(W.terrain_ptr(), MW * MH).slice();
  // Colour at any map position. Grass blends lush, dark and sun-dried greens
  // in big soft patches; slopes turn to earth and rock; shores to sand.
  // A clean, almost flat green, like Totally Accurate Battle Simulator's fields:
  // only broad, gentle patches. Small 3D pieces (grass clumps, flowers,
  // pebbles; render3d.js) give the detail instead of painted strokes.
  const LUSH = [90, 156, 62], DARK = [76, 138, 54], DRY = [118, 156, 66], EARTH = [130, 112, 78], ROCK = [138, 132, 118], SAND = [204, 186, 132], SEABED = [120, 132, 96];
  // `beach`: paint the sand in. The 3D view draws its own crisp beaches in
  // the ground shader (render3d.js), so only the minimap wants it.
  const colourAt = (x, y, beach = true) => {
    const t = ter[Math.min(MH - 1, y | 0) * MW + Math.min(MW - 1, x | 0)];
    const n1 = vnoise(x / 9, y / 9, 3), n2 = vnoise(x / 3.5, y / 3.5, 11), n3 = vnoise(x * 1.3, y * 1.3, 29);
    let c = mixc(LUSH, DARK, Math.max(0, Math.min(1, (n1 - 0.45) * 2.0)));
    c = mixc(c, DRY, Math.max(0, Math.min(1, (n2 - 0.66) * 2)) * 0.6);
    const sl = slopeAt(x, y), ht = hAt(x, y);
    c = mixc(c, EARTH, Math.max(0, Math.min(1, (sl - 0.18) * 4)));
    c = mixc(c, ROCK, Math.max(0, Math.min(1, (sl - 0.38) * 4)));
    c = mixc(c, [c[0] * 1.08, c[1] * 1.05, c[2] * 0.95], Math.max(0, Math.min(1, ht - 0.8))); // sunnier up high
    // Beaches follow the (smooth) height near the water, not the square tiles.
    if (beach) c = mixc(c, SAND, Math.max(0, Math.min(1, (0.2 - ht) / 0.14)) * 0.9);
    if (t === 1) c = mixc(SAND, SEABED, Math.min(1, -ht));
    const k = 0.98 + n3 * 0.04;
    return [c[0] * k, c[1] * k, c[2] * k];
  };
  terrainSmall = document.createElement("canvas");
  terrainSmall.width = MW; terrainSmall.height = MH;
  const sc = terrainSmall.getContext("2d");
  const img = sc.createImageData(MW, MH);
  for (let i = 0; i < MW * MH; i++) {
    const c = ter[i] === 1 ? [40, 96, 118] : colourAt((i % MW) + 0.5, ((i / MW) | 0) + 0.5);
    img.data.set([c[0], c[1], c[2], 255], i * 4);
  }
  sc.putImageData(img, 0, 0);

  // The 3D texture: a mid-resolution colour pass (8 px per tile), scaled up.
  const MID = 8;
  const mid = document.createElement("canvas"); mid.width = MW * MID; mid.height = MH * MID;
  const mc = mid.getContext("2d"), mi = mc.createImageData(mid.width, mid.height);
  for (let py = 0; py < mid.height; py++) for (let px = 0; px < mid.width; px++) {
    const c = colourAt((px + 0.5) / MID, (py + 0.5) / MID, false);
    mi.data.set([c[0], c[1], c[2], 255], (py * mid.width + px) * 4);
  }
  mc.putImageData(mi, 0, 0);
  terrainCanvas = document.createElement("canvas");
  terrainCanvas.width = MW * TILE; terrainCanvas.height = MH * TILE;
  const tc = terrainCanvas.getContext("2d");
  tc.imageSmoothingEnabled = true; tc.imageSmoothingQuality = "high";
  tc.drawImage(mid, 0, 0, MW * TILE, MH * TILE);

  // Detail on top: only pebbles on rocky slopes. Grass gets its detail from
  // 3D clumps instead (render3d.js), and sand from the ground shader.
  for (let ty = 0; ty < MH; ty++) for (let tx = 0; tx < MW; tx++) {
    if (slopeAt(tx + 0.5, ty + 0.5) <= 0.35) continue;
    for (let k = 0; k < 4; k++) {
      const hx = hash2(tx * 7 + k, ty * 13 - k), hy = hash2(ty * 11 + k, tx * 5 + k);
      const x = (tx + hx) * TILE, y = (ty + hy) * TILE;
      tc.fillStyle = k % 2 ? "rgba(70,62,50,.35)" : "rgba(200,192,176,.3)";
      tc.beginPath(); tc.ellipse(x, y, 1.5 + hx * 2.5, 1 + hy * 1.5, hx * 3, 0, 7); tc.fill();
    }
  }

  fogCanvas = document.createElement("canvas"); fogCanvas.width = MW; fogCanvas.height = MH;
  fogCtx = fogCanvas.getContext("2d"); fogImg = fogCtx.createImageData(MW, MH);
}

function updateFog() {
  const fog = u8(W.fog_ptr(), MW * MH);
  const d = fogImg.data;
  for (let i = 0; i < MW * MH; i++) {
    d[i * 4] = 10; d[i * 4 + 1] = 9; d[i * 4 + 2] = 7;
    d[i * 4 + 3] = fog[i] === 0 ? 255 : fog[i] === 1 ? 120 : 0;
  }
  fogCtx.putImageData(fogImg, 0, 0);
  updateFowTexture();
}

// ===========================================================================
// Reading the world from wasm memory
// The buffers' views into wasm memory are made again only when the buffer
// moved (Rust grew it, or wasm memory grew) or got longer: making them every
// frame is garbage the browser has to clean up.
const views = {};
function viewOf(name, ptr, n) {
  const v = views[name];
  if (v && v.buffer === mem.buffer && v.byteOffset === ptr && v.length >= n) return v;
  return (views[name] = f32(ptr, Math.max(n, 64)));
}
function readWorld() {
  entCount = W.render();
  ents = viewOf("ents", W.ents_ptr(), entCount * ENT_STRIDE);
  resCount = W.res_count();
  resBuf = viewOf("res", W.res_ptr(), resCount * 5);
  projCount = W.proj_count();
  projBuf = viewOf("proj", W.proj_ptr(), projCount * PROJ_STRIDE);
  byId.reset();
  for (let i = 0; i < entCount; i++) byId.set(ents[i * ENT_STRIDE], i);
}
const E = (i, f) => ents[i * ENT_STRIDE + f];
// field offsets
// flags: 1 selected, 2 under construction, 4 visible, 8 just hit, 16 unsupplied,
// 32 a producer without its crew (the last two for your own things only).
// residents and beds are a house's.
const F = { id: 0, kind: 1, owner: 2, x: 3, y: 4, px: 5, py: 6, hp: 7, maxhp: 8, flags: 9, prog: 10, anim: 11, residents: 12, beds: 13, face: 14, order: 15, rx: 16, ry: 17 };

function selection() {
  const out = [];
  for (let i = 0; i < entCount; i++) if (E(i, F.flags) & 1) out.push(i);
  return out;
}

// ===========================================================================
// 2D overlay on top of the 3D view: health bars and the drag box.
function drawOverlay() {
  const dpr = over._dpr;
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.clearRect(0, 0, view._w, view._h);
  for (let i = 0; i < entCount; i++) {
    const k = E(i, F.kind), flags = E(i, F.flags);
    const sel = flags & 1, f = E(i, F.hp) / E(i, F.maxhp), bld = isBld(k), short = flags & 16, paused = flags & 64, idleP = (flags & 32) && !paused;
    // Your houses show the first good they still want, in a bubble.
    const want = bld && E(i, F.owner) === ME && !(flags & 2) && stat(k, 10) >= 0 ? nextWant(k, W.house_goods(E(i, F.id))) : undefined;
    // ...and an arrow when one can be upgraded (it's your call: Upgrade, Z).
    const ready = bld && E(i, F.owner) === ME && !(flags & 2) && HOUSE_UP[k] && W.house_upgrade_state(E(i, F.id)) === 0;
    // A converter of yours without all its inputs: the one it lacks, crossed out.
    const unfed = bld && E(i, F.owner) === ME && (flags & 256) && !paused;
    if (!sel && !short && !idleP && !paused && !unfed && want === undefined && !ready && (f >= 1 || bld)) continue;
    const p = entScreen(i, true);
    if (!p || p.behind) continue;
    if (ready) {
      const x = p.x + (want !== undefined ? 15 : 0), y = p.y - 18;
      octx.fillStyle = "rgba(20,16,10,.78)"; rr(octx, x - 12, y - 12, 24, 24, 6); octx.fill();
      octx.fillStyle = "#79c95f"; octx.beginPath(); octx.moveTo(x, y - 8); octx.lineTo(x + 7, y); octx.lineTo(x + 3, y); octx.lineTo(x + 3, y + 7);
      octx.lineTo(x - 3, y + 7); octx.lineTo(x - 3, y); octx.lineTo(x - 7, y); octx.closePath(); octx.fill();
      if (want === undefined && !sel && f >= 1) continue;
    }
    if (want !== undefined) {
      const x = p.x - (ready ? 15 : 0), y = p.y - 18, img = resImage(want);
      octx.fillStyle = "rgba(20,16,10,.78)"; rr(octx, x - 12, y - 12, 24, 24, 6); octx.fill();
      octx.beginPath(); octx.moveTo(x - 4, y + 11); octx.lineTo(x, y + 16); octx.lineTo(x + 4, y + 11); octx.fill();
      if (img.complete) octx.drawImage(img, x - 8, y - 8, 16, 16);
      if (!sel && f >= 1) continue;
    }
    if (unfed) {
      const lack = slotsOf(k, 2).find(([r, n]) => free(r) < n), x = p.x, y = p.y - (idleP ? 46 : 20);
      octx.fillStyle = "rgba(20,16,10,.85)"; rr(octx, x - 13, y - 13, 26, 26, 6); octx.fill();
      const img = lack && resImage(lack[0]);
      if (img && img.complete) octx.drawImage(img, x - 8, y - 8, 16, 16);
      octx.strokeStyle = "#e2593f"; octx.lineWidth = 2.5; octx.beginPath(); octx.moveTo(x - 9, y + 9); octx.lineTo(x + 9, y - 9); octx.stroke();
      if (!idleP && !sel && f >= 1) continue;
    }
    if (paused) { // a producer you paused: two bars
      const x = p.x, y = p.y - 20;
      octx.fillStyle = "rgba(20,16,10,.8)"; octx.beginPath(); octx.arc(x, y, 11, 0, 7); octx.fill();
      octx.fillStyle = "#e3b23c"; octx.fillRect(x - 5, y - 5.5, 3.5, 11); octx.fillRect(x + 1.5, y - 5.5, 3.5, 11);
      if (!sel && f >= 1) continue;
    }
    if (idleP) { // a producer with no crew: a person, crossed out
      const x = p.x, y = p.y - 20;
      octx.fillStyle = "rgba(20,16,10,.8)"; octx.beginPath(); octx.arc(x, y, 13, 0, 7); octx.fill();
      octx.fillStyle = "#d9c9a8"; octx.beginPath(); octx.arc(x, y - 4, 3.6, 0, 7); octx.fill();
      octx.beginPath(); octx.moveTo(x - 7, y + 8); octx.quadraticCurveTo(x, y - 4, x + 7, y + 8); octx.fill();
      octx.strokeStyle = "#e2593f"; octx.lineWidth = 2.5; octx.beginPath(); octx.moveTo(x - 8, y - 8); octx.lineTo(x + 8, y + 8); octx.stroke();
      if (!sel && f >= 1) continue;
    }
    if (short) { // unsupplied: a small amber warning sign above the bar
      octx.fillStyle = "#e3b23c"; octx.strokeStyle = "rgba(0,0,0,.7)"; octx.lineWidth = 1.5;
      octx.beginPath(); octx.moveTo(p.x, p.y - 22); octx.lineTo(p.x + 6, p.y - 12); octx.lineTo(p.x - 6, p.y - 12); octx.closePath(); octx.stroke(); octx.fill();
      octx.fillStyle = "#1a140c"; octx.fillRect(p.x - 0.75, p.y - 19, 1.5, 4); octx.fillRect(p.x - 0.75, p.y - 14, 1.5, 1.2);
    }
    const w = bld ? 46 : 22;
    octx.fillStyle = "rgba(0,0,0,.6)"; octx.fillRect(p.x - w / 2 - 1, p.y - 8, w + 2, 5);
    octx.fillStyle = f > 0.5 ? "#79c95f" : f > 0.25 ? "#e3b23c" : "#e2593f";
    octx.fillRect(p.x - w / 2, p.y - 7, w * Math.max(0, f), 3);
  }
  if (drag && drag.moved) {
    octx.strokeStyle = "#9cf27f"; octx.lineWidth = 1; octx.fillStyle = "rgba(156,242,127,.08)";
    const x = Math.min(drag.x0, mouse.x), y = Math.min(drag.y0, mouse.y), w = Math.abs(mouse.x - drag.x0), h = Math.abs(mouse.y - drag.y0);
    octx.fillRect(x, y, w, h); octx.strokeRect(x + 0.5, y + 0.5, w, h);
  }
}

function drawMinimap() {
  const s = mini.width / MW;
  mctx.imageSmoothingEnabled = true;
  mctx.drawImage(terrainSmall, 0, 0, mini.width, mini.height);
  // One colour at a time (setting the colour for every dot is slow and makes garbage).
  // Deposit kinds (defs::Dep): fruit bushes, forest, stone, horses, game.
  // Then iron ore, clay and sheep hills (5, water, has no dots).
  const RES_DOT = ["#d04848", "#24451f", "#b8b2a6", "#a0703f", "#c8a26a", null, "#7a4a3a", "#c0703f", "#f0ece0", "#dcd8c8", "#202024", "#3a3036", "#b86a4a", "#9ed14a"], dot = Math.max(1.5, s);
  for (let kd = 0; kd < RES_DOT.length; kd++) {
    if (!RES_DOT[kd]) continue;
    mctx.fillStyle = RES_DOT[kd];
    for (let i = 0; i < resCount; i++) if (resBuf[i * 5 + 2] === kd) mctx.fillRect(resBuf[i * 5] * s, resBuf[i * 5 + 1] * s, dot, dot);
  }
  mctx.drawImage(fogCanvas, 0, 0, mini.width, mini.height);
  for (let i = 0; i < entCount; i++) {
    const k = E(i, F.kind), o = E(i, F.owner);
    mctx.fillStyle = (E(i, F.flags) & 1) ? "#fff" : PLIGHT[o];
    if (isBld(k)) { const z = stat(k, 6) * s; mctx.fillRect(E(i, F.x) * s - z / 2, E(i, F.y) * s - z / 2, z, z); }
    else mctx.fillRect(E(i, F.x) * s - 1.5, E(i, F.y) * s - 1.5, 3, 3);
  }
  // What the camera sees is a trapezoid on the ground.
  const q = viewQuad();
  if (q.length === 4) {
    mctx.strokeStyle = "#efe6d1"; mctx.lineWidth = 1;
    mctx.beginPath();
    for (let n = 0; n < 4; n++) { const x = q[n][0] * s, y = q[n][1] * s; if (n) mctx.lineTo(x, y); else mctx.moveTo(x, y); }
    mctx.closePath(); mctx.stroke();
  }
}

// ===========================================================================
// HUD
// The resource bar: a chip for every resource the player makes or holds,
// showing free slots and supply. Rebuilt only when that set of resources
// changes; otherwise only its numbers change, so the hover tooltip doesn't
// flicker.
function setupTopBar(shown = []) {
  const bar = $("res");
  bar.replaceChildren();
  // Later eras bring many resources: squeeze the chips so they stay on one line.
  bar.classList.toggle("many", shown.length > 7);
  bar.classList.toggle("lots", shown.length > 11);
  const chips = [];
  for (const r of shown) {
    const c = document.createElement("span");
    c.className = "chip"; c.tabIndex = 0; c.dataset.r = r;
    c.innerHTML = `${resIcon(r)}<b></b><small></small>`;
    c.onmouseenter = c.onfocus = () => { resTipFor = r; renderResTip(); };
    c.onmouseleave = c.onblur = () => { resTipFor = -1; $("restip").hidden = true; };
    c.onclick = () => { resTipFor = resTipFor === r ? -1 : r; renderResTip(); }; // tap on phones
    chips.push(c);
  }
  const pop = document.createElement("span"); pop.className = "chip pop"; pop.tabIndex = 0;
  pop.onmouseenter = pop.onfocus = () => { resTipFor = PEOPLE_TIP; renderResTip(); };
  pop.onmouseleave = pop.onblur = () => { resTipFor = -1; $("restip").hidden = true; };
  pop.onclick = () => { resTipFor = resTipFor === PEOPLE_TIP ? -1 : PEOPLE_TIP; renderResTip(); };
  const era = document.createElement("button"); era.className = "era"; era.title = "Tech tree (K)";
  era.onclick = toggleTech;
  // A thin line between one era's resources and the next era's.
  const parts = [];
  chips.forEach((c, n) => {
    const e = W.res_era(+c.dataset.r);
    if (n > 0 && e !== W.res_era(+chips[n - 1].dataset.r)) {
      const d = document.createElement("span"); d.className = "era-div"; d.title = `${ERA_NAMES[e]} resources`; d.setAttribute("aria-hidden", "true");
      parts.push(d);
    }
    parts.push(c);
  });
  bar.append(pop, ...parts, era); // people first, on the left
  topBar = { chips, pop, era, key: shown.join(",") };
}
let topBar = null, resTipFor = -1;
const PEOPLE_TIP = -2; // resTipFor value: the people chip's tooltip
// Buildings the player has already been told they can build.
let knownUnlocked = new Set();

function eraIndex() { return W.era(); }
// Every kind but newcomers, in Rust's order (units first, then buildings).
let ALL_KINDS = null;
function allKinds() {
  if (!ALL_KINDS) { ALL_KINDS = []; for (let n = 0; n < W.kind_count(); n++) ALL_KINDS.push(W.kind_at(n)); }
  return ALL_KINDS;
}

function renderTopBar() {
  // Every resource the player makes or holds, in table order.
  const shown = [];
  for (let r = 0; r < W.n_res(); r++) if (W.supply(r) || W.used(r)) shown.push(r);
  if (!topBar || topBar.key !== shown.join(",")) setupTopBar(shown);
  $("res").hidden = !!observe && !observe.view;
  // What's left of each resource: after everything that holds it, houses
  // included (they give it up if something new needs it).
  for (const c of topBar.chips) {
    const r = +c.dataset.r, f = free(r) - W.housed(r);
    c.querySelector("b").textContent = f;
    const sm = c.querySelector("small");
    sm.textContent = `/ ${W.supply(r)}`;
    c.classList.toggle("over", f < 0);
  }
  // People: the free workers in the town square, out of everyone.
  const hungry = W.unsupplied(), freeP = W.people(0), all = W.people(4);
  topBar.pop.className = "chip pop" + (hungry ? " full" : "");
  topBar.pop.innerHTML = `<svg viewBox="0 0 16 16"><circle cx="8" cy="4.5" r="2.8" fill="#d9c9a8"/><path d="M2.5 15c0-3.6 2.4-6 5.5-6s5.5 2.4 5.5 6z" fill="#d9c9a8"/></svg>${freeP}<small>/ ${all}</small>${hungry ? ` · ${hungry} unsupplied` : ""}`;
  topBar.era.textContent = `${ERA_NAMES[eraIndex()]} era`;
  const nextEra = eraIndex() + 1;
  topBar.era.title = nextEra <= W.era_progress(2)
    ? `Tech tree (K). ${HOUSE_NAMES[nextEra]}s: ${W.era_progress(0)} of ${W.era_progress(1)} for the ${ERA_NAMES[nextEra]} era.`
    : "Tech tree (K)";
  $("clock").textContent = fmtTime(W.game_time());
  if (resTipFor >= 0) renderResTip();
}

// Where a resource's slots come from and what holds them.
function renderResTip() {
  const tip = $("restip"), r = resTipFor;
  if (r === PEOPLE_TIP && topBar) return renderPeopleTip(tip);
  const chipEl = topBar && topBar.chips.find(c => +c.dataset.r === r);
  if (r < 0 || !chipEl) { tip.hidden = true; return; }
  const line = (label, v, cls = "") => `<div class="row ${cls}"><span>${label}</span><b>${v}</b></div>`;
  const name = RES_NAMES[r][0].toUpperCase() + RES_NAMES[r].slice(1);
  let html = `<h4>${name}</h4>`;
  let made = 0, held = 0;
  for (const k of Object.values(K)) {
    const n = k === K.Capitol ? W.count(k) : W.count_built(k);
    const m = slotsOf(k, 1).find(([p]) => p === r);
    if (n && m) { html += line(`${plural(k, n)} × ${m[1]}`, `+${n * m[1]}`, "pos"); made += n * m[1]; }
  }
  for (const k of Object.values(K)) {
    const n = W.count(k), c = slotsOf(k).find(([p]) => p === r);
    if (n && c) { html += line(`${plural(k, n)} × ${c[1]}`, `−${n * c[1]}`, "neg"); held += n * c[1]; }
  }
  if (W.used(r) > held) html += line("In training", `−${W.used(r) - held}`, "neg");
  if (W.housed(r)) html += line("In houses", `−${W.housed(r)}`, "neg");
  if (W.supply(r) !== made) html += line("Handicap", `${W.supply(r) - made >= 0 ? "+" : "−"}${Math.abs(W.supply(r) - made)}`);
  html += `<div class="row total"><span>Free</span><b>${free(r) - W.housed(r)}</b></div>`;
  if (W.is_house_good(r)) html += `<p class="note">Houses want it: each house takes one, nearest the Capitol first, and gets 2 beds for it (3 past its third good). Buildings and units come first: when it runs short, the furthest houses lose it.</p>`;
  if (free(r) < 0) html += `<p class="bad">You hold more ${RES_NAMES[r]} than you make: your newest units that need it are losing health.</p>`;
  const p = producerOf(r);
  html += `<p class="note">Slots are borrowed, not spent: whatever holds them gives them back when it's gone.${p != null ? ` A ${NAMES[p]} makes more.` : ""}</p>`;
  tip.innerHTML = html;
  const chip = chipEl.getBoundingClientRect(), app = $("app").getBoundingClientRect();
  tip.style.left = `${Math.max(8, Math.min(app.width - 270, chip.left - app.left))}px`;
  tip.hidden = false;
}

// Where everyone is: free in the town square, at work, in arms.
function renderPeopleTip(tip) {
  const freeP = W.people(0), beds = W.people(1), soldiers = W.people(2), work = W.people(3), all = W.people(4);
  const line = (label, v, cls = "") => `<div class="row ${cls}"><span>${label}</span><b>${v}</b></div>`;
  let html = `<h4>People</h4>`;
  html += line("Free, in the town square", freeP, freeP ? "pos" : "") + line("Working", work) + line("Soldiers and recruits", soldiers);
  const other = all - freeP - work - soldiers;
  if (other > 0) html += line("Building, or elsewhere", other);
  html += `<div class="row total"><span>Everyone</span><b>${all}</b></div>`;
  html += line("Beds", beds);
  html += all < beds
    ? `<p>There are free beds: someone new turns up in the town square every ${W.people(5) ? `few` : ""} seconds, sooner in a bigger town.</p>`
    : `<p class="bad">Every bed is taken. Build a Hut and give your houses more kinds of goods: each kind is 2 more beds in every house that gets it (3 past the third).</p>`;
  html += `<p class="note">Free workers go to work, build and enlist by themselves. Training a soldier takes one from the town square.</p>`;
  tip.innerHTML = html;
  const chip = topBar.pop.getBoundingClientRect(), app = $("app").getBoundingClientRect();
  tip.style.left = `${Math.max(8, Math.min(app.width - 270, chip.left - app.left))}px`;
  tip.hidden = false;
}

// The tech tree panel.
function toggleTech() {
  const p = $("techScreen");
  if (!p.hidden) { p.hidden = true; return; }
  renderTech();
  p.hidden = false;
}
function renderTech() {
  const body = $("techBody");
  body.replaceChildren();
  const reached = eraIndex();
  ERA_NAMES.forEach((name, era) => {
    const col = document.createElement("div"); col.className = "era-col" + (era <= reached ? " reached" : "") + (era === 0 ? " wide" : "");
    // The house of this era, and the goods that come with it.
    const goods = []; for (let r = 0; r < W.n_res(); r++) if (W.res_era(r) === era && W.is_house_good(r)) goods.push(r);
    const max = W.house_max_goods(era);
    col.innerHTML = `<h3>${["I", "II", "III", "IV", "V", "VI"][era]} · ${name}</h3>` +
      `<div class="era-house"><b>${HOUSE_NAMES[era]}</b><span>up to ${max} goods, ${max * 2} people</span><span class="cost inline">${goods.map(r => `<span title="${RES_NAMES[r]}">${resIcon(r)}</span>`).join("")}</span></div>`;
    // Buildings first, then units, each in Rust's order.
    const kinds = allKinds().filter(k => W.kind_era(k) === era && k !== K.Capitol && k !== K.Worker);
    kinds.sort((a, b) => isBld(b) - isBld(a));
    const list = document.createElement("div"); list.className = "era-list";
    for (const k of kinds) list.append(techCard(k));
    if (!kinds.length) { const p = document.createElement("p"); p.className = "note"; p.textContent = "Still to come."; list.append(p); }
    col.append(list);
    body.append(col);
  });
}
// One unit or building in the tech tree: what it costs, makes and needs.
function techCard(k) {
  const card = document.createElement("div");
  const bld = isBld(k);
  // A unit is open when something that trains it is built.
  const trainers = Object.keys(TRAINS).map(Number).filter(b => TRAINS[b].includes(k));
  const built = bld ? W.has_built(k) : false, open = bld ? W.unlocked(k) : trainers.some(b => W.has_built(b)) && W.kind_era(k) <= W.era();
  // Houses past the first grow from the one below; nobody builds them.
  const grows = { [K.Cottage]: K.Hut, [K.Townhouse]: K.Cottage, [K.Tenement]: K.Townhouse, [K.Apartment]: K.Tenement, [K.TowerBlock]: K.Apartment }[k];
  card.className = "tcard " + (built ? "built" : open ? "open" : "locked");
  card.append(iconEl(k, ME, 40));
  const needs = []; for (let n = 0, q; (q = W.requires(k, n)) >= 0; n++) needs.push(q);
  if (!bld) needs.push(...trainers);
  const cost = slotsOf(k), makes = slotsOf(k, 1), takes = slotsOf(k, 2), dep = W.kind_deposit(k);
  const info = document.createElement("div");
  info.innerHTML = `<b>${NAMES[k]}</b>` +
    `<span class="cost inline">${cost.length ? slotsHtml(cost, false) : '<span class="free">free</span>'}${bld ? "" : `<span title="a person">${PERSON_ICON}1</span>`}</span>` +
    (takes.length ? `<span>Takes <span class="cost inline">${slotsHtml(takes, false)}</span></span>` : "") +
    (makes.length ? `<span>Makes <span class="cost inline">${slotsHtml(makes, false)}</span>${stat(k, 7) ? ` · ${stat(k, 7)} worker${stat(k, 7) === 1 ? "" : "s"}` : ""}</span>` : "") +
    (dep >= 0 ? `<span>Next to ${DEP_NAMES[dep]}</span>` : "") +
    (needs.length ? `<span class="needs">Needs ${needs.map(q => `<i class="${W.has_built(q) ? "ok" : ""}">${NAMES[q]}</i>`).join(" + ")}</span>` : "") +
    `<span class="state">${grows != null ? (built ? "You have one" : `Grows from a ${NAMES[grows].toLowerCase()}`) : bld ? (built ? "Built" : open ? "Ready to build" : "Locked") : (open ? "Can train" : "Locked")}</span>`;
  info.title = DESC[k] || "";
  card.append(info);
  return card;
}
const PERSON_ICON = '<svg viewBox="0 0 16 16"><circle cx="8" cy="4.5" r="2.8" fill="#d9c9a8"/><path d="M2.5 15c0-3.6 2.4-6 5.5-6s5.5 2.4 5.5 6z" fill="#d9c9a8"/></svg>';

function renderSelection(force) {
  const sel = selection();
  // Only rebuild the DOM when something visible changed.
  let freeSig = ""; for (let r = 0; r < 13; r++) freeSig += free(r) + ",";
  const sig = sel.map(i => `${E(i, F.id)}:${Math.ceil(E(i, F.hp))}:${E(i, F.order)}:${E(i, F.flags) & 370}:${E(i, F.residents)}/${E(i, F.beds)}:${W.house_goods(E(i, F.id))}:${W.builders_in(E(i, F.id))}:${Math.floor(E(i, F.prog) * 40)}:${W.queue_len(E(i, F.id))}`).join(",") + `|${placing}|${amode}|${W.people(0)}|${demolishArm ? 1 : 0}|${BUILD_MENU.map(([k]) => W.has_built(k)).join("")}|${freeSig}|${W.era()}:${W.era_progress(0)}:${buildPage}|${sel.map(i => W.silo_state(E(i, F.id))).join("")}|${sel.some(i => E(i, F.kind) === K.Capitol) ? `${Math.floor(W.next_arrival() * 40)}:${W.people(1)}:${W.people(4)}` : ""}|${sel.map(i => HOUSE_UP[E(i, F.kind)] ? W.house_upgrade_state(E(i, F.id)) : "").join(",")}`;
  if (!force && sig === selKey) return;
  // A button held down: rebuilding the panel now would swallow its click
  // (the button under the pointer is replaced before it's released).
  if (!force && cmdHeld) return;
  selKey = sig;
  const panel = $("sel");
  panel.replaceChildren();
  if (sel.length === 0 && observe) {
    const d = document.createElement("div");
    d.className = "tips";
    d.innerHTML = observe.kind === "replay"
      ? `<h3>Replay</h3>Play, pause and jump with the bar above. Click a player's name to see the game as they saw it, fog and all; <b>Whole map</b> lifts the fog. Click anything to look at it.`
      : `<h3>Watching</h3>Click a player's name to see the game as they see it, fog and all; <b>Whole map</b> lifts the fog. Click anything to look at it.`;
    panel.append(d);
  } else if (sel.length === 0) {
    const d = document.createElement("div");
    d.className = "tips";
    d.innerHTML = `<h3>Outlast your rivals</h3>Buildings <b>make</b> resources and everything you have <b>holds</b> some while it exists. Your free workers wait in the <b>town square</b>: they build, go to work and enlist by themselves, and every producer needs its workers standing there. Select a worker (or your Capitol) to build: a <b>Lumber Camp</b> by a forest, <b>Farms</b>, then <b>Huts</b>; each kind of food a hut gets is 2 more beds, and newcomers fill free beds. Press <kbd class="k">.</kbd> to select the free workers`;
    panel.append(d);
  } else if (sel.length === 1) {
    singleInfo(panel, sel[0]);
  } else {
    const box = document.createElement("div"); box.className = "multi";
    for (const i of sel.slice(0, 40)) {
      const b = document.createElement("button");
      b.title = NAMES[E(i, F.kind)];
      b.append(iconEl(E(i, F.kind), E(i, F.owner), 36));
      const bar = document.createElement("i"); const fill = document.createElement("b");
      fill.style.width = `${(E(i, F.hp) / E(i, F.maxhp)) * 100}%`; bar.append(fill); b.append(bar);
      const id = E(i, F.id);
      b.onclick = () => { setSelection([id]); };
      box.append(b);
    }
    panel.append(box);
    // Barracks, ranges, stables ...: what each of them is training.
    const makers = sel.filter(i => isBld(E(i, F.kind)) && TRAINS[E(i, F.kind)] && (E(i, F.owner) === ME || observe) && !(E(i, F.flags) & 2));
    if (makers.length) {
      const list = document.createElement("div"); list.className = "trainlist";
      for (const i of makers.slice(0, 12)) {
        const id = E(i, F.id), q = W.queue_len(id);
        const row = document.createElement("div"); row.className = "trainrow";
        const who = iconEl(E(i, F.kind), E(i, F.owner), 28); who.title = NAMES[E(i, F.kind)]; who.className = "who";
        row.append(who);
        const items = document.createElement("div"); items.className = "queue";
        if (q === 0) {
          const idle = document.createElement("span"); idle.className = "idle"; idle.textContent = "idle"; items.append(idle);
        }
        for (let n = 0; n < q; n++) {
          const b = document.createElement("button"); b.title = n === 0 ? `Training ${NAMES[W.queue_kind(id, 0)]} · ${Math.floor(E(i, F.prog) * 100)}%. Click to cancel the last unit in the queue` : `${NAMES[W.queue_kind(id, n)]}. Click to cancel the last unit in the queue`;
          b.append(iconEl(W.queue_kind(id, n), ME, 28));
          if (n === 0) { const bar = document.createElement("i"); bar.innerHTML = `<b style="width:${E(i, F.prog) * 100}%"></b>`; b.append(bar); }
          b.onclick = () => issue({ c: 5, ids: [id] });
          items.append(b);
        }
        row.append(items);
        list.append(row);
      }
      panel.append(list);
    }
  }
  renderCommands(sel);
}

function singleInfo(panel, i) {
  const k = E(i, F.kind), owner = E(i, F.owner), id = E(i, F.id);
  const por = iconEl(k, owner, 72); por.className = "portrait";
  const info = document.createElement("div"); info.className = "info";
  const hp = Math.ceil(E(i, F.hp)), max = E(i, F.maxhp);
  let html = `<div class="owner" style="color:${PLIGHT[owner]}">${owner === ME ? "Yours" : pn(owner)}</div><h3>${NAMES[k]}</h3>
    <div class="bar"><i style="width:${(hp / max) * 100}%"></i></div>
    <div class="statline"><b>${hp}</b> / ${max} hp`;
  const atk = stat(k, 1);
  if (atk > 0) html += ` · attack <b>${atk}</b> · ${stat(k, 2) > 1.5 ? `range <b>${stat(k, 2)}</b>` : "melee"}`;
  html += `</div>`;
  if (!isBld(k)) {
    if (owner === ME || observe) html += `<div class="statline">${ORDER_TEXT[E(i, F.order)]}</div>`;
    if (E(i, F.flags) & 16) html += `<div class="statline bad">Unsupplied: losing health. Make more ${slotsOf(k).map(([r]) => RES_NAMES[r]).join(" and ")}.</div>`;
  } else if (E(i, F.flags) & 2) {
    const need = stat(k, 9), got = W.builders_in(id);
    html += got < need
      ? `<div class="statline">Waiting for builders · ${got} of ${need} here. Free workers in the town square come by themselves.</div>`
      : `<div class="statline">Under construction · ${Math.floor(E(i, F.prog) * 100)}%</div><div class="bar prog"><i style="width:${E(i, F.prog) * 100}%"></i></div>`;
  } else if (stat(k, 10) >= 0) {
    // A house: which goods it has and which it wants; its beds.
    const goods = W.house_goods(id), { have, wants } = houseWants(k, goods);
    const icons = list => `<span class="cost inline">${list.map(r => `<span title="${RES_NAMES[r]}">${resIcon(r)}</span>`).join("")}</span>`;
    html += `<div class="statline"><b>${E(i, F.residents)}</b> of ${E(i, F.beds)} beds taken · 2 beds for each good, 3 past the third</div>`;
    if (owner === ME || observe) {
      html += `<div class="statline">Has ${have.length ? icons(have) : "nothing yet"}</div>`;
      html += wants.length ? `<div class="statline">Wants ${icons(wants)} <span class="muted">(any ${wants.length > 1 ? `${house_room(k, goods)} of these` : "one"})</span></div>` : `<div class="statline">Has every good a ${NAMES[k]} can use.</div>`;
      if (owner === ME) html += houseTierLine(k, goods, E(i, F.residents), E(i, F.beds), id);
    }
  } else if (slotsOf(k, 1).length) {
    const need = stat(k, 7), takes = slotsOf(k, 2);
    html += `<div class="statline">${takes.length ? `Takes <span class="cost inline">${slotsHtml(takes, false)}</span>, makes` : "Makes"} <span class="cost inline">${slotsHtml(slotsOf(k, 1), false)}</span>${need ? ` · workers <b>${E(i, F.residents)}</b> of ${need}` : ""}</div>`;
    if (owner === ME && (E(i, F.flags) & 256)) html += `<div class="statline bad">Short of ${takes.map(([r]) => RES_NAMES[r]).join(" and ")}: it makes nothing until enough is free.</div>`;
    else if (owner === ME && (E(i, F.flags) & 64)) html += `<div class="statline bad">Paused: it makes nothing and hires nobody. Press Resume, or send workers here with a right-click.</div>`;
    else if (E(i, F.flags) & 32) html += `<div class="statline bad">Waiting for workers: when someone is free in the town square, they come.</div>`;
  } else if (k === K.MissileSilo) {
    const st = W.silo_state(id);
    html += st === 1 ? `<div class="statline">Arming a nuke · ${Math.floor(E(i, F.prog) * 100)}%</div><div class="bar prog"><i style="width:${E(i, F.prog) * 100}%"></i></div>`
      : st === 2 ? `<div class="statline">A nuke is armed: Launch (Z), then click a target.</div>` : `<div class="statline">Empty: Arm a nuke (Z).</div>`;
  } else if (TRAINS[k] && W.queue_len(id) > 0 && E(i, F.residents) === 0) {
    html += `<div class="statline">Waiting for a recruit from the town square.</div>`;
  }
  if (k === K.Capitol && owner === ME && !(E(i, F.flags) & 2)) {
    // Newcomers: how soon the next one turns up, and the cap (beds).
    const all = W.people(4), beds = W.people(1), next = W.next_arrival();
    html += `<div class="statline">People <b>${all}</b> of ${beds} beds</div>`;
    html += next >= 0
      ? `<div class="statline">Next newcomer in the town square · ${Math.floor(next * 100)}%</div><div class="bar prog"><i style="width:${next * 100}%"></i></div>`
      : `<div class="statline bad">Every bed is taken: nobody new comes. Build huts, and give them food.</div>`;
  }
  info.innerHTML = html;
  if (isBld(k) && (owner === ME || observe) && W.queue_len(id) > 0) {
    const q = W.queue_len(id);
    const line = document.createElement("div"); line.className = "statline";
    line.innerHTML = `Training ${NAMES[W.queue_kind(id, 0)]} · ${Math.floor(E(i, F.prog) * 100)}%`;
    const bar = document.createElement("div"); bar.className = "bar prog"; bar.innerHTML = `<i style="width:${E(i, F.prog) * 100}%"></i>`;
    const row = document.createElement("div"); row.className = "queue";
    for (let n = 0; n < q; n++) {
      const b = document.createElement("button"); b.title = "Click to cancel the last unit in the queue";
      b.append(iconEl(W.queue_kind(id, n), ME, 32));
      b.onclick = () => issue({ c: 5, ids: [id] });
      row.append(b);
    }
    info.append(line, bar, row);
  }
  panel.append(por, info);
}

function cmdButton(label, key, onClick, opts = {}) {
  const b = document.createElement("button");
  b.className = "cbtn" + (opts.glyph ? " glyph" : "") + (opts.poor ? " poor" : "") + (opts.locked ? " locked" : "");
  if (opts.icon) b.append(opts.icon); else b.append(document.createTextNode(opts.glyph || ""));
  if (key) { const kb = document.createElement("kbd"); kb.textContent = key; b.append(kb); }
  // What it makes: the resource icons in the corner.
  if (opts.badge) { const bd = document.createElement("span"); bd.className = "badge"; bd.innerHTML = opts.badge; b.append(bd); }
  b.setAttribute("aria-label", label);
  b.onclick = onClick;
  b.onmouseenter = () => showTip(opts.tip || `<h4>${label}</h4>`);
  b.onmouseleave = hideTip;
  b.dataset.key = key || "";
  return b;
}
function showTip(html) { const t = $("tip"); t.innerHTML = html; t.hidden = false; }
function hideTip() { $("tip").hidden = true; }

let cmdKeys = {};
let cmdHeld = false; // a pointer is down on the command buttons
$("cmd").addEventListener("pointerdown", () => { cmdHeld = true; });
window.addEventListener("pointerup", () => { cmdHeld = false; });
window.addEventListener("pointercancel", () => { cmdHeld = false; });
function renderCommands(sel) {
  const box = $("cmd");
  const tip = $("tip");
  box.replaceChildren(tip);
  cmdKeys = {};
  const mine = sel.filter(i => E(i, F.owner) === ME);
  if (!mine.length || observe) return;
  const kinds = new Set(mine.map(i => E(i, F.kind)));
  const add = (b, key, fn) => { box.append(b); if (key) cmdKeys[key.toLowerCase()] = fn; };
  const unitTip = k => {
    let h = `<h4>${NAMES[k]}</h4>${costHtml(k)}<p>${DESC[k] || ""}</p>`;
    const makes = slotsOf(k, 1), takes = slotsOf(k, 2);
    if (makes.length) h += `<p>Makes <span class="cost inline">${slotsHtml(makes, false)}</span></p>`;
    if (takes.length) h += `<p>Takes <span class="cost inline">${slotsHtml(takes)}</span> to do it</p>`;
    // Everything it needs before it works: workers, builders, a deposit, other buildings, an era.
    const needs = [], workers = stat(k, 7), builders = stat(k, 9);
    if (workers > 0) needs.push(`${workers} ${workers === 1 ? "worker" : "workers"} to run it`);
    if (isBld(k) && builders > 1) needs.push(`${builders} builders to raise it`);
    const dep = W.kind_deposit(k);
    if (dep >= 0) needs.push(`a spot next to ${DEP_NAMES[dep]}`);
    for (let n = 0, q; (q = W.requires(k, n)) >= 0; n++) needs.push(`<span class="${W.has_built(q) ? "" : "short"}">${NAMES[q]}</span>`);
    if (W.kind_era(k) > W.era()) needs.push(`<span class="short">the ${ERA_NAMES[W.kind_era(k)]} era (${W.era_progress(1)} ${HOUSE_NAMES[W.kind_era(k)].toLowerCase()}s; you have ${W.era_progress(0)})</span>`);
    if (needs.length) h += `<p>Needs ${needs.join(", ")}.</p>`;
    return h;
  };
  // The resources a building makes, as small icons on its button (up to three:
  // the Capitol makes four of the basics, which is too many to show).
  const badgeOf = k => { const m = slotsOf(k, 1); return isBld(k) && m.length && m.length <= 3 ? m.map(([r]) => resIcon(r)).join("") : ""; };

  if (kinds.has(K.Worker) || kinds.has(K.Capitol)) {
    const pages = buildPages();
    if (pages.length > 1) {
      const turn = d => { buildPage = (buildPage + d + pages.length) % pages.length; selKey = ""; Sfx.ui("select"); };
      for (const e of pages) {
        // Shift and a key: Shift+E the Ancient page, Shift+R the Medieval
        // one, … (the hotkeys after Q, which with Shift is Delete), or Tab and
        // Shift+Tab to step through them.
        const key = "⇧" + PAGE_KEYS[e + 1];
        const fn = () => { buildPage = e; selKey = ""; Sfx.ui("select"); };
        const b = cmdButton(`${ERA_NAMES[e]} buildings`, key, fn,
          { glyph: ["I", "II", "III", "IV", "V", "VI"][e], locked: e > W.era(),
            tip: `<h4>${ERA_NAMES[e]} buildings</h4><p>Shift+${PAGE_KEYS[e + 1]}, or Tab for the next page and Shift+Tab to go back.</p>` });
        b.classList.add("page");
        if (e === buildPage) b.classList.add("on");
        add(b, key, fn);
      }
      cmdKeys["tab"] = () => turn(1);
      cmdKeys["⇧tab"] = () => turn(-1);
    }
    for (const [k, key] of buildMenu()) {
      const fn = () => startPlacing(k);
      const locked = isBld(k) && !W.unlocked(k);
      add(cmdButton(`Build ${NAMES[k]}`, key, fn, { icon: iconEl(k, ME, 48), badge: badgeOf(k), poor: !canAfford(k), locked, tip: unitTip(k) }), key, fn);
    }
  }
  const producers = mine.filter(i => TRAINS[E(i, F.kind)] && !(E(i, F.flags) & 2));
  const trainable = new Set(producers.flatMap(i => TRAINS[E(i, F.kind)]));
  for (const k of trainable) {
    const key = TRAIN_KEYS[[...trainable].indexOf(k)];
    const fn = () => doTrain(k);
    add(cmdButton(`Train ${NAMES[k]}`, key, fn, { icon: iconEl(k, ME, 48), poor: !canAfford(k), locked: W.kind_era(k) > W.era(), tip: unitTip(k) + `<p>Right-click the map to set a rally point.</p>` }), key, fn);
  }
  const hasUnits = mine.some(i => !isBld(E(i, F.kind)));
  // Producers: pause (their workers go to the town square) or resume.
  const workplaces = mine.filter(i => isBld(E(i, F.kind)) && stat(E(i, F.kind), 7) > 0 && !(E(i, F.flags) & 2));
  if (workplaces.length && !hasUnits) {
    const paused = workplaces.every(i => E(i, F.flags) & 64);
    const ids = workplaces.map(i => E(i, F.id));
    const fn = () => { issue({ c: 10, ids, a: paused ? 1 : 0 }); Sfx.ui("command", 1); selKey = ""; };
    add(cmdButton(paused ? "Resume" : "Pause", "Z", fn, { glyph: paused ? "▶" : "❚❚", tip: paused
      ? "<h4>Resume</h4><p>Hire workers again: free workers from the town square come.</p>"
      : "<h4>Pause</h4><p>Its workers go back to the town square. It keeps its slots but makes nothing.</p>" }), "Z", fn);
  }
  box.classList.toggle("dense", box.children.length > 15 && box.children.length <= 22);
  box.classList.toggle("denser", box.children.length > 22 && box.children.length <= 36);
  box.classList.toggle("densest", box.children.length > 36);
  // A missile silo: arm a nuke, or launch the armed one (both Z).
  const silo = mine.find(i => E(i, F.kind) === K.MissileSilo && !(E(i, F.flags) & 2));
  if (silo != null && !hasUnits) {
    const id = E(silo, F.id), st = W.silo_state(id);
    if (st === 0) {
      const fn = () => { const code = issue({ c: 11, ids: [id] }); if (code) { toast(explain(code), "bad"); Sfx.ui("error"); } else Sfx.ui("queued"); selKey = ""; };
      add(cmdButton("Arm a nuke", "Z", fn, { glyph: "☢", tip: `<h4>Arm a nuke</h4><p>Holds 2 uranium and 2 explosives until it's launched, and takes ${W.nuke_numbers(0) / 60} minutes.</p>` }), "Z", fn);
    } else if (st === 2) {
      const fn = () => { aimSilo = id; amode = true; placing = null; updateCursor(); };
      add(cmdButton("Launch", "Z", fn, { glyph: "🚀", tip: `<h4>Launch the nuke</h4><p>Click where it should fall. It lands ${W.nuke_numbers(1)} seconds later, destroying everything within ${W.nuke_numbers(2)} tiles, yours too. Everyone sees it coming. An enemy Air Defense within ${W.nuke_numbers(3)} tiles of the target shoots it down.</p>` }), "Z", fn);
    }
  }
  // Houses: upgrade the ones that are ready (it holds more materials, so
  // it's your call).
  const homes = mine.filter(i => HOUSE_UP[E(i, F.kind)] && !(E(i, F.flags) & 2));
  if (homes.length && !hasUnits && !workplaces.length) {
    const ids = homes.map(i => E(i, F.id)), states = ids.map(id => W.house_upgrade_state(id));
    const ready = states.filter(s => s === 0).length, k = E(homes[0], F.kind), [up, mats] = HOUSE_UP[k];
    const fn = () => { const code = issue({ c: 14, ids }); if (code) { toast(explain(code), "bad"); Sfx.ui("error"); } else Sfx.ui("place"); selKey = ""; };
    const why = ready ? "" : explain(states.find(s => s !== 11) ?? 11);
    add(cmdButton(ready > 1 ? `Upgrade ${ready} houses` : `Upgrade to ${NAMES[up]}`, "Z", fn, { icon: iconEl(up, ME, 48), locked: !ready,
      tip: `<h4>Upgrade${homes.length > 1 ? ` (${ready} of ${homes.length} ready)` : ""}</h4><p>A ${NAMES[up]} has more beds and can use more goods. It holds ${mats}.</p>${why ? `<p class="short">${why}.</p>` : ""}` }), "Z", fn);
  }
  // Demolish your buildings (Delete or Shift+Q, at once), or disband your
  // units (the same keys, pressed twice: an army is hard to get back).
  const doomed = mine.filter(i => E(i, F.kind) !== K.Capitol && isBld(E(i, F.kind)) === !hasUnits).map(i => E(i, F.id));
  if (doomed.length) {
    const key = doomed.join(","), armed = hasUnits && demolishArm && demolishArm.key === key && performance.now() - demolishArm.t < 4000;
    const what = hasUnits ? "Disband" : "Demolish";
    const fn = () => {
      if (!hasUnits || (demolishArm && demolishArm.key === key && performance.now() - demolishArm.t < 4000)) { demolishArm = null; issue({ c: 9, ids: doomed }); Sfx.ui("place"); }
      else { demolishArm = { key, t: performance.now() }; toast(`Press ${what} again (Shift+Q) to disband ${doomed.length > 1 ? "them" : "it"}`); }
      selKey = "";
    };
    const tip = hasUnits
      ? "<h4>Disband</h4><p>Your selected units are gone: their slots and beds come free, and newcomers can take their place. Press twice (Shift+Q or Delete).</p>"
      : "<h4>Demolish</h4><p>Tear it down at once. Its slots and workers come free; anyone in a house or a training queue is lost. (Shift+Q or Delete.)</p>";
    add(cmdButton(armed ? `Really ${what.toLowerCase()}?` : what, "⇧Q", fn, { glyph: armed ? "!" : "⌧", tip }), "Delete", fn);
    cmdKeys["⇧q"] = fn;
  }
  if (hasUnits) { // every unit, workers too
    const fn = () => setAmode(true);
    add(cmdButton("Attack-move", "Z", fn, { glyph: "⚔︎", tip: "<h4>Attack-move</h4><p>Walk to a spot and fight anything met on the way.</p>" }), "Z", fn);
  }
  if (hasUnits) {
    const fn = () => issue({ c: 3, ids: myIds(false) });
    add(cmdButton("Stop", "X", fn, { glyph: "■", tip: "<h4>Stop</h4><p>Drop the current order.</p>" }), "X", fn);
  }
}

function toast(msg, cls = "") {
  const t = document.createElement("div"); t.className = "toast " + cls; t.textContent = msg;
  $("toasts").append(t);
  setTimeout(() => t.remove(), 3300);
  while ($("toasts").children.length > 4) $("toasts").firstChild.remove();
}
// Error codes from Rust (`CmdError::code` in game.rs).
let demolishArm = null;
// A house's goods: which it has, and which it could still take (house goods
// of its era or earlier it doesn't have, while it has room for more).
function houseWants(k, goods) {
  const tier = stat(k, 10), max = W.house_max_goods(tier);
  const have = [], could = [];
  for (let r = 0; r < W.n_res(); r++) {
    if (goods >> r & 1) have.push(r);
    else if (W.is_house_good(r) && W.res_era(r) <= tier) could.push(r);
  }
  return { have, wants: have.length < max ? could : [] };
}
// The good a house will get next: one it wants that's left over, if any,
// else the first it wants (undefined when it has all it can use).
function nextWant(k, goods) {
  const { wants } = houseWants(k, goods);
  return wants.find(r => free(r) - W.housed(r) > 0) ?? wants[0];
}
// The kind a house can be upgraded to, and the extra materials it takes.
const HOUSE_UP = { [K.Hut]: [K.Cottage, "1 more wood and 1 stone"], [K.Cottage]: [K.Townhouse, "1 more stone and 2 brick"],
  [K.Townhouse]: [K.Tenement, "2 more brick"], [K.Tenement]: [K.Apartment, "2 steel"], [K.Apartment]: [K.TowerBlock, "1 more steel and 1 aluminum"] };
// What a house needs to be upgraded (by you: Upgrade, Z). Houses never shrink.
function houseTierLine(k, goods, residents, beds, id) {
  const tier = stat(k, 10), n = popcount(goods), max = W.house_max_goods(tier), t = HOUSE_UP[k];
  if (!t || W.era_progress(2) < tier + 1) return "";
  const [up, mats] = t, st = W.house_upgrade_state(id);
  if (st === 0) return `<div class="statline good">Ready: upgrade it to a ${NAMES[up]} (Z), holding ${mats}.</div>`;
  if (W.era() + 1 < tier + 1) return `<div class="statline muted">Can be upgraded to a ${NAMES[up]} in the ${ERA_NAMES[tier]} era.</div>`;
  const need = [];
  if (residents < beds || beds === 0) need.push("every bed taken");
  if (n < max) need.push(`all ${max} goods`);
  return `<div class="statline muted">${need.length ? `Can be upgraded to a ${NAMES[up]} with ${need.join(" and ")} (and ${mats}).` : `Can be upgraded to a ${NAMES[up]} once ${mats} are free.`}</div>`;
}
function house_room(k, goods) { return W.house_max_goods(stat(k, 10)) - popcount(goods); }
const popcount = v => { let n = 0; for (; v; v >>>= 1) n += v & 1; return n; };
function explain(code) {
  if (code >= 2000) return `Build a ${NAMES[code - 2000]} first`;
  if (code >= 1000) {
    const r = code - 1000, p = producerOf(r);
    return `Not enough ${RES_NAMES[r]}` + (p != null ? `: build another ${NAMES[p]}` : "");
  }
  if (code >= 20 && code < 30) return `It has to be next to ${DEP_NAMES[code - 20]}`;
  if (code >= 30 && code < 40) return `Not until the ${ERA_NAMES[code - 30]} era`;
  return { 10: "That queue is full", 11: "Select a building that can train this", 12: "Can't build there",
    13: "Nobody is free in the town square to train", 14: "Not yet: it needs every bed taken and all the goods it can use" }[code] || "Can't do that";
}
// Why `k` can't be had right now, as an error code, or 0.
function shortCode(k) { const r = W.short_of(k); return r >= 0 ? 1000 + r : 0; }

// ===========================================================================
// Commands. Everything the player tells the game goes through `issue`, as a
// small plain object: {c: code, ids: [...], x, y, a}. It runs at once. In
// multiplayer it's also handed to the client (net.js), which sends it to the
// host, stamped with this tick. (Codes: see `command` in lib.rs.)
// On the wire, and everywhere after `issue`, a command is a flat array of
// numbers: [code, arg, x, y, ...ids]. Compact (it has to fit, with others,
// into 4 KiB messages) and shallow. x and y are rounded to 1/100 of a tile
// once, here, so every computer applies exactly the same numbers.
function issue(cmd) {
  const r2 = v => Math.round((v || 0) * 100) / 100;
  if (observe) return 0; // watching: nothing to command
  const arr = [cmd.c, cmd.a || 0, r2(cmd.x), r2(cmd.y), ...(cmd.ids || []).slice(0, 60)];
  const code = applyCmd(ME, arr);
  if (mp) mp.queue(arr); // multiplayer records the confirmed order instead (mpHooks.confirmed)
  else Rec.mine(arr);
  return code;
}
// Run one command on whichever copy of the game is current. No sounds, no
// messages: multiplayer also uses this to replay commands.
function applyCmd(owner, arr) {
  const [c, a, x, y] = arr, ids = arr.slice(4);
  if ((c === 7 || c === 13 || c === 15) && owner !== 0) return 0; // only the host's system messages may do that
  const p = W.scratch_ptr() >>> 2, buf = new Uint32Array(mem.buffer);
  ids.forEach((id, n) => { buf[p + n] = id; });
  return W.command(owner, c, ids.length, x, y, a);
}
// How the multiplayer client (net.js) reaches the game.
const mpHooks = {
  apply: applyCmd,
  // Carry the selection over a correction: same ids, and say whether any of
  // them now means something else. Units the correction moved slide to
  // their new place instead of jumping (R3.nudges, used in render3d.js).
  keep() { readWorld(); return selection().map(i => [E(i, F.id), E(i, F.kind)]); },
  restore(kept, alpha) {
    readWorld();
    const t = performance.now();
    for (let i = 0; i < entCount; i++) {
      if (isBld(E(i, F.kind))) continue;
      const id = E(i, F.id), o = R3.objs.get(id);
      if (!o || o.x === undefined) continue;
      const dx = o.x - (E(i, F.px) + (E(i, F.x) - E(i, F.px)) * alpha);
      const dy = o.y - (E(i, F.py) + (E(i, F.y) - E(i, F.py)) * alpha);
      if (Math.abs(dx) + Math.abs(dy) > 0.01 && Math.abs(dx) + Math.abs(dy) < 4) R3.nudges.set(id, { dx, dy, t });
    }
    setSelection(kept.map(k => k[0]));
    const now = new Map(selection().map(i => [E(i, F.id), E(i, F.kind)]));
    return kept.some(([id, k]) => now.has(id) && now.get(id) !== k) || now.size !== kept.length;
  },
  pace(rate) { paceChanged(rate); },
  // Someone left: say so at once (the computer takes over on the next tick,
  // which, while paused, may be a while).
  left(slot) { announceLeft(slot); },
  system(cmd) {
    const who = Rec.meta && Rec.meta.who;
    if (cmd[0] === 7) { announceLeft(cmd[1]); announced.delete(cmd[1]); if (who) who[cmd[1]] = "computer"; delete pnames[cmd[1]]; if (mp && mp.server) publishLobby(); }
    if (cmd[0] === 15) cheatsToast(cmd[1]);
    if (cmd[0] === 13) { if (cmd[1] !== ME) toast(`${pnames[cmd[1]] || "A spectator"} takes over ${PNAME[cmd[1]] || "a seat"} from the computer.`, "good"); if (who) who[cmd[1]] = "human"; }
  },
  // A tick's commands in their final order: what replays and spectators get.
  confirmed(k, bundle) { Rec.bundle(k, bundle); },
};
// Commands arriving from the network are someone else's input: check the shape.
function cleanCmd(arr) {
  if (!Array.isArray(arr) || arr.length < 4 || arr.length > 64) return null;
  if (!arr.every(v => typeof v === "number" && Number.isFinite(v))) return null;
  const c = arr[0] | 0;
  if (c < 1 || c > 15) return null;
  return [c, arr[1] >>> 0, arr[2], arr[3], ...arr.slice(4).map(v => v >>> 0)];
}
const myIds = (buildings = null) => selection().filter(i => E(i, F.owner) === ME && (buildings === null || isBld(E(i, F.kind)) === buildings)).map(i => E(i, F.id));

function doTrain(k) {
  if (!canAfford(k)) { toast(explain(shortCode(k)), "bad"); Sfx.ui("error"); return; }
  const code = issue({ c: 4, ids: myIds(true), a: k });
  if (code) { toast(explain(code), "bad"); Sfx.ui("error"); } else Sfx.ui("queued");
  selKey = "";
}
function startPlacing(k) {
  if (isBld(k) && !W.unlocked(k)) { let n = 0, q; while ((q = W.requires(k, n++)) >= 0) if (!W.has_built(q)) break; toast(explain(2000 + q), "bad"); Sfx.ui("error"); return; }
  if (!canAfford(k)) { toast(explain(shortCode(k)), "bad"); Sfx.ui("error"); return; }
  placing = k; amode = false; updateCursor();
}
function launchAt(w) {
  if (w && aimSilo != null) {
    const code = issue({ c: 12, ids: [aimSilo], x: w.x, y: w.y });
    if (code) { toast(explain(code), "bad"); Sfx.ui("error"); } else marker(w, 2);
  }
  setAmode(false);
}
function setAmode(on) { amode = on; placing = null; if (!on) aimSilo = null; updateCursor(); }
function updateCursor() {
  lastCursorCheck = 0; cursorCode = -1; // refresh the mouse cursor now
  view.classList.toggle("placing", placing != null);
  view.classList.toggle("amode", amode);
  const h = $("hint");
  if (placing != null) { h.hidden = false; h.textContent = `Place ${NAMES[placing]}: click to build, Shift-click for more, right-click to cancel`; }
  else if (amode && aimSilo != null) { h.hidden = false; h.textContent = "Launch the nuke: click where it should fall, right-click to cancel"; }
  else if (amode) { h.hidden = false; h.textContent = "Attack-move: click a destination, right-click to cancel"; }
  else h.hidden = true;
}
function setSelection(ids) {
  const p = W.scratch_ptr() >>> 2;
  const buf = new Uint32Array(mem.buffer);
  ids.slice(0, 512).forEach((id, n) => { buf[p + n] = id; });
  W.select_ids(Math.min(ids.length, 512));
  readWorld(); selKey = "";
}

// ===========================================================================
// Input
view.addEventListener("contextmenu", e => e.preventDefault());
mini.addEventListener("contextmenu", e => e.preventDefault());

function localPos(e) { const r = view.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

// Where a building would go for the cursor at screen (sx, sy).
function placementSpot(sx, sy) {
  const w = screenToGround(sx, sy);
  if (!w) return null;
  const size = stat(placing, 6);
  return { tx: Math.round(w.x - size / 2), ty: Math.round(w.y - size / 2) };
}

// Box select happens here in JS: with a tilted camera, a box on screen is
// not a rectangle on the map, so we test each unit's position on screen.
function boxSelect(x0, y0, x1, y1, add, kindFilter = -1) {
  const lx = Math.min(x0, x1), hx = Math.max(x0, x1), ly = Math.min(y0, y1), hy = Math.max(y0, y1);
  const units = [], buildings = [];
  for (let i = 0; i < entCount; i++) {
    if (E(i, F.owner) !== ME) continue;
    const k = E(i, F.kind);
    if (kindFilter >= 0 && k !== kindFilter) continue;
    const p = entScreen(i, false);
    if (!p || p.behind || p.x < lx || p.x > hx || p.y < ly || p.y > hy) continue;
    (isBld(k) ? buildings : units).push(E(i, F.id));
  }
  let ids = units.length ? units : buildings;
  if (add) ids = [...new Set([...selection().filter(i => E(i, F.owner) === ME).map(i => E(i, F.id)), ...ids])];
  setSelection(ids);
}

let touch = null;
view.addEventListener("pointerdown", e => {
  if (!running) return;
  view.setPointerCapture(e.pointerId);
  const p = localPos(e); mouse.x = p.x; mouse.y = p.y; mouse.inside = true;
  if (e.pointerType === "touch") { touch = { x0: p.x, y0: p.y, cx: cam.x, cy: cam.y, moved: false }; return; }
  if (e.button === 1) { orbit = { x0: p.x, y0: p.y, yaw: cam.yaw, pitch: cam.pitch }; e.preventDefault(); return; }
  if (e.button === 2) {
    if (placing != null || amode) { placing = null; setAmode(false); return; }
    command(p);
    return;
  }
  if (e.button !== 0) return;
  if (placing != null) { tryPlace(p, e.shiftKey); return; }
  if (amode && aimSilo != null) { launchAt(screenToGround(p.x, p.y)); return; }
  if (amode) {
    const w = screenToGround(p.x, p.y);
    if (w) { issue({ c: 2, ids: myIds(false), x: w.x, y: w.y }); marker(w, 2); Sfx.ui("command", 2); }
    if (!e.shiftKey) setAmode(false);
    return;
  }
  drag = { x0: p.x, y0: p.y, moved: false, shift: e.shiftKey };
});
view.addEventListener("pointermove", e => {
  const p = localPos(e); mouse.x = p.x; mouse.y = p.y; mouse.inside = true;
  if (touch) {
    if (Math.hypot(p.x - touch.x0, p.y - touch.y0) > 10) touch.moved = true;
    if (touch.moved) {
      // Drag the map under your finger.
      const k = cam.dist / view._h * 1.6, c = Math.cos(cam.yaw), s = Math.sin(cam.yaw);
      const dx = -(p.x - touch.x0) * k, dy = -(p.y - touch.y0) * k;
      cam.x = touch.cx + dx * c + dy * s; cam.y = touch.cy - dx * s + dy * c; clampCam();
    }
    return;
  }
  if (orbit) { cam.yaw = orbit.yaw - (p.x - orbit.x0) * 0.008; cam.pitch = orbit.pitch + (p.y - orbit.y0) * 0.005; clampCam(); }
  if (drag && Math.hypot(p.x - drag.x0, p.y - drag.y0) > 5) drag.moved = true;
});
view.addEventListener("pointerleave", () => { mouse.inside = false; });

// The cursor shows what a right-click would do: move, attack, chop, mine...
// Checked a few times a second, not on every mouse move (it raycasts).
let lastCursorCheck = 0, cursorCode = -1;
function updateHoverCursor(now) {
  if (now - lastCursorCheck < 90) return;
  lastCursorCheck = now;
  let code = 0;
  if (placing != null) code = -2;
  else if (amode) code = 2;
  else if (mouse.inside && !drag && !orbit) {
    const ids = myIds();
    if (ids.length) {
      const w = pickAt(mouse.x, mouse.y);
      if (w) code = intentAt(ids, w.x, w.y);
    }
  }
  if (code === cursorCode) return;
  cursorCode = code;
  view.style.cursor = code === -2 ? "crosshair" : CURSORS[code] || "default";
}
view.addEventListener("pointerup", e => {
  const p = localPos(e);
  if (touch) { if (!touch.moved) tap(p); touch = null; return; }
  if (orbit && e.button === 1) { orbit = null; return; }
  if (!drag || e.button !== 0) return;
  if (drag.moved) {
    boxSelect(drag.x0, drag.y0, p.x, p.y, drag.shift);
  } else {
    const now = performance.now();
    const dbl = now - lastClick.t < 320 && Math.hypot(p.x - lastClick.x, p.y - lastClick.y) < 8;
    lastClick = { t: now, x: p.x, y: p.y };
    const hit = pickAt(p.x, p.y);
    const id = hit ? W.select_at(hit.x, hit.y, drag.shift ? 1 : 0) : -1;
    if (!hit) W.clear_selection();
    if (dbl && id >= 0) {
      readWorld();
      const i = byId.get(id);
      if (i != null && E(i, F.owner) === ME) boxSelect(0, 0, view._w, view._h, false, E(i, F.kind));
    }
  }
  drag = null; readWorld(); selKey = "";
  if (selection().some(i => E(i, F.owner) === ME)) Sfx.ui("select");
});

function command(p) {
  const w = pickAt(p.x, p.y);
  if (w) rightClickAt(w);
}
function rightClickAt(w) {
  const ids = myIds();
  if (!ids.length) return;
  const what = intentAt(ids, w.x, w.y); // decided before the order changes anything
  issue({ c: 1, ids, x: w.x, y: w.y });
  if (what) { marker(w, what); Sfx.ui("command", what === 2 ? 2 : 1); }
}
// What a right-click would do there (see `intent` in lib.rs).
function intentAt(ids, x, y) {
  const p = W.scratch_ptr() >>> 2, buf = new Uint32Array(mem.buffer);
  ids.slice(0, 60).forEach((id, n) => { buf[p + n] = id; });
  return W.intent(Math.min(ids.length, 60), x, y);
}
function marker(w, code) {
  const col = { 1: "#9cf27f", 2: "#ff6a50", 4: "#f2cd5c", 5: "#efe6d1" }[code] || "#f2cd5c";
  addMarker(w.x, w.y, col);
}
function tryPlace(p, keep) {
  const spot = placementSpot(p.x, p.y);
  if (!spot) return;
  if (!W.can_place(placing, spot.tx, spot.ty)) {
    const dep = W.kind_deposit(placing);
    toast(explain(dep >= 0 && W.can_place_ignoring_deposit(placing, spot.tx, spot.ty) ? 20 + dep : 12), "bad"); Sfx.ui("error"); return;
  }
  if (!canAfford(placing)) { toast(explain(shortCode(placing)), "bad"); Sfx.ui("error"); return; }
  const code = issue({ c: 6, ids: myIds(false), x: spot.tx, y: spot.ty, a: placing });
  if (code) { toast(explain(code), "bad"); Sfx.ui("error"); return; }
  Sfx.ui("place");
  if (!keep || !canAfford(placing)) { placing = null; updateCursor(); }
  selKey = "";
}
// Touch: tap your own things to select them; tap elsewhere to command.
function tap(p) {
  if (placing != null) { tryPlace(p, false); return; }
  if (amode && aimSilo != null) { launchAt(screenToGround(p.x, p.y)); return; }
  if (amode) { const w = screenToGround(p.x, p.y); if (w) { issue({ c: 2, ids: myIds(false), x: w.x, y: w.y }); marker(w, 2); } setAmode(false); return; }
  const hit = pickAt(p.x, p.y);
  if (!hit) return;
  const own = hit.id != null && byId.has(hit.id) && E(byId.get(hit.id), F.owner) === ME;
  if (own || selection().filter(i => E(i, F.owner) === ME).length === 0) W.select_at(hit.x, hit.y, 0);
  else command(p);
  readWorld(); selKey = "";
}

view.addEventListener("wheel", e => {
  e.preventDefault();
  cam.dist *= Math.exp(e.deltaY * 0.0012);
  clampCam();
}, { passive: false });

let miniDrag = false;
function miniMove(e) {
  const r = mini.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * MW, y: ((e.clientY - r.top) / r.height) * MH };
}
mini.addEventListener("pointerdown", e => {
  if (!running) return;
  const w = miniMove(e);
  if (e.button === 2) { if (amode || placing != null) { placing = null; setAmode(false); return; } rightClickAt(w); return; }
  // Attack-move (Z, then a click on the minimap), or a nuke's target.
  if (e.button === 0 && amode && aimSilo != null) { launchAt(w); return; }
  if (e.button === 0 && amode) {
    issue({ c: 2, ids: myIds(false), x: w.x, y: w.y }); marker(w, 2); Sfx.ui("command", 2);
    if (!e.shiftKey) setAmode(false);
    return;
  }
  miniDrag = true; mini.setPointerCapture(e.pointerId); centerOn(w.x, w.y);
});
mini.addEventListener("pointermove", e => { if (miniDrag) { const w = miniMove(e); centerOn(w.x, w.y); } });
mini.addEventListener("pointerup", () => { miniDrag = false; });

// Camera keys are tracked by physical key (e.code), so WASD works on any
// keyboard layout. Everything else uses the character typed (e.key).
const SCROLL_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
window.addEventListener("keydown", e => {
  if (!running) return;
  if (e.key === "F8") { e.preventDefault(); toggleTrace(); return; }
  if (e.key === "Enter" && Chat.available() && !e.repeat) { e.preventDefault(); Chat.show(); return; }
  if (SCROLL_KEYS.has(e.code)) { keys.add(e.code); e.preventDefault(); return; }
  const k = e.key.toLowerCase();
  if (e.key === "Escape" && !$("techScreen").hidden) { $("techScreen").hidden = true; return; }
  if (!$("loadScreen").hidden) { if (e.key === "Escape") closeLoadScreen(); return; }
  if (!$("outScreen").hidden) return; // choose first: watch or leave
  if (e.key === "Escape") { if (placing != null || amode) { placing = null; setAmode(false); } else { W.clear_selection(); selKey = ""; } return; }
  if (/^Digit[1-9]$/.test(e.code)) {
    const g = e.code.slice(5);
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+N: the selection becomes group N.
      e.preventDefault();
      groups[g] = selection().filter(i => E(i, F.owner) === ME).map(i => E(i, F.id));
      toast(`Group ${g} set`);
    } else if (e.shiftKey) {
      // Shift+N: add the selection to group N (no one twice).
      e.preventDefault();
      const mine = selection().filter(i => E(i, F.owner) === ME).map(i => E(i, F.id));
      groups[g] = [...new Set([...(groups[g] || []), ...mine])];
      toast(`Added to group ${g}`);
    } else if (groups[g]) {
      const now = performance.now();
      if (groups._last === g && now - groups._t < 400) focusSelection();
      groups._last = g; groups._t = now;
      setSelection(groups[g]);
    }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && k === "s") { e.preventDefault(); if (!mp) saveGame(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === "p") { togglePause(); return; }
  if (k === "k") { toggleTech(); return; }
  if (k === "m") { Sfx.setMuted(!Sfx.muted); syncSoundBtn(); return; }
  if (k === "h") { const i = findOwn(K.Capitol); if (i != null) { setSelection([E(i, F.id)]); centerOn(E(i, F.x), E(i, F.y)); } return; }
  if (k === "." || k === ",") { const id = W.free_workers(); if (id >= 0) { readWorld(); centerOn(W.campfire(0), W.campfire(1)); selKey = ""; } else toast("Nobody is free in the town square"); return; }
  if (k === " ") { e.preventDefault(); if (lastAlert && performance.now() - lastAlert.t < 15000) centerOn(lastAlert.x, lastAlert.y); else focusSelection(); return; }
  const ck = e.shiftKey && cmdKeys["⇧" + k] ? "⇧" + k : k;
  if (cmdKeys[ck]) { cmdKeys[ck](); e.preventDefault(); }
});
window.addEventListener("keyup", e => keys.delete(e.code));
window.addEventListener("blur", () => { keys.clear(); mouse.inside = false; page.inside = false; });

function findOwn(kind) { for (let i = 0; i < entCount; i++) if (E(i, F.owner) === ME && E(i, F.kind) === kind) return i; return null; }
function focusSelection() {
  const s = selection(); if (!s.length) return;
  let x = 0, y = 0; for (const i of s) { x += E(i, F.x); y += E(i, F.y); }
  centerOn(x / s.length, y / s.length);
}

// WASD / arrows / screen edges move the camera, relative to where it faces.
function scrollCamera(dt) {
  let dx = 0, dy = 0;
  if (keys.has("ArrowLeft") || keys.has("KeyA")) dx--;
  if (keys.has("ArrowRight") || keys.has("KeyD")) dx++;
  if (keys.has("ArrowUp") || keys.has("KeyW")) dy--;
  if (keys.has("ArrowDown") || keys.has("KeyS")) dy++;
  // The edges of the browser window (over the top bar and panels too), not
  // of the map view; not while a card covers the game.
  if (page.inside && !drag && !orbit && !touch && matchMedia("(pointer: fine)").matches && !document.querySelector(".overlay:not([hidden])")) {
    const m = 10, w = window.innerWidth, h = window.innerHeight;
    if (page.x < m) dx--; if (page.x > w - m) dx++;
    if (page.y < m) dy--; if (page.y > h - m) dy++;
  }
  if (!dx && !dy) return;
  const v = cam.dist * 1.1 * dt, c = Math.cos(cam.yaw), s = Math.sin(cam.yaw);
  cam.x += (dx * c + dy * s) * v;
  cam.y += (-dx * s + dy * c) * v;
  clampCam();
}

// ===========================================================================
// Events from the simulation. Numbers match `enum Ev` in game.rs.
const EV = { Alert: 1, Trained: 2, Built: 3, Lost: 4, Death: 5, Melee: 6, Shoot: 7, Hammer: 9, ArrowHit: 11, Short: 12, Eliminated: 14,
  Upgraded: 15, Downgraded: 16, EraReached: 17, NukeArmed: 18, NukeLaunched: 19, NukeDetonated: 20,
  NukeIntercepted: 22, SiloBuilt: 23, NukeArming: 24, Cheats: 25 };
function handleEvents() {
  const n = W.take_events();
  if (!n) return;
  // Copy out: playing sounds reads fog memory, and wasm memory could move.
  const ev = f32(W.events_ptr(), n).slice();
  for (let j = 0; j < n; j += 4) {
    const type = ev[j], x = ev[j + 1], y = ev[j + 2], d = ev[j + 3];
    // Watching: the sounds of the world, but none of the messages meant for a player.
    if (observe) {
      if (type === EV.Eliminated) toast(`${pnc(d)} is out of the game.`);
      else if (type === EV.EraReached) toast(`${pnc(d >> 4)} has reached the ${ERA_NAMES[d & 15]} era.`);
      else if (type === EV.SiloBuilt) toast(`${pnc(d)} has built a missile silo.`);
      else if (type === EV.NukeArming) toast(`${pnc(d)} is arming a nuke.`);
      else if (type === EV.NukeArmed) toast(`${pnc(d)} has a nuke ready.`);
      else if (type === EV.NukeLaunched) toast(`${pnc(d)} has launched a nuke!`);
      else if (type === EV.NukeIntercepted) toast(`An air defense shot down ${pnc(d)}'s nuke.`);
      if (type === EV.NukeDetonated) { Sfx.ui("nuke"); nukeFlash(x, y); }
      if (type === EV.NukeLaunched || type === EV.NukeIntercepted) Sfx.ui("siren");
      if (type <= 4 || type >= 12) continue;
    }
    switch (type) {
      case EV.Alert:
        toast(isBld(d) ? `Your ${NAMES[d]} is under attack. Space to view.` : "Your people are under attack. Space to view.", "bad");
        lastAlert = { x, y, t: performance.now() };
        Sfx.ui("horn");
        break;
      case EV.Trained: Sfx.ui("trained"); break;
      case EV.Built: {
        // Say what this building unlocked, but only the first time.
        const opened = BUILD_MENU.map(([k]) => k).filter(k => W.unlocked(k) && !knownUnlocked.has(k));
        opened.forEach(k => knownUnlocked.add(k));
        toast(`${NAMES[d]} complete` + (opened.length ? `. You can now build: ${opened.map(k => NAMES[k]).join(", ")}` : ""), "good");
        Sfx.ui("built");
        break; }
      case EV.Lost: toast(`Your ${NAMES[d]} was destroyed`, "bad"); break;
      case EV.Death: { const kind = d % 100;
        if (isBld(kind)) Sfx.at("crumble", x, y, 200);
        else Sfx.at("death", x, y, 90, isMounted(kind));
        break; }
      case EV.Melee:
        // A bomber's bombs: a boom and a cloud where they land.
        if (d === K.Bomber) { Sfx.at("cannon", x, y, 40); gunSmoke(x, y, K.Cannon); }
        else Sfx.at("melee", x, y, 45, d);
        break;
      case EV.Shoot:
        if (isGun(d)) { Sfx.at(isBigGun(d) ? "cannon" : d === K.MachineGunner || d === K.Infantry || d === K.Fighter ? "mg" : "musket", x, y, 40); if (!isAir(d)) gunSmoke(x, y, d); }
        else Sfx.at("bow", x, y, 60, isBld(d));
        break;
      case EV.ArrowHit: Sfx.at("arrowHit", x, y, 50, d === 1); break;
      case EV.Hammer: Sfx.at("hammer", x, y, 90); break;
      case EV.Eliminated:
        if (d !== ME) toast(`${pnc(d)} has been eliminated.`, "good");
        break;
      case EV.Cheats: if (!mp) cheatsToast(d); break; // (online: when the host's command is confirmed)
      // Silos and nukes: everyone is told about everyone's.
      case EV.SiloBuilt:
        if (d !== ME) { toast(`Warning: ${pnc(d)} has built a missile silo.`, "bad"); Sfx.ui("horn"); lastAlert = { x, y, t: performance.now() }; }
        break;
      case EV.NukeArming:
        if (d !== ME) { toast(`Warning: ${pnc(d)} has started arming a nuke. It takes ${W.nuke_numbers(0) / 60} minutes. An Air Defense shoots one down.`, "bad"); Sfx.ui("horn"); lastAlert = { x, y, t: performance.now() }; }
        break;
      case EV.NukeArmed:
        if (d === ME) { toast("A nuke is armed. Select the silo and press Z to launch it.", "good"); Sfx.ui("trained"); }
        else { toast(`Warning: ${pnc(d)} has a nuke ready to launch.`, "bad"); Sfx.ui("siren"); lastAlert = { x, y, t: performance.now() }; }
        break;
      case EV.NukeIntercepted:
        toast(d === ME ? "Your nuke was shot down by an air defense." : `An air defense shot down ${pnc(d)}'s nuke.`, d === ME ? "bad" : "good");
        Sfx.at("cannon", x, y, 40); gunSmoke(x, y, K.Cannon);
        break;
      case EV.NukeLaunched:
        // Everyone is told, and shown where it will fall.
        toast(d === ME ? "Nuke launched. It lands in 20 seconds." : `${pnc(d)} has launched a nuke! It lands in 20 seconds: get out of the marked area.`, d === ME ? "good" : "bad");
        Sfx.ui("siren");
        lastAlert = { x, y, t: performance.now() };
        break;
      case EV.NukeDetonated:
        Sfx.ui("nuke");
        nukeFlash(x, y);
        break;
      case EV.Upgraded: { // (the count only when it's the kind of house the next era needs)
        const era = W.era(), got = W.era_progress(0), need = W.era_progress(1);
        toast(`A house grew into a ${NAMES[d]}` + (era < W.era_progress(2) && stat(d, 10) > era ? ` · ${got} of ${need} for the ${ERA_NAMES[era + 1]} era` : ""), "good");
        Sfx.at("hammer", x, y, 90);
        break; }
      case EV.EraReached: {
        const who = d >> 4, era = d & 15;
        if (who === ME) {
          const opened = BUILD_MENU.map(([k]) => k).filter(k => W.unlocked(k) && !knownUnlocked.has(k));
          opened.forEach(k => knownUnlocked.add(k));
          const units = Object.values(TRAINS).flat().filter(k => W.kind_era(k) === era);
          toast(`The ${ERA_NAMES[era]} era! New: ${opened.concat(units).map(k => NAMES[k]).join(", ")}`, "good");
          Sfx.ui("fanfare", true);
          selKey = "";
        } else {
          toast(`${pnc(who)} has reached the ${ERA_NAMES[era]} era.`, "bad");
        }
        break; }
      case EV.Short: {
        const p = producerOf(d);
        toast(`You hold more ${RES_NAMES[d]} than you make. Your newest units that need it are losing health` + (p != null ? `: build a ${NAMES[p]}.` : "."), "bad");
        Sfx.ui("starving");
        break; }
    }
  }
}


// ===========================================================================
// Main loop: fixed 20 Hz simulation, render every animation frame.
let ME = 1;          // which player this computer controls (2 = multiplayer guest)
let mp = null;       // the Lockstep, while a multiplayer game runs
let simTick = 0;     // ticks run so far (multiplayer counts turns with it)
let stalledSince = 0;

function loop(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  Watchers.pump(performance.now()); // spectators, also after the game has ended
  if (mp && Trace.cur && last) Trace.cur.maxFrameGap = Math.max(Trace.cur.maxFrameGap, Math.round(now - last));
  last = now;
  if (running) {
    const f0 = performance.now();
    scrollCamera(dt);
    if (mp) pumpMultiplayer(performance.now(), false);
    else if (watcher) { if (watcher.pump()) handleEvents(); }
    else if (Replay.on) { if (Replay.pump(dt)) handleEvents(); }
    else if (!paused) {
      acc += dt * 1000 * speed;
      let steps = 0;
      const most = Math.max(8, speed * 4);
      while (acc >= SIM_MS && steps < most) { W.tick(); simTick++; acc -= SIM_MS; steps++; }
      if (steps === most) acc = 0;
      if (steps) handleEvents();
      if (!Rec.done) Rec.ticks = simTick;
      // Handing a seat to a spectator: right after a tick, before any new command.
      if (pendingSeat && steps) {
        const p = pendingSeat; pendingSeat = null;
        if (canGiveSeats() && !W.defeated(p.slot)) { becomeServer(); if (mp.server.claim(p.slot, p.token)) claimed(p.slot, p.token); }
      }
    }
    const f1 = performance.now();
    readWorld();
    if (frame % 3 === 0) updateFog();
    // How far between the last tick and the next one we are. In multiplayer,
    // count the time since the clock last moved, so motion stays smooth.
    const along = mp ? mp.alpha() * SIM_MS : acc;
    const f2 = performance.now();
    render3d(paused && !mp ? 1 : Math.min(1, along / SIM_MS), now, dt);
    const f3 = performance.now();
    drawOverlay();
    updateHoverCursor(now);
    if (frame % 4 === 0) drawMinimap();
    if (frame % 6 === 0) { renderTopBar(); renderSelection(false); renderScoreboard(false); }
    if (frame % 30 === 0 && !$("menuScreen").hidden) renderGameSeats(false);
    syncObserverUi();
    if (mp) frameTrace(now, f1 - f0, f2 - f1, Math.max(0, f3 - f2 - R3.gpuMs), R3.gpuMs, performance.now() - f3);
    // Is the game over? For a player, from their own point of view; for
    // someone only watching, once anyone has won.
    // (Multiplayer decides in pumpMultiplayer, on the confirmed copy.)
    if (observe && observe.kind !== "out") { if (W.winner_player()) observerOver(); }
    else if (running && !mp && W.state_of(ME) !== 0) endGame();
    frame++;
  } else if (titleSpin) {
    // Slowly circle the town behind the title screen.
    cam.yaw += dt * 0.05;
    readWorld();
    render3d(1, now, dt);
  }
  requestAnimationFrame(loop);
}
let titleSpin = false;

// In multiplayer the game is stepped by whichever comes first: an animation
// frame (smooth, up to 60 times a second, but browsers pause them in a
// background tab), or a tiny Web Worker that ticks every 50 ms (workers keep
// running in the background, so one player's hidden tab doesn't stall
// everyone). Both call pumpMultiplayer, which measures time from the same
// clock, so calling it twice just means a smaller step.
let workerClock = false, lastPump = 0;
try {
  const src = "setInterval(() => postMessage(0), 50);";
  const worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
  workerClock = true;
  worker.onmessage = () => {
    if (running && mp) pumpMultiplayer(performance.now(), true);
    else if (running && watcher && document.hidden) { if (watcher.pump()) handleEvents(); }
  };
} catch { /* no workers here: background tabs will just be slow */ }

function pumpMultiplayer(now, fromWorker) {
  if (fromWorker && Trace.cur && lastPump) Trace.cur.maxClockGap = Math.max(Trace.cur.maxClockGap, Math.round(now - lastPump));
  lastPump = now;
  for (const look of roomLookers) look();
  stepMultiplayer(now);
  Watchers.pump(now);
  // The game is over only once the confirmed copy says so (then the
  // recording, and what spectators get, has the ending too).
  if (mp && mp.finalState !== 0) endGame(mp.finalState);
}

// Multiplayer stepping: the client does the work (net.js).
function stepMultiplayer(now) {
  const { steps, stalled } = mp.pump();
  if (!mp) return; // the game ended in there (drift found)
  simTick = mp.live;
  if (steps) handleEvents();
  if (Trace.cur) Trace.cur.ticks += steps;
  if (stalled) {
    if (!stalledSince) { stalledSince = now; Trace.event("stall", { live: mp.live, final: mp.final }); }
  } else if (stalledSince) {
    const ms = Math.round(now - stalledSince);
    if (Trace.cur) Trace.cur.stallMs += ms;
    Trace.event("resume", { ms });
    stalledSince = 0;
  }
  if (Trace.roll(now, mp.snapshot())) renderTrace();
  if (!mp) return;
  // Say so if we've been waiting a while; give up if they're gone.
  const h = $("netWait");
  const pausedNow = mp.pace() === 0;
  h.hidden = !(pausedNow || stalledSince && now - stalledSince > 700);
  if (!h.hidden) h.textContent = pausedNow ? (mp.server ? "Paused for everyone. Press P to resume." : `Paused by ${pnames[1] || "the host"}.`)
    : ME === 1 ? "Waiting for the other players…" : "Waiting for the host…";
  lagCheck(now);
  if (!mp.server && now - mp.lastHeard > 15000) endMultiplayer("Lost contact with the host.");
  if (mp && mp.server) for (const s of mp.server.silent(20000)) dropPlayer(s);
  if (mp && mp.server) {
    for (const s of mp.server.stale(30000)) { dropPlayer(s); }
    sendOffers(now);
  }
}

// ---- where frames' time goes (for the trace) ----
// A frame that comes late was held up either by our own work in the frame
// before (the game, drawing, the HUD), or by something outside the page:
// the browser cleaning up memory, another tab, the computer. So each frame's
// work is timed, part by part, and a late frame is recorded with the work of
// the frame before it. Where the browser tells (Chrome, Edge), the memory in
// use is noted too: a sudden drop means it just cleaned up.
let lastWork = null, lastFrameNow = 0, lastHeap = 0, lastPrograms = 0;
function frameTrace(now, sim, world, draw, gpu, hud) {
  const c = Trace.cur;
  const work = { sim: Math.round(sim), world: Math.round(world), draw: Math.round(draw), gpu: Math.round(gpu), hud: Math.round(hud) };
  const total = sim + world + draw + gpu + hud;
  const heap = performance.memory ? performance.memory.usedJSHeapSize : 0;
  const programs = R3.renderer.info.programs ? R3.renderer.info.programs.length : 0;
  if (c) {
    c.maxWork = Math.max(c.maxWork || 0, Math.round(total));
    if (heap && lastHeap - heap > 512 * 1024) { c.cleanups = (c.cleanups || 0) + 1; c.freedMB = Math.round(((c.freedMB || 0) + (lastHeap - heap) / 1048576) * 10) / 10; }
  }
  const gap = lastFrameNow ? now - lastFrameNow : 0;
  if (gap > 70 && lastWork) {
    const ours = lastWork.sim + lastWork.world + lastWork.draw + lastWork.gpu + lastWork.hud;
    Trace.event("slow frame", {
      gap: Math.round(gap), ourWork: ours, outside: Math.max(0, Math.round(gap - ours)), before: lastWork, now: work,
      newShaders: programs - lastPrograms || undefined,
      heapMB: heap ? Math.round(heap / 104857.6) / 10 : undefined,
      freedMB: heap && lastHeap > heap ? Math.round((lastHeap - heap) / 104857.6) / 10 : undefined,
    });
  }
  lastWork = work; lastFrameNow = now; lastHeap = heap; lastPrograms = programs;
}
// Chrome and Edge report tasks that block the page for over 50 ms.
try {
  new PerformanceObserver(list => { if (mp) for (const e of list.getEntries()) Trace.event("long task", { ms: Math.round(e.duration) }); }).observe({ type: "longtask", buffered: false });
} catch { /* not in this browser */ }

// ---- the trace panel (F8) ----
function renderTrace() {
  const box = $("netTrace");
  if (box.hidden || !mp) return;
  const s = Trace.samples[Trace.samples.length - 1];
  if (!s) { $("netTraceBody").textContent = "Measuring…"; return; }
  const ms = n => n == null ? "?" : `${n} ms`;
  const pct = (a, b) => b ? `${Math.round(100 * a / b)}%` : "–";
  const st = s.stats, tick = NET.TICK_MS;
  const lines = [];
  lines.push(`You: ${s.role} (${PNAME[ME]}) · ${Trace.info.transport} · window ${s.window} ticks (${s.window * tick} ms)`);
  const sign = n => n == null ? "?" : `${n > 0 ? "+" : ""}${n} ms`;
  if (s.server) {
    for (const [slot, g] of Object.entries(s.server.guests)) lines.push(`${PNAME[slot]}: ${g.active ? "" : "(left) "}ping ${ms(g.rtt)} ±${g.dev ?? "?"} · clock ${sign(g.clockErr)} · late commands ${g.late} · heard ${ms(g.heardAgo)} ago`);
  } else {
    lines.push(`Ping to host: ${ms(s.rtt)} ±${s.dev} · my clock ${sign(s.clockErr)} (as the host sees it) · heard ${ms(s.heardAgo)} ago`);
  }
  lines.push(`Live runs ${s.ahead} ticks ahead of confirmed · unconfirmed commands: mine ${s.pending}, friends' ${s.foreign}`);
  lines.push(`Predictions right: whole game ${pct(st.matched, st.compared)}, my own things ${pct(st.mineMatched, st.compared)} (of ${st.compared} ticks)`);
  lines.push(`Corrections ${st.corrections} (friend early ${st.early}, friend in bundle ${st.remote}, moved ${st.moved}, system ${st.system}, behind ${st.behind}) · re-ran ${st.resimTicks} ticks`);
  lines.push(`…that changed my own things ${st.mineChanged} · moved my selection ${st.selChanged}`);
  lines.push(`Friends' commands seen ${ms(s.friendsSeenAfter)} after given · unexplained ${st.unexplained} · drift (desync) ${st.desyncs}`);
  lines.push(`Ticks ${s.ticks}/s · stalled ${s.stallMs} ms`);
  lines.push(`Messages in ${s.inMsgs}/s (${(s.inBytes / 1024).toFixed(1)} KB, longest gap ${ms(s.maxInGap)}) · out ${s.outMsgs}/s (${(s.outBytes / 1024).toFixed(1)} KB)`);
  lines.push(`Longest frame ${ms(s.maxFrameGap)} (our work at most ${ms(s.maxWork)}) · longest clock gap ${ms(s.maxClockGap)}`);
  const slow = Trace.events.filter(e => e.kind === "slow frame");
  if (slow.length) { const e = slow[slow.length - 1]; lines.push(`Slow frames ${slow.length}; last: ${e.gap} ms, of which ours ${e.ourWork} ms (game ${e.before.sim}, drawing ${e.before.draw}, graphics card ${e.before.gpu}, HUD ${e.before.hud})${e.newShaders ? `, ${e.newShaders} new shaders` : ""}${e.freedMB ? `, browser freed ${e.freedMB} MB` : ""}`); }
  if (s.cleanups) lines.push(`Browser memory clean-ups: ${s.cleanups} this second (${s.freedMB} MB)`);
  $("netTraceBody").textContent = lines.join("\n");
}
function toggleTrace(show = $("netTrace").hidden) {
  $("netTrace").hidden = !show || !mp;
  renderTrace();
}
$("netBtn").onclick = () => toggleTrace();
$("netTraceClose").onclick = () => toggleTrace(false);
$("netTraceCopy").onclick = () => {
  const text = Trace.dump(), btn = $("netTraceCopy");
  const showIt = () => { const t = $("netTraceText"); t.hidden = false; t.value = text; t.focus(); t.select(); btn.textContent = "Press Ctrl+C"; };
  try { navigator.clipboard.writeText(text).then(() => { btn.textContent = `Copied (${Math.round(text.length / 1024)} KB)`; setTimeout(() => { btn.textContent = "Copy trace"; }, 2000); }, showIt); }
  catch { showIt(); }
};
document.addEventListener("visibilitychange", () => { if (mp) Trace.event(document.hidden ? "tab hidden" : "tab shown", {}); });

// Start a game. Single player: `players` is you plus the computer players.
// Multiplayer: `local` is the slot this computer plays (1 is the host).
function newGame(seedArg, local = 0, players = 2) {
  seed = seedArg ?? ((Math.random() * 1e9) >>> 0);
  W.init(seed, difficulty, players);
  if (local) W.setup_multiplayer(local);
  enterWorld(local);
}

// Set the page up for whatever game the wasm side now holds: a new one, or
// one just loaded from a save.
function enterWorld(local = 0) {
  ME = W.local_player();
  simTick = 0; stalledSince = 0; outShown = false; surrendered = false;
  stopObserving();
  $("outScreen").hidden = true;
  bakeTerrain();
  buildWorld();
  updateFog();
  readWorld();
  resizeView();
  R3.ghostKind = -1;
  const i = findOwn(K.Capitol);
  cam.dist = 24; cam.pitch = 0.95; cam.yaw = 0;
  if (i != null) centerOn(E(i, F.x), E(i, F.y));
  groups = {}; placing = null; amode = false; updateCursor();
  paused = false; $("pauseBtn").setAttribute("aria-pressed", "false"); $("pauseBtn").textContent = "Pause";
  knownUnlocked = new Set(BUILD_MENU.map(([k]) => k).filter(k => W.unlocked(k)));
  acc = 0; selKey = ""; titleSpin = false; topBar = null; $("techScreen").hidden = true;
  // Online, only the host pauses or changes the speed (syncPaceUi).
  $("pauseBtn").hidden = !!local; $("speedBox").hidden = !!local; $("restartBtn").hidden = !!local;
  $("quitBtn").textContent = local ? "Leave game" : "New game";
  if (local) speed = 1;
  syncSpeedUi();
  renderTopBar(); renderSelection(true);
  // Start recording (a replay, and what spectators are sent). Single player:
  // me against the computer. Multiplayer fills in who's who when it starts.
  const who = {};
  for (let p = 1; p <= W.n_players(); p++) who[p] = p === ME ? "human" : "computer";
  setNames(local ? {} : { [ME]: myName });
  Rec.begin({ who, mp: !!local, names: pnames });
}

let outShown = false;   // the "you're out" card has been shown for this game
let surrendered = false; // I gave up (for the wording)
function endGame(st = W.state_of(ME)) {
  // Out of the running while others play on: watch the rest, or leave.
  if (st === 5) {
    if (!outShown && !observe) {
      outShown = true;
      $("outTitle").textContent = surrendered ? "You surrendered" : "Defeat";
      $("outWhy").textContent = (surrendered ? "" : "Your Capitol has fallen. ") +
        (mp && mp.server ? "The others play on. You're the host: if you leave, the game ends for everyone." : "The others play on.");
      $("outScreen").hidden = false;
      if (!mp && !paused) togglePause(); // single player waits for you to choose
      Sfx.ui("fanfare", false);
    }
    return;
  }
  showEnd(st);
}
// The game is over for me: the end screen.
function showEnd(st) {
  running = false;
  $("outScreen").hidden = true;
  const won = st === 1;
  $("endTitle").textContent = won ? "Victory" : surrendered ? "Surrendered" : "Defeat";
  const winner = pnc(W.winner_player()) || "Someone";
  $("endWhy").textContent = {
    1: "All your rivals have fallen.",
    2: surrendered ? `You surrendered. ${winner} wins.` : `${winner} has conquered the land.`,
    5: surrendered ? "You surrendered." : "Your Capitol has fallen.",
  }[st];
  Rec.finish(won ? `${pnc(ME)} won` : W.winner_player() ? `${winner} won` : surrendered ? `${pnc(ME)} surrendered` : `${pnc(ME)} was out`);
  Sfx.ui("fanfare", won);
  stopObserving();
  showEndStats();
  if (mp) finishMultiplayer();
}
// From the "you're out" card, or the bar while watching: leave this game.
function leaveOut() {
  $("outScreen").hidden = true;
  if (paused && !mp) togglePause();
  showEnd(5);
}
function showEndStats(opts = {}) {
  const ps = [...Array(W.n_players())].map((_, i) => i + 1);
  const head = ps.map(p => `<th style="color:${PLIGHT[p]}">${p === ME && ME ? "You" : pn(p)}</th>`).join("");
  const row = (label, f) => `<tr><th>${label}</th>${ps.map(p => `<td>${f(p)}</td>`).join("")}</tr>`;
  $("endStats").innerHTML = `<tr><th></th>${head}</tr>` +
    row("Units trained", p => W.player_stat(p, 0)) +
    row("Units and buildings lost", p => W.player_stat(p, 1)) +
    row("Buildings built", p => W.player_stat(p, 2)) +
    `<tr><th>Game time</th><td colspan="${ps.length}">${fmtTime(W.game_time())}</td></tr>`;
  $("againBtn").textContent = opts.watching ? "Stop watching" : "Main menu";
  $("replayBtn").hidden = !Rec.replay;
  $("replayDlBtn").hidden = !Rec.replay;
  $("endScreen").hidden = false;
}

function togglePause() {
  if (watcher) return;
  if (mp) { // multiplayer: the host pauses for everyone
    if (!mp.server) { toast("Only the host can pause the game."); return; }
    paused = !paused;
    mp.server.setRate(paused ? 0 : speed);
    syncPaceUi();
    return;
  }
  paused = !paused;
  $("pauseBtn").setAttribute("aria-pressed", String(paused));
  $("pauseBtn").textContent = paused ? "Resume" : "Pause";
}


// The connection status line on claude.ai: what the room says right now. Helps
// tell "blocked by the browser" from "not invited" from "nobody else here".
function renderNetStatus() {
  const el = $("netStatus");
  if (!el || $("startScreen").hidden) return;
  const d = Net.diag;
  if (!d.onClaude) { el.textContent = ""; return; }
  let t = `Online: ${d.room}`;
  if (Net.room) {
    const c = Net.room.connected ? Net.room.connected() : null;
    t += c === true ? ", connected" : c === false ? ", not connected yet" : "";
    if (pageRoom && pageRoom.count) { const n = pageRoom.count(); t += ` · ${n} other ${n === 1 ? "person" : "people"} on this page`; }
  }
  if (d.errors.length) t += ` · problems: ${d.errors.join("; ")}`;
  el.textContent = t;
}

// ===========================================================================
// The lobby. Opening the page makes you the host of your own lobby with four
// seats: yours, and three that each hold a computer player or are left open.
// Friends join with an invite link (this page's address plus #CODE) and take
// an open seat, or a computer's if none is open. Begin with no friends seated
// is an ordinary single-player game; with friends, it's multiplayer.
//
// The lobby lives in a network room named after its code, and the game then
// runs in that same room. The host's presence there carries the seat list,
// which is how guests see it.
//
// A seat is a string, which is also how it travels: "host", "ai", "open", or
// "f:<token>" for a friend.
let seats = ["host", "ai", "open", "open"];
let room = null;        // the lobby's room (and then the game's)
let roomCode = null;    // my own lobby's code, kept for the whole visit so my link keeps working
let guestOf = null;     // as a guest: { code, host (the host's presence, or null), lostAt }
let pageRoom = null;    // claude.ai only: the page-wide room where lobbies are listed
let lobbyGen = 0;       // bumped on every lobby switch, so late answers from an old one are ignored
let netOk = false;      // can this page go online at all?
let lastPlayers = 2, lastWasMultiplayer = false, startTimer = 0;
const kicked = new Set();  // friends the host removed: they don't get a seat again
const played = new Set();  // games already played, so a leftover "start" never restarts one
const myToken = Math.random().toString(36).slice(2, 10); // who I am in a room
const peerNames = new Map(); // token -> the name they picked, from the room's presence
function notePeerNames(peers) {
  for (const p of peers) { const pr = p.presence || {}; if (okToken(pr.token)) peerNames.set(pr.token, cleanName(pr.name)); }
}
function setMyName(v) {
  myName = cleanName(v) || randomName(myName); // an empty box: a new random one
  try { localStorage.setItem(NAME_KEY, myName); } catch { /* storage blocked */ }
  if (room && !guestOf && !watcher) publishLobby(); else if (room) room.presence({ name: myName });
  renderLobby();
}
const mpStatus = (text, bad = false) => { const s = $("mpStatus"); s.textContent = text; s.classList.toggle("bad", bad); };
const randomCode = () => Array.from({ length: 6 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
const okToken = t => typeof t === "string" && /^[a-z0-9]{4,12}$/.test(t);
const isFriend = s => typeof s === "string" && s.startsWith("f:");
// The code at the end of an invite link (or a bare code).
const codeIn = text => { const m = String(text || "").trim().toUpperCase().match(/(?:^|#)([A-Z0-9]{6})$/); return m ? m[1] : null; };
const inGame = () => $("startScreen").hidden;

// The player number a seat gets: open seats are skipped.
function slotOf(i, list) {
  if (list[i] === "open") return 0;
  let n = 0;
  for (let k = 0; k <= i; k++) if (list[k] !== "open") n++;
  return n;
}

function inviteLink() {
  if (!room || guestOf || Net.room) return null; // on claude.ai, lobbies are listed instead
  return location.href.split("#")[0] + "#" + roomCode;
}

function renderLobby() {
  const guest = !!guestOf;
  const list = guest ? (guestOf.host ? guestOf.host.seats : []) : seats;
  const ol = $("seats");
  ol.replaceChildren();
  list.forEach((s, i) => {
    const slot = slotOf(i, list);
    const li = document.createElement("li");
    li.className = "seat" + (slot ? "" : " closed");
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = slot ? PCOL[slot] : "transparent";
    if (!slot) sw.style.border = "1px dashed var(--line)";
    const who = document.createElement("span");
    who.className = "who";
    const nm = s === "host" ? (guest ? cleanName(guestOf.host && guestOf.host.name) : myName)
      : s === "f:" + myToken ? myName : isFriend(s) ? peerNames.get(s.slice(2)) || "" : "";
    const mine = guest ? s === "f:" + myToken : s === "host";
    who.textContent = nm ? nm + (mine ? " (you)" : "") : s === "host" ? (guest ? "Host" : "You")
      : s === "f:" + myToken ? "You"
      : isFriend(s) ? "Friend"
      : s === "ai" ? "Computer"
      : room ? "Open for a friend" : "Empty";
    if (slot) who.style.color = PLIGHT[slot];
    li.append(sw, who);
    if (!guest && i > 0) {
      // The host decides who sits where.
      const sel = document.createElement("select");
      sel.setAttribute("aria-label", `Seat ${i + 1}`);
      const opts = isFriend(s) ? [["friend", "Friend"], ["ai", "Give to computer"], ["open", "Remove"]]
        : [["ai", "Computer"], ["open", room ? "Open" : "Empty"]];
      for (const [v, label] of opts) {
        const o = document.createElement("option");
        o.value = v; o.textContent = label;
        o.selected = v === s || (v === "friend" && isFriend(s));
        sel.append(o);
      }
      sel.onchange = () => setSeat(i, sel.value);
      li.append(sel);
    } else if (slot) {
      const tag = document.createElement("span");
      tag.className = "tag"; tag.textContent = PNAME[slot];
      li.append(tag);
    }
    ol.append(li);
  });
  const active = list.filter(s => s !== "open").length;
  const friends = list.filter(isFriend).length;
  const btn = $("startBtn");
  btn.hidden = guest;
  $("leaveLobbyBtn").hidden = !guest;
  btn.disabled = active < 2;
  btn.textContent = active < 2 ? "Add an opponent to begin" : friends ? `Start game (${active} players)` : "Begin";
  const link = inviteLink();
  $("inviteRow").hidden = !link;
  $("lobbyWatchLink").hidden = !link;
  if (link && $("inviteLink").value !== link) $("inviteLink").value = link;
  const diff = guest && guestOf.host ? guestOf.host.diff : difficulty;
  for (const b of $("diff").children) { b.disabled = guest; b.setAttribute("aria-pressed", String(+b.dataset.d === diff)); }
}

function setSeat(i, v) {
  const s = seats[i];
  if (isFriend(s)) { if (v === "friend") return; kicked.add(s.slice(2)); }
  seats[i] = v;
  lobbyChanged();
}
function lobbyChanged() { publishLobby(); renderLobby(); }
function publishLobby() {
  if (!room || guestOf) return;
  room.presence({ role: "host", v: NET.PROTOCOL, token: myToken, name: myName, names: mp ? pnames : null, seats, diff: difficulty, playing: inGame(), kicked: [...kicked].slice(-20) });
}

// The host's view of the room: seat whoever has arrived, free the seats of
// whoever has gone. During a game, anyone gone is handed to the computer.
function onHostPeers(peers) {
  notePeerNames(peers);
  if (!inGame()) renderLobby(); // names may have changed
  setWatchCount(countWatchers(peers));
  Chat.setOthers(peers.length);
  const here = new Set();
  for (const p of peers) {
    const pr = p.presence || {};
    if (pr.role !== "guest" || pr.v !== NET.PROTOCOL || !okToken(pr.token)) continue;
    here.add(pr.token);
    if (mp && mp.server) {
      if (pr.playing === mp.server.gameId) mp.server.seenPlaying.add(pr.token);
      else if (mp.server.seenPlaying.has(pr.token)) here.delete(pr.token); // was in the game, now back in the lobby
    }
  }
  // (Seats being handed to spectators are skipped: they become guests in a moment.)
  if (mp && mp.server) { for (const [slot, t] of mp.server.tokens) if (!here.has(t) && !mp.server.joining.has(slot)) dropPlayer(slot); return; }
  if (mp) return;
  let changed = false;
  seats.forEach((s, i) => { if (isFriend(s) && !here.has(s.slice(2))) { seats[i] = "open"; changed = true; } });
  for (const t of here) {
    if (kicked.has(t) || seats.includes("f:" + t)) continue;
    let i = seats.indexOf("open");
    if (i < 0) i = seats.lastIndexOf("ai");
    if (i < 0) break; // full
    seats[i] = "f:" + t;
    changed = true;
    if (!inGame()) Sfx.ui("trained");
  }
  if (changed) lobbyChanged();
}

// Leave whatever room we're in.
function closeRoom() {
  clearInterval(startTimer);
  if (room) room.leave();
  room = null; mp = null;
  setWatchCount(0);
  Chat.setOthers(0);
  $("watchHostBtn").hidden = true;
  if (pageRoom) pageRoom.presence({ hosting: null });
}

// Be the host of my own lobby (what the page does when it opens).
async function openOwnLobby(note = "", bad = false) {
  const gen = ++lobbyGen;
  closeRoom();
  guestOf = null;
  leaveWatching();
  if (codeIn(location.hash) || watchIn(location.hash)) try { history.replaceState(null, "", location.href.split("#")[0]); } catch { /* not allowed here */ }
  seats = seats.map(s => isFriend(s) ? "open" : s);
  renderLobby();
  mpStatus(note, bad);
  if (!netOk) return;
  roomCode = roomCode || randomCode();
  try {
    const r = await Net.game(roomCode);
    if (gen !== lobbyGen) { r.leave(); return; }
    room = r;
    Watchers.attach(room);
    Chat.attach(room);
    room.onPeers(onHostPeers);
    publishLobby();
    if (pageRoom) pageRoom.presence({ hosting: roomCode, v: NET.PROTOCOL });
    renderLobby();
  } catch (e) {
    if (gen !== lobbyGen) return;
    mpStatus(Net.room ? String(e.message || e) : "Playing with friends needs the relay server, which isn't reachable. You can still play against the computer.", !!Net.room);
  }
}

// Sit in someone else's lobby.
async function joinLobby(code) {
  if (!code || code === roomCode && !guestOf) return;
  const gen = ++lobbyGen;
  closeRoom();
  leaveWatching();
  guestOf = { code, host: null, lostAt: performance.now() };
  renderLobby();
  if (!netOk) { openOwnLobby("This page can't go online, so it can't join that game.", true); return; }
  mpStatus("Looking for the game…");
  try {
    const r = await Net.game(code);
    if (gen !== lobbyGen) { r.leave(); return; }
    room = r;
    Chat.attach(room);
    room.presence({ role: "guest", v: NET.PROTOCOL, token: myToken, name: myName, playing: null });
    room.on("start", onStart);
    room.onPeers(onGuestPeers);
  } catch (e) {
    if (gen === lobbyGen) openOwnLobby(`Couldn't join that game: ${e.message || e}`, true);
  }
}

function onGuestPeers(peers) {
  if (!guestOf) return;
  notePeerNames(peers);
  setWatchCount(mp ? countWatchers(peers) : 0);
  Chat.setOthers(peers.length);
  const host = peers.map(p => p.presence || {}).find(pr => pr.role === "host" && pr.v === NET.PROTOCOL && okToken(pr.token) && Array.isArray(pr.seats));
  if (mp) {
    if (!host || host.token !== mp.hostToken) endMultiplayer("The host left the game.");
    else if (host.names && typeof host.names === "object") setNames(host.names); // the host keeps who's who
    return;
  }
  if (!host) { if (guestOf.host) { guestOf.host = null; guestOf.lostAt = performance.now(); } renderLobby(); return; }
  guestOf.host = host;
  if (Array.isArray(host.kicked) && host.kicked.includes(myToken)) { openOwnLobby("The host gave your seat away. Here's your own game.", true); return; }
  const seated = host.seats.includes("f:" + myToken);
  mpStatus(!seated ? "No free seat right now. You'll get one if the host opens a seat."
    : host.playing ? "The host is in a game. You'll play together when they're back. Meanwhile you can watch it."
    : "You're in. Waiting for the host to start…");
  $("watchHostBtn").hidden = !host.playing || !!Net.room;
  renderLobby();
}

// Once a second: a guest whose host is gone for good goes back to their own lobby.
function lobbyTick() {
  if (guestOf && !mp && !guestOf.host && performance.now() - guestOf.lostAt > 8000)
    openOwnLobby("That game isn't open any more. Here's your own.", true);
}

// A guest: the host started the game.
function onStart(d) {
  if (mp || !guestOf || !d || d.v !== NET.PROTOCOL || typeof d.seed !== "number" || !d.slots || typeof d.id !== "string" || played.has(d.id)) return;
  const slot = d.slots[myToken];
  if (typeof slot !== "number") return;
  played.add(d.id);
  const client = new Client(slot, room, myToken, mpHooks, endMultiplayer);
  client.hostToken = d.host;
  room.presence({ playing: d.id }); // tells the host I'm in this game
  startMultiplayer(slot, d, client);
}

// The host pressed Begin.
function beginGame() {
  if (guestOf || mp) return;
  const active = seats.filter(s => s !== "open");
  if (active.length < 2) return;
  if (!room || !active.some(isFriend)) {
    lastWasMultiplayer = false; lastPlayers = active.length;
    $("startScreen").hidden = true;
    newGame(undefined, 0, active.length);
    running = true; Rec.real = true;
    publishLobby(); // friends who arrive now wait for the next game
    return;
  }
  const slots = {}, ai = [];
  const names = { 1: myName };
  active.forEach((s, k) => { if (isFriend(s)) { slots[s.slice(2)] = k + 1; names[k + 1] = peerNames.get(s.slice(2)) || ""; } else if (s === "ai") ai.push(k + 1); });
  const settings = { v: NET.PROTOCOL, names, id: randomCode() + Date.now(), seed: (Math.random() * 1e9) >>> 0, n: active.length, slots, ai, diff: difficulty, host: myToken };
  // Keep telling the guests until all of them have answered.
  const send = () => room && room.emit("start", settings);
  send();
  startTimer = setInterval(() => {
    if (!(mp && mp.server)) return clearInterval(startTimer);
    if (mp.server.waitingForStart()) send(); else clearInterval(startTimer);
  }, 400);
  if (pageRoom) pageRoom.presence({ hosting: null });
  // The host runs the server and, like everyone, a client.
  const client = new Client(1, null, myToken, mpHooks, endMultiplayer);
  client.server = new Server(room, Object.entries(slots).map(([t, s]) => [s, t]), client, endMultiplayer);
  client.server.gameId = settings.id; client.server.seenPlaying = new Set();
  startMultiplayer(1, settings, client);
}

function startMultiplayer(me, d, seq) {
  const n = Math.max(2, Math.min(4, d.n | 0));
  difficulty = [0, 1, 2].includes(d.diff) ? d.diff : 1;
  $("startScreen").hidden = true;
  newGame(d.seed >>> 0, me, n);
  const ai = (Array.isArray(d.ai) ? d.ai : []).filter(s => Number.isInteger(s) && s >= 1 && s <= n);
  for (const s of ai) W.set_ai(s, 1);
  // Record from here: the start everyone shares, then the confirmed bundles.
  const who = {};
  for (let p = 1; p <= n; p++) who[p] = ai.includes(p) ? "computer" : "human";
  setNames(d.names);
  Rec.begin({ who, mp: true, names: pnames });
  Rec.real = true;
  W.mp_save(); // the confirmed copy starts out identical
  mp = seq;
  lastPump = 0;
  // Building the map can take a few seconds: the host's clock starts now.
  if (mp.server) mp.server.setClock(0);
  paused = false; speed = 1;
  syncPaceUi();
  Trace.start({ role: me === 1 ? "host" : "guest", me, players: n, transport: room && room.kind === "socket" ? "relay" : "claude.ai room", relay: room && room.kind === "socket" ? Net.relayUrl : undefined });
  $("netBtn").hidden = false;
  // Building the map can take a few seconds on a slow computer: only start
  // the "haven't heard from you" clocks once we're ready to play.
  mp.lastHeard = performance.now();
  if (mp.server) for (const s of mp.server.heard.keys()) mp.server.heard.set(s, performance.now());
  lastWasMultiplayer = true;
  running = true;
  publishLobby();
  toast(`You are ${PNAME[me]}. ${n} players.`, "good");
}

// A guest left: the computer takes over their people (in the next frame).
function dropPlayer(slot) {
  if (!(mp && mp.server) || !mp.server.active.has(slot)) return;
  mp.server.drop(slot);
}

// ---- Seats changing hands mid-game ----
// The host can hand a seat the computer plays to a spectator. Through the
// server (net.js, Server.claim): on a tick a second ahead the seat goes back
// to a person, for everyone at once; the spectator's copy stops right after
// that tick and goes on as a player's (takeSeat). A single-player game
// becomes a multiplayer one first, there and then (becomeServer).
let pendingSeat = null;           // single player: { slot, token }, handed out after the next tick
let lastOffers = 0, offersOut = false;

function canGiveSeats() { return !!room && !guestOf && !watcher && running && !Replay.on && (!observe || observe.kind === "out") && Rec.real && !Rec.done; }

function giveSeat(slot, token) {
  if (!canGiveSeats() || slot === ME || W.defeated(slot)) return;
  const n = Watchers.number(token), name = Watchers.nameOf(token);
  if (!mp) {
    pendingSeat = { slot, token };
    if (paused) togglePause();
    $("menuScreen").hidden = true;
  } else if (!mp.server || !mp.server.claim(slot, token)) return;
  else claimed(slot, token);
  toast(`Handing ${PNAME[slot]} to ${name || "Spectator " + n}…`);
  renderGameSeats(true);
}

// A seat is on its way to a spectator: their name goes with it, and they hear now.
function claimed(slot, token) {
  const name = Watchers.nameOf(token);
  if (name) pnames[slot] = name; else delete pnames[slot];
  lastOffers = 0;
  publishLobby();
}

// Single player, right after a tick: from here the game runs the
// multiplayer way, with this page as the host.
function becomeServer() {
  const k = simTick;
  const client = new Client(ME, null, myToken, mpHooks, endMultiplayer);
  client.live = k; client.final = client.got = k - 1;
  const server = new Server(room, [], client, endMultiplayer);
  server.final = k - 1;
  server.setClock(k);
  if (!NET.SPEEDS.includes(speed)) speed = 1;
  server.rate = speed; // carry on at the speed it was going
  server.gameId = Rec.id; server.seenPlaying = new Set();
  client.server = server;
  W.mp_save(); // the confirmed copy: the game as it is now
  mp = client;
  lastPump = 0; stalledSince = 0;
  Rec.meta.mp = true;
  paused = false;
  $("restartBtn").hidden = true;
  Trace.start({ role: "host", me: ME, players: W.n_players(), transport: room.kind === "socket" ? "relay" : "claude.ai room", relay: room.kind === "socket" ? Net.relayUrl : undefined, from: "single player" });
  $("netBtn").hidden = false;
  mp.lastHeard = performance.now();
  lastWasMultiplayer = true;
  syncPaceUi();
  publishLobby();
}

// The host: keep telling spectators about the seats on their way to them.
function sendOffers(now) {
  const j = mp.server.joining;
  if (!room || (!j.size && !offersOut) || now - lastOffers < 500) return;
  lastOffers = now; offersOut = j.size > 0;
  room.emit("seat", { v: NET.PROTOCOL, game: Rec.id, gameId: mp.server.gameId, host: myToken,
    offers: [...j.values()].map(o => ({ to: o.token, slot: o.slot, T: o.T, seq0: o.seq0 })) });
}

// A spectator whose copy has just run the tick the seat changed hands on:
// play from here, as a guest of the host.
function takeSeat(w) {
  const { slot, T, seq0, gameId, host } = w.seat;
  const code = w.code, hostPresence = w.host;
  leaveWatching();
  stopObserving();
  ME = slot;
  if (myName) pnames[slot] = myName;
  W.set_view(slot, 0);
  W.clear_selection();
  // Commands already confirmed, so late early-news of them isn't taken for new.
  const done = new Map();
  for (const list of Rec.cmds.values()) for (const e of list) if (e[0] > 0) done.set(e[0], Math.max(done.get(e[0]) || 0, e[1]));
  guestOf = { code, host: hostPresence, lostAt: performance.now() };
  played.add(gameId);
  room.presence({ role: "guest", v: NET.PROTOCOL, token: myToken, playing: gameId });
  room.on("start", onStart);
  room.onPeers(onGuestPeers);
  const client = new Client(slot, room, myToken, mpHooks, endMultiplayer);
  client.hostToken = host;
  client.live = T + 1; client.final = client.got = T;
  client.seq = seq0; client.doneSeq = done;
  for (let s = 1; s <= W.n_players(); s++) if (s !== slot && W.is_ai(s)) client.leftSeen.add(s); // old news
  W.mp_save(); // the confirmed copy: exactly the host's after tick T
  mp = client;
  simTick = client.live; lastPump = 0; stalledSince = 0;
  Rec.meta.me = slot;
  Trace.start({ role: "guest", me: slot, players: W.n_players(), transport: room.kind === "socket" ? "relay" : "claude.ai room", from: "spectator", at: T });
  $("netBtn").hidden = false;
  mp.lastHeard = performance.now();
  lastWasMultiplayer = true; lastPlayers = W.n_players();
  outShown = false; surrendered = false;
  groups = {}; placing = null; amode = false; updateCursor();
  knownUnlocked = new Set(BUILD_MENU.map(([k]) => k).filter(k => W.unlocked(k)));
  $("quitBtn").textContent = "Leave game";
  paused = false; speed = 1;
  syncPaceUi();
  for (const id of ["endScreen", "menuScreen", "watchWait", "netWait"]) $(id).hidden = true;
  refreshHud();
  const i = findOwn(K.Capitol);
  cam.dist = 24; cam.pitch = 0.95; cam.yaw = 0;
  if (i != null) centerOn(E(i, F.x), E(i, F.y));
  renderSelection(true);
  Sfx.ui("trained");
  toast(`You are ${PNAME[slot]} now. Your turn to play!`, "good");
}

// The host's menu, during a game: who plays which seat, and handing a
// computer's seat to a spectator.
let seatsKey = "";
function renderGameSeats(force) {
  const box = $("gameSeats");
  const show = canGiveSeats();
  box.hidden = !show;
  if (!show) return;
  const n = W.n_players(), srv = mp && mp.server;
  const specs = Watchers.ready().filter(([t]) => !(srv && [...srv.tokens].some(([s, tk]) => tk === t && srv.active.has(s))) && !(pendingSeat && pendingSeat.token === t));
  const rows = [];
  for (let p = 1; p <= n; p++) {
    const joining = srv && srv.joining.get(p);
    const state = p === ME ? "you" : W.defeated(p) ? "out"
      : joining || (pendingSeat && pendingSeat.slot === p) ? "joining"
      : srv && srv.active.has(p) || !W.is_ai(p) ? "friend" : "computer";
    const tk = joining ? joining.token : pendingSeat && pendingSeat.slot === p ? pendingSeat.token : null;
    const to = tk ? Watchers.nameOf(tk) || `Spectator ${Watchers.number(tk)}` : "";
    rows.push([p, state, to]);
  }
  const key = JSON.stringify([rows, specs, pnames]);
  if (!force && key === seatsKey) return;
  seatsKey = key;
  const ol = $("gameSeatList");
  ol.replaceChildren();
  for (const [p, state, to] of rows) {
    const li = document.createElement("li");
    li.className = "seat" + (state === "out" ? " closed" : "");
    const sw = document.createElement("span");
    sw.className = "swatch"; sw.style.background = PCOL[p];
    const who = document.createElement("span");
    who.className = "who"; who.style.color = PLIGHT[p];
    who.textContent = pnames[p] && state !== "computer" ? `${pnames[p]} (${PNAME[p]})` : PNAME[p];
    li.append(sw, who);
    if (state === "computer" && specs.length) {
      const sel = document.createElement("select");
      sel.setAttribute("aria-label", `Who plays ${PNAME[p]}`);
      for (const [v, label] of [["", "Computer"], ...specs.map(([t, k, nm]) => [t, `Give to ${nm || "Spectator " + k}`])]) {
        const o = document.createElement("option");
        o.value = v; o.textContent = label;
        sel.append(o);
      }
      sel.onchange = () => { if (sel.value) giveSeat(p, sel.value); };
      li.append(sel);
    } else {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = { you: "You", out: "Out", joining: `Handing to ${to}…`, friend: "Friend", computer: "Computer" }[state];
      li.append(tag);
    }
    ol.append(li);
  }
  const anyComputer = rows.some(r => r[1] === "computer");
  $("gameSeatNote").textContent = !anyComputer ? "Every seat has a player."
    : specs.length ? "A spectator can take over a seat the computer plays, from where the game is now."
    : "Spectators can take over a seat the computer plays. Send them the watch link.";
}

function endMultiplayer(reason) {
  if (!mp) return;
  running = false;
  stopObserving(); $("outScreen").hidden = true;
  Rec.finish(reason);
  $("endTitle").textContent = "Game over";
  $("endWhy").textContent = reason;
  showEndStats();
  finishMultiplayer();
}

// The game is over (or we left it). We stay in the room: back in the lobby,
// everyone can go again together.
function finishMultiplayer() {
  clearInterval(startTimer);
  if (mp) { Trace.event("end", {}); W.mp_end(); }
  mp = null;
  paused = false; speed = 1; lastPace = 1; slowFor.clear(); announced.clear();
  $("pauseBtn").textContent = "Pause"; $("pauseBtn").setAttribute("aria-pressed", "false");
  syncSpeedUi();
  $("netBtn").hidden = true; $("netTrace").hidden = true;
  $("netWait").hidden = true;
}

// "X left", once per leaving, whichever comes first: the host's notice or
// the computer taking over.
const announced = new Set();
function announceLeft(slot) {
  if (announced.has(slot) || slot === ME) return;
  announced.add(slot);
  toast(`${pnc(slot) || "A player"} left. The computer takes over their people${mp && mp.pace() === 0 ? " when the game goes on" : ""}.`);
}

// ---- Pause and speed in multiplayer ----
// The host has the buttons (and P); everyone else sees what the host set.
function syncPaceUi() {
  if (!mp) return;
  const host = !!mp.server, rate = mp.pace();
  $("pauseBtn").hidden = !host;
  $("pauseBtn").setAttribute("aria-pressed", String(host && paused));
  $("pauseBtn").textContent = host && paused ? "Resume" : "Pause";
  $("pauseBtn").title = "Pause the game for everyone (P)";
  // Guests: the speed shows, when it isn't the usual one.
  $("speedBox").hidden = !host && (rate === 1 || rate === 0);
  syncSpeedUi();
}
// A guest: the host paused, resumed, or changed the speed.
let lastPace = 1;
function paceChanged(rate) {
  const was = lastPace; lastPace = rate;
  const host = pnames[1] || "The host";
  if (rate === 0) toast(`${host} paused the game.`);
  else if (was === 0) toast(`${host} resumed the game${rate !== 1 ? ` at ${rate}×` : ""}.`);
  else toast(`${host} set the speed to ${rate}×.`);
  syncPaceUi();
}

// Once a second: say so when a computer can't keep up with the clock, or a
// connection struggles. Nobody waits for them: the game goes on for the
// others, and they catch up when they can.
let lagCheckAt = 0;
const slowFor = new Map(); // what -> seconds it has been so
function lagCheck(now) {
  if (now - lagCheckAt < 1000) return;
  lagCheckAt = now;
  const rate = mp.pace();
  const atSpeed = rate > 1 ? ` at ${rate}×` : "";
  const count = (key, bad) => { const n = bad ? (slowFor.get(key) || 0) + 1 : 0; slowFor.set(key, n); return n; };
  if (count("me", mp.behind() > NET.BEHIND) === 3) toast(`Your computer can't keep up${atSpeed}. The others play on; you catch up when it can.`, "bad");
  if (!mp.server) return;
  for (const s of mp.server.active) {
    if (mp.server.joining.has(s)) continue;
    if (count("cpu" + s, (mp.server.lag.get(s) || 0) > NET.BEHIND) === 3)
      toast(`${pnc(s)}'s computer can't keep up${atSpeed}. The game goes on for everyone else.${rate > 1 ? " A slower speed would help them." : ""}`, "bad");
    if (count("net" + s, now - mp.server.heard.get(s) > 3000) === 1)
      toast(`${pnc(s)}'s connection is struggling. The game goes on without waiting for them.`, "bad");
  }
}

// ===========================================================================
// Saving and loading (single player)
//
// The Rust side turns the whole game into bytes (src/save.rs). Here we wrap
// those bytes in a small JSON envelope with what the page needs on top
// (camera, control groups, a description for the list), gzip them where the
// browser can, and keep them in localStorage or a downloaded file.
const SAVE_KEY = "vibecraft.saves", SAVE_MAX = 8, SAVE_FORMAT = 1;

function readSaves() {
  try { const v = JSON.parse(localStorage.getItem(SAVE_KEY) || "[]"); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
// Newest first. If the browser is out of room, drop the oldest and try again.
function writeSaves(list) {
  for (let keep = list.length; keep >= 1; keep--) {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(list.slice(0, keep))); return keep; }
    catch { /* quota (or storage blocked): try with fewer */ }
  }
  return 0;
}

function toB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromB64 = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
async function pipeBytes(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

async function makeSave() {
  const n = W.save_game();
  let bytes = u8(W.save_ptr(), n).slice(), z = false;
  if (window.CompressionStream) {
    try { bytes = await pipeBytes(bytes, new CompressionStream("gzip")); z = true; } catch { /* keep it raw */ }
  }
  const players = W.n_players();
  return {
    format: SAVE_FORMAT, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    saved: Date.now(), time: W.game_time(), players, difficulty: W.game_difficulty(),
    cam: { x: cam.x, y: cam.y, dist: cam.dist, pitch: cam.pitch, yaw: cam.yaw },
    groups: Object.fromEntries(Object.entries(groups).filter(([g]) => /^[1-9]$/.test(g))),
    z, data: toB64(bytes),
  };
}

let saving = false;
async function saveGame() {
  if (mp || observe || !running || saving || W.state_of(ME) !== 0) return;
  saving = true;
  try {
    const save = await makeSave();
    const list = readSaves();
    list.unshift(save);
    const kept = writeSaves(list.slice(0, SAVE_MAX));
    if (kept) toast(`Game saved (${fmtTime(save.time)})` + (kept < Math.min(list.length, SAVE_MAX) ? ". Older saves were removed to make room." : ""));
    else { toast("This browser won't store the save. Downloading it instead.", "bad"); downloadSave(save); }
  } catch (err) {
    toast("Couldn't save the game.", "bad");
  } finally { saving = false; }
}

function downloadSave(save, kind = "") {
  const d = new Date(save.saved), pad = v => String(v).padStart(2, "0");
  const name = `vibecraft-${kind ? kind + "-" : ""}${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.vibecraft`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(save)], { type: "application/json" }));
  a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function loadSave(save) {
  if (!save || save.format !== SAVE_FORMAT || typeof save.data !== "string") throw new Error("not a save");
  let bytes = fromB64(save.data);
  if (save.z) {
    if (!window.DecompressionStream) { toast("This browser can't open compressed saves.", "bad"); return; }
    bytes = await pipeBytes(bytes, new DecompressionStream("gzip"));
  }
  finishMultiplayer(); lastWasMultiplayer = false;
  leaveWatching(); Replay.close();
  if (guestOf) openOwnLobby(); // we were waiting in someone's lobby: we're playing alone now
  u8(W.load_buffer(bytes.length), bytes.length).set(bytes);
  if (!W.load_game(bytes.length)) { toast("That save is damaged, or from another version of the game.", "bad"); return; }
  seed = W.game_seed(); difficulty = W.game_difficulty();
  enterWorld(0);
  if (save.cam) { Object.assign(cam, save.cam); clampCam(); }
  if (save.groups) groups = save.groups;
  for (const id of ["loadScreen", "menuScreen", "startScreen", "endScreen"]) $(id).hidden = true;
  running = true; Rec.real = true;
  lastPlayers = W.n_players(); // for Restart and Play again
  publishLobby(); // friends who open our link now wait for the next game
  toast(`Loaded: ${fmtTime(W.game_time())} into the game`);
}

let loadReturn = "menuScreen";
function openLoadScreen(from) {
  loadReturn = from;
  $(from).hidden = true;
  renderSaveList();
  renderReplayList();
  $("loadScreen").hidden = false;
}
function closeLoadScreen() {
  $("loadScreen").hidden = true;
  $(loadReturn).hidden = false;
}
function renderSaveList() {
  const ul = $("saveList"), list = readSaves();
  ul.replaceChildren();
  if (!list.length) {
    const li = document.createElement("li"); li.className = "empty";
    li.textContent = "No saved games in this browser yet. Save from the Menu during a game, or press Ctrl+S.";
    ul.append(li);
    return;
  }
  const DIFF = ["Easy", "Normal", "Hard"];
  for (const save of list) {
    const li = document.createElement("li");
    const what = document.createElement("div"); what.className = "what";
    const when = new Date(save.saved);
    const title = document.createElement("b");
    title.textContent = when.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    const sub = document.createElement("small");
    const opp = (save.players || 2) - 1;
    sub.textContent = `${fmtTime(save.time || 0)} played · ${opp} opponent${opp === 1 ? "" : "s"} · ${DIFF[save.difficulty] ?? "Normal"}`;
    what.append(title, sub);
    const btn = (label, cls, fn) => { const b = document.createElement("button"); b.className = cls; b.textContent = label; b.onclick = fn; return b; };
    li.append(what,
      btn("Load", "go", () => loadSave(save).catch(() => toast("That save couldn't be read.", "bad"))),
      btn("Download", "ghost", () => downloadSave(save)),
      btn("Delete", "ghost", e => {
        // Two clicks, so a slip doesn't lose a game.
        if (e.target.dataset.sure) { writeSaves(readSaves().filter(s => s.id !== save.id)); renderSaveList(); }
        else { e.target.dataset.sure = "1"; e.target.textContent = "Really delete?"; }
      }));
    ul.append(li);
  }
}

// ---- buttons ----
// Browsers only allow audio after the player interacts with the page.
window.addEventListener("pointerdown", () => Sfx.init(), { capture: true });
window.addEventListener("keydown", () => Sfx.init(), { capture: true });
function syncSoundBtn() {
  for (const id of ["volume", "menuVolume"]) {
    $(id).value = String(Math.round(Sfx.volume * 100));
    $(id).classList.toggle("off", Sfx.muted);
  }
}
for (const id of ["volume", "menuVolume"]) {
  $(id).addEventListener("input", e => {
    Sfx.setVolume(e.target.value / 100);
    if (Sfx.muted && Sfx.volume > 0) Sfx.setMuted(false); // dragging the slider means you want sound
    syncSoundBtn();
  });
  // Let go of the slider and a short sound plays at the new level.
  $(id).addEventListener("change", e => { Sfx.init(); Sfx.ui("queued"); e.target.blur(); });
}
syncSoundBtn();
$("diff").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b || guestOf) return;
  difficulty = +b.dataset.d;
  lobbyChanged();
});
// Back to the lobby: a host reopens theirs (which also clears what the last
// game left in the room); a guest goes back to their host's.
const toMenu = () => {
  if (watcher) return stopWatching();
  const wasGuestOf = guestOf && guestOf.code;
  if (running && !observe) Rec.finish();
  Replay.close(); stopObserving(); $("outScreen").hidden = true;
  finishMultiplayer(); lastWasMultiplayer = false; running = false; titleSpin = true;
  $("endScreen").hidden = true; $("menuScreen").hidden = true; $("startScreen").hidden = false;
  if (wasGuestOf) joinLobby(wasGuestOf); else openOwnLobby();
};
$("startBtn").onclick = beginGame;
$("leaveLobbyBtn").onclick = () => openOwnLobby();
$("againBtn").onclick = toMenu;
$("pauseBtn").onclick = togglePause;
// Game speed: a slider. Alone, up to 10x; online the host picks one of
// NET.SPEEDS for everyone, and the others see it.
function syncSpeedUi() {
  const sl = $("speedSlider"), guest = !!mp && !mp.server;
  const shown = guest ? mp.pace() : speed;
  sl.max = String(mp ? Math.max(...NET.SPEEDS) : 10);
  sl.value = String(shown);
  sl.disabled = guest;
  $("speedLabel").textContent = `${shown}×`;
  $("speedBox").title = !mp ? "Game speed" : guest ? "Game speed, set by the host" : "Game speed, for everyone";
}
$("speedSlider").addEventListener("input", e => {
  const v = +e.target.value;
  if (mp) { // the host sets everyone's speed
    if (!mp.server || !NET.SPEEDS.includes(v)) return syncSpeedUi();
    speed = v;
    if (!paused) mp.server.setRate(speed);
    syncPaceUi();
    return;
  }
  speed = v;
  syncSpeedUi();
});
// Let go: the keys go back to the game (arrows would move the slider).
$("speedSlider").addEventListener("change", e => e.target.blur());
syncSpeedUi();
function cheatsToast(on) {
  toast(on ? "Cheat mode on: every player a person plays can build and train anything, of any era, free." : "Cheat mode off.", "good");
  selKey = "";
}
// The cheat switch: a system command from the host (owner 0), recorded for
// replays and sent to everyone online like a seat changing hands.
$("cheatBtn").onclick = () => {
  const cmd = [15, W.cheats_on() ? 0 : 1, 0, 0];
  if (mp && mp.server) mp.server.system(cmd);
  else if (!mp) { applyCmd(0, cmd); Rec.add(simTick, [0, ++Rec.seq, ...cmd]); handleEvents(); }
  $("cheatBtn").textContent = `Cheat mode: ${cmd[1] ? "on" : "off"}`;
  selKey = "";
};
$("menuBtn").onclick = () => {
  if (!running) return;
  if (!paused && !mp && !watcher) togglePause();
  const playing = !observe && W.state_of(ME) === 0;
  $("menuTitle").textContent = mp || watcher ? "Menu" : "Paused";
  $("saveBtn").hidden = $("menuLoadBtn").hidden = !!mp || !!observe;
  $("saveReplayBtn").hidden = !Rec.real || Rec.done || Replay.on;
  $("restartBtn").hidden = !!mp || !!observe;
  $("surrenderBtn").hidden = !playing;
  // The host (or a single player) can switch cheat mode for every person.
  $("cheatBtn").hidden = !!observe || !!(mp && !mp.server);
  $("cheatBtn").textContent = `Cheat mode: ${W.cheats_on() ? "on" : "off"}`;
  delete $("surrenderBtn").dataset.sure; $("surrenderBtn").textContent = "Surrender";
  $("watchLinkBtn").hidden = !watchLink() || !!observe && observe.kind !== "out";
  $("quitBtn").textContent = watcher ? "Stop watching" : Replay.on ? "Exit replay" : mp ? "Leave game" : "New game";
  renderGameSeats(true);
  $("menuScreen").hidden = false;
};
// Two clicks, so a slip doesn't end your game.
$("surrenderBtn").onclick = e => {
  const b = e.currentTarget;
  if (!b.dataset.sure) { b.dataset.sure = "1"; b.textContent = "Really surrender?"; return; }
  $("menuScreen").hidden = true;
  if (paused) togglePause();
  surrendered = true;
  issue({ c: 8 });
};
$("outWatchBtn").onclick = () => { $("outScreen").hidden = true; startObserving("out"); if (paused && !mp) togglePause(); };
$("outLeaveBtn").onclick = leaveOut;
$("saveBtn").onclick = () => saveGame();
$("saveReplayBtn").onclick = async () => {
  const ok = await Rec.saveNow().catch(() => false);
  toast(ok ? `Replay saved (${fmtTime(Rec.ticks * SIM_MS / 1000)}): find it under Replays on the start screen.` : "Couldn't save the replay.", ok ? "good" : "bad");
};
$("menuLoadBtn").onclick = () => openLoadScreen("menuScreen");
$("startLoadBtn").onclick = () => openLoadScreen("startScreen");
$("loadClose").onclick = () => closeLoadScreen();
$("loadFileBtn").onclick = () => $("loadFile").click();
$("loadFile").onchange = async e => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (d && d.kind === "replay") await Replay.open(d); else await loadSave(d);
  } catch { toast("That file isn't a VibeCraft save or replay.", "bad"); }
};
$("resumeBtn").onclick = () => { $("menuScreen").hidden = true; if (paused && !mp) togglePause(); };
$("restartBtn").onclick = () => { $("menuScreen").hidden = true; newGame(undefined, 0, lastPlayers); Rec.real = true; };
$("quitBtn").onclick = toMenu;
// Copy the invite link. Some app views refuse the clipboard: then select it
// so it can be copied by hand.
$("copyLink").onclick = () => {
  const input = $("inviteLink"), btn = $("copyLink");
  const selectIt = () => { input.focus(); input.select(); btn.textContent = "Press Ctrl+C"; };
  try {
    navigator.clipboard.writeText(input.value).then(() => { btn.textContent = "Copied"; setTimeout(() => { btn.textContent = "Copy link"; }, 1500); }, selectIt);
  } catch { selectIt(); }
};
$("inviteLink").onfocus = e => e.target.select();
const joinTyped = () => { const c = codeIn($("joinLink").value); if (c) joinLobby(c); else mpStatus("That doesn't look like an invite link.", true); };
$("joinBtn").onclick = joinTyped;
$("nameInput").value = myName;
// Commit on Enter or leaving the box ("change" doesn't fire a second time
// for an empty box once the page has filled in a new random name).
const commitName = () => { const el = $("nameInput"); if (el.value !== myName) setMyName(el.value); el.value = myName; };
$("nameInput").addEventListener("blur", commitName);
$("nameInput").addEventListener("keydown", e => { if (e.key === "Enter") commitName(); });
$("joinLink").addEventListener("keydown", e => { if (e.key === "Enter") joinTyped(); });
$("relayUrl").addEventListener("change", () => { Net.relayUrl = $("relayUrl").value.trim(); openOwnLobby(); });
// Opening an invite link in a tab that already has the game open.
window.addEventListener("hashchange", () => {
  const w = watchIn(location.hash);
  if (w && !(running && !observe)) { startWatching(w); return; }
  const c = codeIn(location.hash); if (c && !inGame()) joinLobby(c);
});
$("techClose").onclick = () => { $("techScreen").hidden = true; };

// ---- start ----
// The loading screen (#boot, in index.html) is up from the first paint.
// Starting is a few heavy steps; between them the page pauses for a frame,
// so the screen can show how far along we are.
const Boot = {
  step(text, part) { $("bootStep").textContent = text; $("bootFill").style.transform = `scaleX(${part})`; },
  // Let the browser paint. (Animation frames stop in a background tab, so
  // don't wait for one forever.)
  breathe() {
    return new Promise(done => {
      let went = false;
      const go = () => { if (!went) { went = true; setTimeout(done, 0); } };
      requestAnimationFrame(go); setTimeout(go, 120);
    });
  },
  fail(text) { this.step(text, 1); $("bootStep").style.color = "var(--bad)"; $("bootTip").textContent = ""; },
  // Fade out once the title scene has really been drawn.
  done() {
    this.step("Ready", 1);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      $("boot").classList.add("gone");
      setTimeout(() => $("boot").remove(), 700);
    }));
  },
};
(async () => {
  if (!window.THREE) {
    Boot.fail("The 3D library (three.js) didn't load. It comes from cdn.jsdelivr.net: check your internet connection and reload.");
    return;
  }
  $("boot").classList.add("busy"); // see #boot.busy in index.html
  Boot.step("Waking the engine…", 0.12);
  await Boot.breathe();
  await loadWasm();
  initWatchUi();
  initChatUi();
  Boot.step("Carving the models…", 0.3);
  await Boot.breathe();
  initRenderer();
  resizeView();
  Boot.step("Shaping the land…", 0.55);
  await Boot.breathe();
  // A live map behind the title screen.
  newGame();
  running = false; titleSpin = true;
  renderLobby();
  Boot.step("Lighting the scene…", 0.8);
  await Boot.breathe();
  // Compile the shaders before the first frame, in the background where the
  // browser can (otherwise the first frame does it, and the page freezes).
  readWorld();
  try { await Promise.race([R3.renderer.compileAsync(R3.scene, R3.camera), new Promise(r => setTimeout(r, 4000))]); } catch { /* the first frame will */ }
  requestAnimationFrame(loop);
  Boot.done();
  setInterval(() => { renderNetStatus(); lobbyTick(); }, 1000);
  // On claude.ai the page talks to other viewers through claude.ai. Elsewhere
  // it goes through a relay server: served from a web server, assume the relay
  // sits next to the page at ./relay; a copy opened as a file has to be told.
  const onClaude = !!(window.claude && window.claude.use);
  const onSite = /^https?:$/.test(location.protocol) && !onClaude;
  if (onSite) $("relayUrl").value = new URL("relay", location.href.split("#")[0]).href.replace(/^http/, "ws");
  const hasRoom = await Net.init($("relayUrl").value.trim());
  netOk = hasRoom || !onClaude;
  $("relayRow").hidden = onClaude || onSite;
  // Where opening a link doesn't work (claude.ai, a file), paste it instead.
  $("joinRow").hidden = !netOk || onSite;
  if (hasRoom) {
    // On claude.ai everyone here was invited by the page's owner: list their lobbies.
    pageRoom = await Net.lobby();
    pageRoom.onPeers(peers => {
      const box = $("openGames");
      box.replaceChildren();
      for (const p of peers) {
        const code = p.presence && p.presence.hosting;
        if (typeof code !== "string" || !/^[A-Z0-9]{6}$/.test(code) || code === roomCode || p.presence.v !== NET.PROTOCOL) continue;
        const b = document.createElement("button");
        b.className = "ghost"; b.textContent = `Join game ${code}`;
        b.onclick = () => joinLobby(code);
        box.append(b);
      }
    });
  } else if (onClaude) {
    mpStatus(Net.diag.room === "no answer from claude.ai"
      ? "Playing with friends can't reach claude.ai from this page. Your browser may be blocking it: in Firefox, turn off Enhanced Tracking Protection for this site (the shield in the address bar), or pause your ad blocker here, then reload."
      : "Playing with friends isn't available in this view. You need to be signed in to claude.ai and invited to this game (the owner adds you with Share).", true);
  }
  const invited = codeIn(location.hash), toWatch = watchIn(location.hash);
  if (toWatch && netOk) startWatching(toWatch);
  else if (invited && netOk) joinLobby(invited);
  else if (netOk) openOwnLobby($("mpStatus").textContent, $("mpStatus").classList.contains("bad"));
})();
