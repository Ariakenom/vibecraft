//! Static game data: what every unit and building costs and can do.
//!
//! Everything here is `const` / `'static`: it's baked into the binary and
//! never changes at runtime, so the rest of the code can hand out
//! `&'static Stats` references freely without worrying about lifetimes.
//!
//! Resources are **slots** (see docs/design/economy-and-eras.md): producers
//! make a number of slots, and everything that exists holds some. Nothing is
//! stockpiled. All tuning lives in this file.

/// Every resource in the game, across all eras. `#[derive]` asks the
/// compiler to write trait impls for us: `Copy` makes this a plain value
/// (like an int) instead of something that "moves".
///
/// Only the Ancient ones have producers so far; the rest are here so the
/// tables, the save format and the interface already have room for them.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Res {
    Wood = 0,
    Stone = 1,
    Grain = 2,
    Fish = 3,
    Meat = 4,
    Fruit = 5,
    Horses = 6,
    Wool = 7,
    Iron = 8,
    Brick = 9,
    Bread = 10,
    Clothes = 11,
    Beer = 12,
    Nitrate = 13,
    Gunpowder = 14,
    Furniture = 15,
    Books = 16,
    Circus = 17,
    Coal = 18,
    Steel = 19,
    Explosives = 20,
    CannedFood = 21,
    Heating = 22,
    Newspapers = 23,
    Electricity = 24,
    Oil = 25,
    Aluminum = 26,
    Radios = 27,
    Uranium = 28,
    Cars = 29,
    Tvs = 30,
}

/// How many kinds of resource there are. Arrays indexed by resource have this length.
pub const N_RES: usize = 31;

impl Res {
    /// Every resource, in index order (`Res::ALL[r.idx()] == r`).
    pub const ALL: [Res; N_RES] = {
        use Res::*;
        [
            Wood, Stone, Grain, Fish, Meat, Fruit, Horses, Wool, Iron, Brick, Bread, Clothes, Beer, Nitrate, Gunpowder, Furniture, Books, Circus, Coal, Steel, Explosives, CannedFood, Heating, Newspapers, Electricity, Oil, Aluminum, Radios, Uranium, Cars, Tvs,
        ]
    };

    pub fn idx(self) -> usize {
        self as usize
    }

    /// `None` for an index that isn't a resource, so junk can't crash anything.
    pub fn from_idx(i: usize) -> Option<Res> {
        Res::ALL.get(i).copied()
    }

    /// The era a resource first matters in: 0 Ancient, 1 Medieval, 2
    /// Gunpowder, 3 Industrial, 4 Modern, 5 Atomic.
    /// Is this something residents want at home (food, clothes, books...)?
    /// Each house holds one slot of each good it uses; see `house_max_goods`.
    pub fn is_house_good(self) -> bool {
        use Res::*;
        matches!(self, Grain | Fish | Meat | Fruit | Bread | Clothes | Beer | Furniture | Books | Circus | CannedFood | Heating | Newspapers | Electricity | Radios | Cars | Tvs)
    }

    pub fn era(self) -> u8 {
        use Res::*;
        match self {
            Wood | Stone | Grain | Fish | Meat | Fruit | Horses => 0,
            Wool | Iron | Brick | Bread | Clothes | Beer => 1,
            Nitrate | Gunpowder | Furniture | Books | Circus => 2,
            Coal | Steel | Explosives | CannedFood | Heating | Newspapers => 3,
            Electricity | Oil | Aluminum | Radios => 4,
            Uranium | Cars | Tvs => 5,
        }
    }
}

/// What an extractor has to stand next to. Deposits never run out.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Dep {
    Fertile = 0,
    Forest = 1,
    Stone = 2,
    Horses = 3,
    Game = 4,
    /// Not a deposit on the map: open water next to the building.
    Water = 5,
    /// Medieval: iron ore, clay pits, and hills where sheep graze.
    Iron = 6,
    Clay = 7,
    Hills = 8,
    /// Gunpowder: saltpeter crusts, for nitrate.
    Nitrate = 9,
    /// Industrial: a coal seam.
    Coal = 10,
    /// Modern: oil, and bauxite for aluminum.
    Oil = 11,
    Bauxite = 12,
    /// Atomic: uranium ore.
    Uranium = 13,
}

impl Dep {
    pub fn from_u8(v: u8) -> Option<Dep> {
        Some(match v {
            0 => Dep::Fertile,
            1 => Dep::Forest,
            2 => Dep::Stone,
            3 => Dep::Horses,
            4 => Dep::Game,
            5 => Dep::Water,
            6 => Dep::Iron,
            7 => Dep::Clay,
            8 => Dep::Hills,
            9 => Dep::Nitrate,
            10 => Dep::Coal,
            11 => Dep::Oil,
            12 => Dep::Bauxite,
            13 => Dep::Uranium,
            _ => return None,
        })
    }
}

/// What a unit or building is in a fight. Counters work by class, so they
/// carry across eras: line infantry beats mounted, mounted beats ranged,
/// ranged beats line, siege beats buildings.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Class {
    /// Workers.
    Civilian,
    /// Fighters (bombers fly too, but they're siege).
    Air,
    Line,
    Ranged,
    Mounted,
    Siege,
    Building,
}

/// Every kind of entity. Units are numbered from 0, buildings from 64
/// (`BUILDINGS_FROM`), so there's room for many of each. The explicit
/// numbers are what JavaScript sees over the FFI boundary; saves store them
/// too, so renumbering means bumping the save `VERSION`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    /// A person who isn't a soldier: works at producers, builds (and is used
    /// up doing it), or stands free at the campfire (see people.rs).
    Worker = 0,
    Spearman = 1,
    Archer = 2,
    Horseman = 3,
    Swordsman = 5,
    Crossbowman = 6,
    Knight = 7,
    Trebuchet = 8,
    Musketeer = 9,
    Dragoon = 10,
    Cannon = 11,
    Rifleman = 12,
    MachineGunner = 13,
    FieldGun = 14,
    Infantry = 15,
    Tank = 16,
    Fighter = 17,
    Bomber = 18,
    RocketArtillery = 19,
    Jet = 20,
    Capitol = 64,
    Barracks = 65,
    Range = 66,
    Stable = 67,
    Tower = 68,
    Farm = 69,
    LumberCamp = 70,
    Quarry = 71,
    FishingHut = 72,
    HuntingLodge = 73,
    Orchard = 74,
    Pasture = 75,
    // 76 was the Wonder (removed October 2026).
    Hut = 77,
    Cottage = 78,
    SheepFarm = 79,
    IronMine = 80,
    Brickworks = 81,
    Bakery = 82,
    Weaver = 83,
    Brewery = 84,
    SiegeWorkshop = 85,
    Townhouse = 86,
    SaltpeterWorks = 87,
    PowderMill = 88,
    Carpenter = 89,
    Printer = 90,
    Circus = 91,
    Tenement = 92,
    CoalMine = 93,
    SteelMill = 94,
    ExplosivesWorks = 95,
    Cannery = 96,
    CoalYard = 97,
    Press = 98,
    Factory = 99,
    Apartment = 100,
    OilWell = 101,
    BauxiteMine = 102,
    PowerPlant = 103,
    HaberBosch = 104,
    RadioFactory = 105,
    TankWorks = 106,
    Airfield = 107,
    TowerBlock = 108,
    UraniumMine = 109,
    Reactor = 110,
    CarPlant = 111,
    TvPlant = 112,
    MissileSilo = 113,
    /// The basics in bulk, so they keep up with a big town (playtest: towns
    /// needed dozens of lumber camps): a sawmill (Medieval), then a stone works
    /// and a kiln (Gunpowder).
    Sawmill = 114,
    Stoneworks = 115,
    /// Modern: shoots at aircraft, and shoots down nukes falling near it.
    AirDefense = 116,
    Kiln = 117,
}

/// Kinds numbered from here on are buildings.
pub const BUILDINGS_FROM: u32 = 64;

/// A list of resources and how many slots of each, such as a cost.
pub type Slots = &'static [(Res, u16)];

/// The numbers that define a unit or building.
pub struct Stats {
    pub hp: f32,
    pub attack: f32,
    /// Attack reach, measured from the attacker's edge to the target's edge.
    pub range: f32,
    pub cooldown: f32,
    /// Tiles per second (0 for buildings).
    pub speed: f32,
    pub sight: f32,
    /// Slots it holds while it exists (or is queued, or is a foundation).
    pub cost: Slots,
    /// Slots it makes once built (extractors, and the Capitol).
    pub produces: Slots,
    /// Slots it borrows to make its output: a converter (a bakery borrows
    /// grain to make bread). It holds them while it stands, crewed or not;
    /// without them free, it makes nothing.
    pub consumes: Slots,
    /// Residents it needs at work to produce. Without its full crew it makes nothing.
    pub workers: u8,
    /// Builders who must arrive at the foundation before it starts to rise.
    /// They're used up: each one was a person.
    pub builders: u8,
    /// The deposit it has to be built next to, if any.
    pub needs_deposit: Option<Dep>,
    /// Seconds to train, or seconds of work to construct.
    pub time: f32,
    /// Footprint in tiles (square). 0 for units.
    pub size: i32,
}

// `const fn` can run at compile time, so these tables cost nothing at runtime.
#[allow(clippy::too_many_arguments)]
const fn unit(hp: f32, attack: f32, range: f32, cooldown: f32, speed: f32, sight: f32, cost: Slots, time: f32) -> Stats {
    Stats { hp, attack, range, cooldown, speed, sight, cost, produces: &[], consumes: &[], workers: 0, builders: 0, needs_deposit: None, time, size: 0 }
}
const fn building(hp: f32, sight: f32, cost: Slots, time: f32, size: i32) -> Stats {
    Stats { hp, attack: 0.0, range: 0.0, cooldown: 0.0, speed: 0.0, sight, cost, produces: &[], consumes: &[], workers: 0, builders: 1, needs_deposit: None, time, size }
}
/// A building that makes slots from a deposit next to it (or from nothing, for farms).
const fn extractor(hp: f32, cost: Slots, makes: Slots, workers: u8, dep: Option<Dep>, time: f32, size: i32) -> Stats {
    Stats { produces: makes, workers, needs_deposit: dep, ..building(hp, 3.0, cost, time, size) }
}
/// A building that borrows slots of one resource to make another.
const fn converter(hp: f32, cost: Slots, takes: Slots, makes: Slots, workers: u8, time: f32) -> Stats {
    Stats { produces: makes, consumes: takes, workers, ..building(hp, 3.0, cost, time, 2) }
}

use Res::*;

// Units. Every number here is a first guess, to be tuned in play. Every
// unit is a worker who went to train (see `Game::queue_unit`).
//                                    hp   atk  range  cd   speed sight cost          time
static WORKER: Stats = unit(45.0, 3.0, 0.4, 1.5, 2.3, 6.0, &[], 10.0);
static SPEARMAN: Stats = unit(95.0, 8.0, 0.4, 1.5, 2.1, 6.0, &[(Wood, 1)], 15.0);
static ARCHER: Stats = unit(55.0, 6.0, 5.5, 1.8, 2.1, 8.0, &[(Wood, 1)], 16.0);
static HORSEMAN: Stats = unit(120.0, 9.0, 0.4, 1.6, 3.6, 7.0, &[(Horses, 1)], 20.0);
// Medieval: better numbers in the same classes, costing iron.
static SWORDSMAN: Stats = unit(140.0, 11.0, 0.4, 1.4, 2.0, 6.0, &[(Iron, 1)], 18.0);
static CROSSBOWMAN: Stats = unit(70.0, 9.0, 6.0, 2.2, 2.0, 8.0, &[(Wood, 1), (Iron, 1)], 18.0);
static KNIGHT: Stats = unit(190.0, 14.0, 0.4, 1.6, 3.3, 7.0, &[(Horses, 1), (Iron, 1)], 24.0);
// Slow, long reach, poor against people, crushing against walls.
static TREBUCHET: Stats = unit(150.0, 40.0, 9.0, 5.0, 1.0, 9.0, &[(Wood, 3)], 30.0);
// Gunpowder: firearms. Musketeers are line infantry that shoot (bayonets
// keep riders off); dragoons ride and shoot; cannon outrange trebuchets.
static MUSKETEER: Stats = unit(130.0, 16.0, 4.5, 2.8, 2.0, 7.0, &[(Iron, 1), (Gunpowder, 1)], 20.0);
static DRAGOON: Stats = unit(170.0, 13.0, 3.0, 2.2, 3.4, 8.0, &[(Horses, 1), (Gunpowder, 1)], 24.0);
static CANNON: Stats = unit(180.0, 55.0, 10.0, 6.0, 1.1, 9.0, &[(Iron, 2), (Gunpowder, 1)], 32.0);
// Industrial: rifles and machine guns in steel; field guns fire shells
// (explosives) and are drawn by horses.
static RIFLEMAN: Stats = unit(150.0, 20.0, 6.0, 2.2, 2.1, 8.0, &[(Steel, 1), (Gunpowder, 1)], 22.0);
static MACHINE_GUNNER: Stats = unit(120.0, 9.0, 6.5, 0.5, 1.8, 8.0, &[(Steel, 1), (Gunpowder, 2)], 26.0);
static FIELD_GUN: Stats = unit(220.0, 80.0, 12.0, 5.0, 1.6, 10.0, &[(Steel, 2), (Explosives, 1), (Horses, 1)], 34.0);
// Modern: infantry with automatic weapons (they can shoot at aircraft),
// tanks, and aircraft. Fighters fight in the air and strafe; bombers fly
// over buildings and drop their bombs (range 1: right over the target).
static INFANTRY: Stats = unit(170.0, 14.0, 6.0, 1.0, 2.2, 8.0, &[(Steel, 1), (Explosives, 1)], 22.0);
static TANK: Stats = unit(520.0, 45.0, 7.0, 2.5, 2.6, 8.0, &[(Steel, 2), (Oil, 1), (Explosives, 1)], 36.0);
static FIGHTER: Stats = unit(160.0, 18.0, 4.0, 0.8, 6.0, 11.0, &[(Aluminum, 1), (Oil, 1)], 28.0);
static BOMBER: Stats = unit(260.0, 140.0, 1.0, 4.0, 4.0, 9.0, &[(Aluminum, 2), (Oil, 1), (Explosives, 2)], 40.0);
// Atomic: rocket artillery outranges everything; jets are faster, tougher fighters.
static ROCKET_ARTILLERY: Stats = unit(200.0, 70.0, 13.0, 4.0, 2.2, 10.0, &[(Steel, 2), (Oil, 1), (Explosives, 2)], 36.0);
static JET: Stats = unit(220.0, 26.0, 4.5, 0.6, 9.0, 13.0, &[(Aluminum, 2), (Oil, 2)], 32.0);

// The Capitol makes a little of the basics by itself, with no workers, and
// has `CAPITOL_BEDS` beds, so a game can start with two workers and no
// houses: the first hut's wood and food come from it. From the Medieval era
// a player can found more, as many as they like; those hold their cost like
// any building, the first one holds nothing. A player is out only when the
// last one falls.
static CAPITOL: Stats = Stats { attack: 5.0, range: 6.0, cooldown: 2.0, produces: &[(Wood, 2), (Stone, 1), (Grain, 1), (Fruit, 1)], builders: 4, ..building(1600.0, 16.0, &[(Wood, 8), (Stone, 8), (Brick, 6)], 120.0, 3) };
// Houses: beds depend on how many different goods they get. A hut that's
// full and has all the goods it can use becomes a cottage by itself, if the
// cottage's extra wood and stone are free (`Game::upgrade_houses`).
static HUT: Stats = building(300.0, 4.0, &[(Wood, 1)], 12.0, 2);
static COTTAGE: Stats = building(450.0, 4.0, &[(Wood, 2), (Stone, 1)], 12.0, 2);
static TOWNHOUSE: Stats = building(650.0, 4.0, &[(Wood, 2), (Stone, 2), (Brick, 2)], 12.0, 2);
// (Each house is made of what the era before it has: tenements, which bring
// the Industrial era, can't need steel, which only that era makes.)
static TENEMENT: Stats = building(900.0, 4.0, &[(Wood, 2), (Stone, 2), (Brick, 4)], 12.0, 2);
static APARTMENT: Stats = building(1200.0, 4.0, &[(Wood, 1), (Stone, 2), (Brick, 3), (Steel, 2)], 12.0, 2);
static TOWER_BLOCK: Stats = building(1600.0, 4.0, &[(Stone, 2), (Brick, 2), (Steel, 3), (Aluminum, 1)], 12.0, 2);
static BARRACKS: Stats = building(800.0, 6.0, &[(Wood, 3)], 30.0, 3);
static RANGE: Stats = building(800.0, 6.0, &[(Wood, 3), (Stone, 1)], 30.0, 3);
static STABLE: Stats = building(800.0, 6.0, &[(Wood, 3), (Stone, 2)], 35.0, 3);
static TOWER: Stats = Stats { attack: 7.0, range: 7.0, cooldown: 1.5, ..building(700.0, 9.0, &[(Wood, 1), (Stone, 3)], 30.0, 2) };

// Extractors. A lumber camp is free, so a player who has every wood slot in
// use can always make more: there is no way to get stuck.
//                                   hp     cost              makes           workers deposit                time size
static FARM: Stats = extractor(250.0, &[(Wood, 1)], &[(Grain, 2)], 1, None, 12.0, 3);
static LUMBER_CAMP: Stats = extractor(400.0, &[], &[(Wood, 8)], 1, Some(Dep::Forest), 15.0, 2);
static QUARRY: Stats = extractor(500.0, &[(Wood, 2)], &[(Stone, 6)], 2, Some(Dep::Stone), 18.0, 2);
static FISHING_HUT: Stats = extractor(300.0, &[(Wood, 1)], &[(Fish, 2)], 1, Some(Dep::Water), 12.0, 2);
static HUNTING_LODGE: Stats = extractor(300.0, &[(Wood, 1)], &[(Meat, 2)], 1, Some(Dep::Game), 12.0, 2);
static ORCHARD: Stats = extractor(300.0, &[(Wood, 1)], &[(Fruit, 2)], 1, Some(Dep::Fertile), 12.0, 2);
static PASTURE: Stats = extractor(400.0, &[(Wood, 2)], &[(Horses, 2)], 1, Some(Dep::Horses), 15.0, 3);
// Later producers make more, so the basics are scarce at the start and
// plentiful late (playtests: towns needed far too many buildings, and no
// one kind should be needed more than `MAX_SAME` times). Medieval ones make about
// twice what Ancient ones do, Industrial ones and later three to four times.
// Medieval extractors.
static SHEEP_FARM: Stats = extractor(350.0, &[(Wood, 1)], &[(Wool, 4)], 1, Some(Dep::Hills), 14.0, 3);
static IRON_MINE: Stats = extractor(500.0, &[(Wood, 2)], &[(Iron, 8)], 2, Some(Dep::Iron), 20.0, 2);
// No wood in a brickworks, sawmill or kiln: a town using every slot of
// wood from as many lumber camps as it may have can still build its way
// out (stone, then brick, then a sawmill).
static BRICKWORKS: Stats = extractor(450.0, &[(Stone, 2)], &[(Brick, 6)], 2, Some(Dep::Clay), 18.0, 2);

// Converters: they borrow their inputs, as long as they're free.
//                                  hp     cost                       takes          makes          workers time
static BAKERY: Stats = converter(400.0, &[(Wood, 1), (Stone, 1)], &[(Grain, 2)], &[(Bread, 4)], 1, 16.0);
static WEAVER: Stats = converter(350.0, &[(Wood, 2)], &[(Wool, 2)], &[(Clothes, 4)], 1, 16.0);
static BREWERY: Stats = converter(400.0, &[(Wood, 1), (Brick, 1)], &[(Grain, 2)], &[(Beer, 4)], 1, 16.0);
static SIEGE_WORKSHOP: Stats = building(800.0, 6.0, &[(Wood, 3), (Brick, 2)], 35.0, 3);

// Gunpowder.
static SALTPETER_WORKS: Stats = extractor(400.0, &[(Wood, 1), (Brick, 1)], &[(Nitrate, 10)], 2, Some(Dep::Nitrate), 18.0, 2);
static POWDER_MILL: Stats = converter(450.0, &[(Wood, 2), (Brick, 1)], &[(Nitrate, 2), (Wood, 1)], &[(Gunpowder, 10)], 2, 20.0);
static CARPENTER: Stats = converter(400.0, &[(Wood, 1), (Brick, 1)], &[(Wood, 2)], &[(Furniture, 6)], 1, 16.0);
static PRINTER: Stats = converter(400.0, &[(Stone, 1), (Brick, 2)], &[(Wood, 2)], &[(Books, 6)], 1, 18.0);
// The circus: costly, and it borrows horses, but four houses get a show.
static CIRCUS: Stats = Stats { produces: &[(Circus, 8)], consumes: &[(Horses, 2)], workers: 3, ..building(900.0, 5.0, &[(Wood, 4), (Stone, 3), (Brick, 3)], 40.0, 3) };

// Industrial.
static COAL_MINE: Stats = extractor(600.0, &[(Wood, 2), (Brick, 1)], &[(Coal, 16)], 2, Some(Dep::Coal), 20.0, 2);
static STEEL_MILL: Stats = Stats { produces: &[(Steel, 12)], consumes: &[(Iron, 2), (Coal, 2)], workers: 3, ..building(1000.0, 4.0, &[(Stone, 2), (Brick, 3)], 35.0, 3) };
static EXPLOSIVES_WORKS: Stats = converter(600.0, &[(Brick, 2), (Steel, 1)], &[(Nitrate, 2), (Coal, 1)], &[(Explosives, 8)], 2, 25.0);
static CANNERY: Stats = converter(600.0, &[(Brick, 2), (Steel, 1)], &[(Fish, 1), (Meat, 1)], &[(CannedFood, 10)], 2, 22.0);
static COAL_YARD: Stats = converter(450.0, &[(Wood, 1), (Brick, 1)], &[(Coal, 2)], &[(Heating, 10)], 1, 16.0);
static PRESS: Stats = converter(600.0, &[(Brick, 2), (Steel, 1)], &[(Wood, 2)], &[(Newspapers, 10)], 2, 22.0);
static FACTORY: Stats = building(1100.0, 6.0, &[(Brick, 4), (Steel, 2)], 40.0, 3);

// Modern. Power plants burn coal; the Haber–Bosch plant makes nitrate
// from coal and electricity, for players with no saltpeter.
static OIL_WELL: Stats = extractor(600.0, &[(Steel, 1), (Brick, 1)], &[(Oil, 12)], 2, Some(Dep::Oil), 25.0, 2);
static BAUXITE_MINE: Stats = extractor(600.0, &[(Wood, 1), (Steel, 1)], &[(Aluminum, 12)], 2, Some(Dep::Bauxite), 25.0, 2);
static POWER_PLANT: Stats = Stats { produces: &[(Electricity, 16)], consumes: &[(Coal, 2)], workers: 2, ..building(1000.0, 4.0, &[(Brick, 3), (Steel, 2)], 35.0, 3) };
static HABER_BOSCH: Stats = converter(800.0, &[(Brick, 2), (Steel, 2)], &[(Coal, 1), (Electricity, 2)], &[(Nitrate, 12)], 2, 30.0);
static RADIO_FACTORY: Stats = converter(700.0, &[(Brick, 2), (Steel, 1)], &[(Steel, 1), (Electricity, 1)], &[(Radios, 10)], 2, 25.0);
static TANK_WORKS: Stats = building(1300.0, 6.0, &[(Brick, 3), (Steel, 3)], 40.0, 3);
// A big job: three builders.
static AIRFIELD: Stats = Stats { builders: 3, ..building(1200.0, 8.0, &[(Brick, 2), (Steel, 2), (Aluminum, 1)], 45.0, 4) };

// Atomic. The reactor makes far more electricity than a coal plant.
static URANIUM_MINE: Stats = extractor(700.0, &[(Steel, 2), (Brick, 1)], &[(Uranium, 8)], 2, Some(Dep::Uranium), 30.0, 2);
static REACTOR: Stats = Stats { produces: &[(Electricity, 32)], consumes: &[(Uranium, 1)], workers: 3, builders: 2, ..building(1500.0, 4.0, &[(Steel, 4), (Brick, 3)], 50.0, 3) };
static CAR_PLANT: Stats = converter(900.0, &[(Steel, 2), (Brick, 2)], &[(Steel, 1), (Oil, 1)], &[(Cars, 10)], 3, 30.0);
static TV_PLANT: Stats = converter(800.0, &[(Steel, 1), (Brick, 2)], &[(Aluminum, 1), (Electricity, 1)], &[(Tvs, 10)], 2, 28.0);
// The basics in bulk. A sawmill stands by a forest like a lumber camp, a
// stone works by stone like a quarry, a kiln by clay like a brickworks, and
// each makes as much as several of them with fewer hands.
static SAWMILL: Stats = extractor(900.0, &[(Stone, 2), (Brick, 1)], &[(Wood, 16)], 2, Some(Dep::Forest), 30.0, 3);
static STONEWORKS: Stats = extractor(1000.0, &[(Wood, 2), (Brick, 2)], &[(Stone, 14)], 2, Some(Dep::Stone), 30.0, 3);
static KILN: Stats = extractor(900.0, &[(Stone, 4)], &[(Brick, 20)], 2, Some(Dep::Clay), 30.0, 3);
// Modern: a surface-to-air missile battery, and the only defense against a
// nuke: one falling within `AIR_DEFENSE_COVER` of it is shot down
// (`Game::update_nukes`). Its missiles are slow to reload but bring down
// any aircraft in one hit (a bomber has 260 health).
static AIR_DEFENSE: Stats = Stats { attack: 320.0, range: AIR_DEFENSE_COVER, cooldown: 5.0, ..building(1000.0, 12.0, &[(Steel, 2), (Brick, 1), (Explosives, 1)], 35.0, 2) };
static MISSILE_SILO: Stats = Stats { builders: 2, ..building(1500.0, 6.0, &[(Steel, 4), (Brick, 2)], 60.0, 3) };

/// The nuke: a missile silo arms one (holding these slots while it waits),
/// then it can be launched at any spot on the map. Everyone sees it coming.
pub const NUKE_COST: Slots = &[(Uranium, 2), (Explosives, 2)];
/// Seconds to arm a nuke, and for it to fly.
pub const NUKE_ARM_TIME: f32 = 120.0;
pub const NUKE_FLIGHT: f32 = 20.0;
/// Everything within this many tiles of the blast takes damage (units die),
/// buildings up to `NUKE_DAMAGE`, less further out. The crater stays.
pub const NUKE_RADIUS: f32 = 15.0;
pub const NUKE_DAMAGE: f32 = 2400.0;
pub const CRATER_RADIUS: f32 = 2.4;
/// An air defense shoots down any nuke falling this close to it (twice
/// the first nuke's reach), then needs `AIR_DEFENSE_RELOAD` seconds before
/// it can stop another. It also shoots at aircraft out to here.
pub const AIR_DEFENSE_COVER: f32 = 10.0;
pub const AIR_DEFENSE_RELOAD: f32 = 90.0;
/// Beds in every finished Capitol: room for the two workers a game starts
/// with, and two newcomers.
pub const CAPITOL_BEDS: u32 = 4;

/// Shells, rockets and bombs hurt everything hostile within this many
/// tiles of where they land (0: just their target), with `SPLASH_SHARE` of
/// their attack at the middle, less further out.
pub fn splash_radius(k: Kind) -> f32 {
    match k {
        Kind::Cannon => 1.2,
        Kind::FieldGun => 1.6,
        Kind::RocketArtillery => 2.2,
        Kind::Bomber => 2.0,
        _ => 0.0,
    }
}
pub const SPLASH_SHARE: f32 = 0.5;

/// Unsupplied units (more held than supplied, newest first) lose this
/// fraction of their maximum health every second. 0 turns it off.
pub const UNSUPPLIED_DAMAGE: f32 = 0.01;

/// Seconds between newcomers arriving at a player's campfire, while there's
/// a free bed. A bigger town grows faster: 6.7 s with 8 beds, 2.9 s with
/// 40, 1.7 s with 80. Losses are felt (a lost army takes a while to come
/// back) without crippling anyone.
pub fn growth_interval(beds: u32) -> f32 {
    40.0 / (4.0 + beds as f32 / 4.0)
}
/// Beds a house gives for each different good it gets.
pub const BEDS_PER_GOOD: u8 = 2;
/// Beds in a house with this many different goods: `BEDS_PER_GOOD` each,
/// and one more for every good past the third, so bigger houses grow more
/// people per good (playtest: people ran short late in the game). A hut
/// with 3 goods has 6, a cottage with 5 has 12, a tower block with 13, 36.
pub fn beds_for(goods: u32) -> u8 {
    (goods * BEDS_PER_GOOD as u32 + goods.saturating_sub(3)).min(u8::MAX as u32) as u8
}
/// How many different goods a house of this tier can use (3 for a hut).
pub fn house_max_goods(tier: u8) -> u8 {
    3 + 2 * tier
}
/// The balance target: a town shouldn't need more than this many buildings
/// of one kind, apart from farms (fields), houses and Capitols. Not a rule:
/// `econ.rs` checks the numbers against it, and the computer keeps to it.
pub const MAX_SAME: usize = 7;
/// A player enters the next era when this many of their houses have
/// reached its tier (and keeps the era if they later drop back).
pub const HOUSES_FOR_ERA: u32 = 10;
/// The last era there is content for (0 Ancient … 5 Atomic: all of them).
pub const LAST_ERA: u8 = 5;

impl Kind {
    /// Every kind, for loops over all of them: units, then buildings in
    /// tech-tree order (the tech tree panel shows them in this order).
    pub const ALL: [Kind; 73] = {
        use Kind::*;
        [
            Worker, Spearman, Archer, Horseman, Swordsman, Crossbowman, Knight, Trebuchet, Musketeer, Dragoon, Cannon, Rifleman, MachineGunner, FieldGun, Capitol, Hut, Farm, LumberCamp, Quarry, FishingHut, HuntingLodge, Orchard, Pasture,
            Barracks, Range, Stable, Tower, Cottage, SheepFarm, IronMine, Brickworks, Bakery, Weaver, Brewery, SiegeWorkshop, Townhouse, SaltpeterWorks, PowderMill, Carpenter, Printer, Circus, Tenement, CoalMine, SteelMill,
            ExplosivesWorks, Cannery, CoalYard, Press, Factory, Infantry, Tank, Fighter, Bomber, Apartment, OilWell, BauxiteMine, PowerPlant, HaberBosch, RadioFactory, TankWorks, Airfield,
            RocketArtillery, Jet, TowerBlock, UraniumMine, Reactor, CarPlant, TvPlant, MissileSilo, Sawmill, Stoneworks, Kiln, AirDefense,
        ]
    };

    /// Convert a number from JavaScript into a `Kind`. Returns `None` for junk,
    /// so bad input can't crash the game.
    pub fn from_u32(v: u32) -> Option<Kind> {
        Kind::ALL.iter().copied().find(|&k| k as u32 == v)
    }

    pub fn stats(self) -> &'static Stats {
        use Kind::*;
        match self {
            Worker => &WORKER,
            Spearman => &SPEARMAN,
            Archer => &ARCHER,
            Horseman => &HORSEMAN,
            Capitol => &CAPITOL,
            Barracks => &BARRACKS,
            Range => &RANGE,
            Stable => &STABLE,
            Tower => &TOWER,
            Farm => &FARM,
            LumberCamp => &LUMBER_CAMP,
            Quarry => &QUARRY,
            FishingHut => &FISHING_HUT,
            HuntingLodge => &HUNTING_LODGE,
            Orchard => &ORCHARD,
            Pasture => &PASTURE,
            Hut => &HUT,
            Swordsman => &SWORDSMAN,
            Crossbowman => &CROSSBOWMAN,
            Knight => &KNIGHT,
            Trebuchet => &TREBUCHET,
            Cottage => &COTTAGE,
            SheepFarm => &SHEEP_FARM,
            IronMine => &IRON_MINE,
            Brickworks => &BRICKWORKS,
            Bakery => &BAKERY,
            Weaver => &WEAVER,
            Brewery => &BREWERY,
            SiegeWorkshop => &SIEGE_WORKSHOP,
            Musketeer => &MUSKETEER,
            Dragoon => &DRAGOON,
            Cannon => &CANNON,
            Townhouse => &TOWNHOUSE,
            SaltpeterWorks => &SALTPETER_WORKS,
            PowderMill => &POWDER_MILL,
            Carpenter => &CARPENTER,
            Printer => &PRINTER,
            Circus => &CIRCUS,
            Rifleman => &RIFLEMAN,
            MachineGunner => &MACHINE_GUNNER,
            FieldGun => &FIELD_GUN,
            Tenement => &TENEMENT,
            CoalMine => &COAL_MINE,
            SteelMill => &STEEL_MILL,
            ExplosivesWorks => &EXPLOSIVES_WORKS,
            Cannery => &CANNERY,
            CoalYard => &COAL_YARD,
            Press => &PRESS,
            Factory => &FACTORY,
            Infantry => &INFANTRY,
            Tank => &TANK,
            Fighter => &FIGHTER,
            Bomber => &BOMBER,
            Apartment => &APARTMENT,
            OilWell => &OIL_WELL,
            BauxiteMine => &BAUXITE_MINE,
            PowerPlant => &POWER_PLANT,
            HaberBosch => &HABER_BOSCH,
            RadioFactory => &RADIO_FACTORY,
            TankWorks => &TANK_WORKS,
            Airfield => &AIRFIELD,
            RocketArtillery => &ROCKET_ARTILLERY,
            Jet => &JET,
            TowerBlock => &TOWER_BLOCK,
            UraniumMine => &URANIUM_MINE,
            Reactor => &REACTOR,
            CarPlant => &CAR_PLANT,
            TvPlant => &TV_PLANT,
            MissileSilo => &MISSILE_SILO,
            Sawmill => &SAWMILL,
            Stoneworks => &STONEWORKS,
            AirDefense => &AIR_DEFENSE,
            Kiln => &KILN,
        }
    }

    /// Real dependencies between buildings. Mostly, what a player can build
    /// is set by their era (`Kind::era`); these also need another building
    /// finished first. Lose those, and you lose the
    /// ability to build it again (but keep what you already have).
    pub fn requires(self) -> &'static [Kind] {
        use Kind::*;
        match self {
            Range => &[Barracks],
            Stable => &[Barracks, Pasture],
            Tower => &[Quarry],
            Weaver => &[SheepFarm],
            SiegeWorkshop => &[Barracks],
            PowderMill => &[SaltpeterWorks],
            Circus => &[Pasture],
            SteelMill => &[IronMine, CoalMine],
            Press => &[Printer],
            Factory => &[SteelMill],
            HaberBosch => &[PowerPlant],
            RadioFactory => &[PowerPlant],
            TankWorks => &[Factory],
            TvPlant => &[PowerPlant],
            MissileSilo => &[UraniumMine],
            _ => &[],
        }
    }

    /// Every buildable building, in tech-tree order (used by the UI and AI).
    /// Cottages aren't built: huts become cottages.
    #[allow(dead_code)]
    pub const BUILDABLE: [Kind; 48] = {
        use Kind::*;
        [
            Capitol, Hut, Farm, LumberCamp, Quarry, FishingHut, HuntingLodge, Orchard, Pasture, Barracks, Range, Stable, Tower, SheepFarm, IronMine, Brickworks, Bakery, Weaver, Brewery, SiegeWorkshop, SaltpeterWorks, PowderMill,
            Carpenter, Printer, Circus, CoalMine, SteelMill, ExplosivesWorks, Cannery, CoalYard, Press, Factory, OilWell, BauxiteMine, PowerPlant, HaberBosch, RadioFactory, TankWorks, Airfield,
            UraniumMine, Reactor, CarPlant, TvPlant, MissileSilo, Sawmill, Stoneworks, Kiln, AirDefense,
        ]
    };

    /// What fights it is: see `Class` and `damage_mult`.
    pub fn class(self) -> Class {
        use Kind::*;
        match self {
            Worker => Class::Civilian,
            Spearman | Swordsman | Musketeer | Rifleman | Infantry => Class::Line,
            Archer | Crossbowman | MachineGunner => Class::Ranged,
            // Armour fills the mounted role: fast, hits hard, beats the guns.
            Horseman | Knight | Dragoon | Tank => Class::Mounted,
            Trebuchet | Cannon | FieldGun | Bomber | RocketArtillery => Class::Siege,
            Fighter | Jet => Class::Air,
            _ => Class::Building,
        }
    }

    /// The house this one becomes when it grows a tier, if any.
    pub fn upgrade(self) -> Option<Kind> {
        match self {
            Kind::Hut => Some(Kind::Cottage),
            Kind::Cottage => Some(Kind::Townhouse),
            Kind::Townhouse => Some(Kind::Tenement),
            Kind::Tenement => Some(Kind::Apartment),
            Kind::Apartment => Some(Kind::TowerBlock),
            _ => None,
        }
    }

    pub fn is_building(self) -> bool {
        self as u32 >= BUILDINGS_FROM
    }

    pub fn is_military(self) -> bool {
        matches!(self.class(), Class::Line | Class::Ranged | Class::Mounted | Class::Siege | Class::Air)
    }

    /// The era a kind belongs to: 0 Ancient … 5 Atomic. Players can build
    /// and train kinds of their era and earlier.
    pub fn era(self) -> u8 {
        use Kind::*;
        match self {
            Horseman | Stable | Pasture | Capitol | Sawmill | Swordsman | Crossbowman | Knight | Trebuchet | Cottage | SheepFarm | IronMine | Brickworks | Bakery | Weaver | Brewery | SiegeWorkshop => 1,
            Stoneworks | Kiln | Musketeer | Dragoon | Cannon | Townhouse | SaltpeterWorks | PowderMill | Carpenter | Printer | Circus => 2,
            Rifleman | MachineGunner | FieldGun | Tenement | CoalMine | SteelMill | ExplosivesWorks | Cannery | CoalYard | Press | Factory => 3,
            Infantry | Tank | Fighter | Bomber | Apartment | OilWell | BauxiteMine | PowerPlant | HaberBosch | RadioFactory | TankWorks | Airfield | AirDefense => 4,
            RocketArtillery | Jet | TowerBlock | UraniumMine | Reactor | CarPlant | TvPlant | MissileSilo => 5,
            _ => 0,
        }
    }

    /// The tier of a house, or `None` for anything that isn't one.
    pub fn house_tier(self) -> Option<u8> {
        match self {
            Kind::Hut => Some(0),
            Kind::Cottage => Some(1),
            Kind::Townhouse => Some(2),
            Kind::Tenement => Some(3),
            Kind::Apartment => Some(4),
            Kind::TowerBlock => Some(5),
            _ => None,
        }
    }

    /// Does it fly? Aircraft cross water and buildings in straight lines,
    /// never bump into anything, and only some units can hit them.
    pub fn is_air(self) -> bool {
        matches!(self, Kind::Fighter | Kind::Bomber | Kind::Jet)
    }

    /// Can it shoot at aircraft? Fighters, machine guns, modern infantry,
    /// towers and the Capitol.
    pub fn hits_air(self) -> bool {
        matches!(self, Kind::Fighter | Kind::Jet | Kind::MachineGunner | Kind::Infantry | Kind::Tower | Kind::Capitol | Kind::AirDefense)
    }

    /// Can `self` attack `target` at all?
    pub fn can_hit(self, target: Kind) -> bool {
        // Air defense shoots only at aircraft.
        if self == Kind::AirDefense {
            return target.is_air();
        }
        !target.is_air() || self.hits_air()
    }

    /// A unit that holds a bed: everything that walks.
    pub fn holds_bed(self) -> bool {
        !self.is_building()
    }

    /// Which units this building can train. A slice of a static array.
    pub fn trains(self) -> &'static [Kind] {
        match self {
            Kind::Barracks => &[Kind::Spearman, Kind::Swordsman, Kind::Musketeer, Kind::Rifleman, Kind::Infantry],
            Kind::TankWorks => &[Kind::Tank],
            Kind::Airfield => &[Kind::Fighter, Kind::Bomber, Kind::Jet],
            Kind::Range => &[Kind::Archer, Kind::Crossbowman, Kind::MachineGunner],
            Kind::Factory => &[Kind::FieldGun, Kind::RocketArtillery],
            Kind::Stable => &[Kind::Horseman, Kind::Knight, Kind::Dragoon],
            Kind::SiegeWorkshop => &[Kind::Trebuchet, Kind::Cannon],
            _ => &[],
        }
    }

    /// Does this building block movement? Farms can be walked on.
    pub fn blocks(self) -> bool {
        self != Kind::Farm
    }

    pub fn radius(self) -> f32 {
        match self {
            Kind::Horseman | Kind::Knight | Kind::Dragoon => 0.42,
            Kind::Trebuchet => 0.45,
            Kind::Cannon | Kind::FieldGun => 0.4,
            Kind::Tank => 0.48,
            Kind::Fighter | Kind::Bomber | Kind::Jet | Kind::RocketArtillery => 0.45,
            Kind::Worker => 0.28,
            _ => 0.32,
        }
    }
}

/// Rock-paper-scissors by class, so it carries across eras: line infantry
/// (spears, swords) beats mounted, mounted beats ranged, ranged beats line.
/// Siege engines are for walls. Matching on the pair of classes says it
/// most plainly.
pub fn damage_mult(attacker: Kind, target: Kind) -> f32 {
    use Class::*;
    match (attacker.class(), target.class()) {
        (Line, Mounted) => 2.5,
        (Mounted, Ranged) => 2.0,
        (Ranged, Line) => 1.5,
        (Ranged, Building) => 0.2,
        (Mounted, Building) => 0.5,
        (Siege, Building) => 3.0,
        (Siege, _) => 0.3,
        (Building, Mounted) => 1.3,
        // Fighters own the air; on the ground they only strafe.
        (Air, _) if target.is_air() => 2.0,
        (Air, _) => 0.5,
        _ => 1.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tables_line_up() {
        for (i, r) in Res::ALL.iter().enumerate() {
            assert_eq!(r.idx(), i);
        }
        for k in Kind::ALL {
            assert_eq!(Kind::from_u32(k as u32), Some(k));
            assert_eq!(k.is_building(), k.stats().size > 0, "{k:?}");
        }
        assert_eq!(Kind::from_u32(63), None);
    }
}
