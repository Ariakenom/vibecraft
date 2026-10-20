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
    /// Medieval: iron ore, clay pits, and hills for sheep.
    Iron = 6,
    Clay = 7,
    Hills = 8,
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
            _ => return None,
        })
    }
}

/// What a unit or building is in a fight. Counters work by class, so they
/// carry across eras: anti-mounted line infantry beats mounted, ranged
/// beats line, mounted beats ranged, siege beats buildings.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Class {
    /// Builders and newcomers.
    Civilian,
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
    Builder = 0,
    Spearman = 1,
    Archer = 2,
    Horseman = 3,
    /// A newcomer walking from the Capitol to a house with a free bed. Not
    /// a unit you command: on arrival they become a resident and vanish.
    Arrival = 4,
    Swordsman = 5,
    Crossbowman = 6,
    Knight = 7,
    Trebuchet = 8,
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
    Wonder = 76,
    Hut = 77,
    Cottage = 78,
    SheepFarm = 79,
    IronMine = 80,
    Brickworks = 81,
    Bakery = 82,
    Weaver = 83,
    Brewery = 84,
    SiegeWorkshop = 85,
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
    /// grain to make bread). Without its inputs free, it makes nothing.
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
// unit also takes one resident from a house (see `Game::queue_unit`).
//                                    hp   atk  range  cd   speed sight cost          time
static BUILDER: Stats = unit(45.0, 3.0, 0.4, 1.5, 2.3, 6.0, &[], 10.0);
static ARRIVAL: Stats = unit(30.0, 0.0, 0.0, 1.0, 2.0, 3.0, &[], 0.0);
static SPEARMAN: Stats = unit(95.0, 8.0, 0.4, 1.5, 2.1, 6.0, &[(Wood, 1)], 15.0);
static ARCHER: Stats = unit(55.0, 6.0, 5.5, 1.8, 2.1, 8.0, &[(Wood, 1)], 16.0);
static HORSEMAN: Stats = unit(120.0, 9.0, 0.4, 1.6, 3.6, 7.0, &[(Horses, 1)], 20.0);
// Medieval: better numbers in the same classes, costing iron.
static SWORDSMAN: Stats = unit(140.0, 11.0, 0.4, 1.4, 2.0, 6.0, &[(Iron, 1)], 18.0);
static CROSSBOWMAN: Stats = unit(70.0, 9.0, 6.0, 2.2, 2.0, 8.0, &[(Wood, 1), (Iron, 1)], 18.0);
static KNIGHT: Stats = unit(190.0, 14.0, 0.4, 1.6, 3.3, 7.0, &[(Horses, 1), (Iron, 1)], 24.0);
// Slow, long reach, terrible against people, crushing against walls.
static TREBUCHET: Stats = unit(150.0, 40.0, 9.0, 5.0, 1.0, 9.0, &[(Wood, 3)], 30.0);

// The Capitol makes a little of the basics by itself, with no workers, so a
// game can start: two kinds of food fill the two starting huts.
static CAPITOL: Stats = Stats { attack: 5.0, range: 6.0, cooldown: 2.0, produces: &[(Wood, 4), (Stone, 2), (Grain, 2), (Fruit, 2)], ..building(1600.0, 9.0, &[], 60.0, 3) };
// Houses: beds depend on how many different goods they get. A hut that's
// full and has all the goods it can use becomes a cottage by itself, if its
// extra wood and stone are free (`Game::upgrade_houses`).
static HUT: Stats = building(300.0, 4.0, &[(Wood, 1)], 12.0, 2);
static COTTAGE: Stats = building(450.0, 4.0, &[(Wood, 2), (Stone, 1)], 12.0, 2);
static BARRACKS: Stats = building(800.0, 6.0, &[(Wood, 3)], 30.0, 3);
static RANGE: Stats = building(800.0, 6.0, &[(Wood, 3), (Stone, 1)], 30.0, 3);
static STABLE: Stats = building(800.0, 6.0, &[(Wood, 3), (Stone, 2)], 35.0, 3);
static TOWER: Stats = Stats { attack: 7.0, range: 7.0, cooldown: 1.5, ..building(700.0, 9.0, &[(Wood, 1), (Stone, 3)], 30.0, 2) };

// Extractors. A lumber camp is free, so a player who has every wood slot in
// use can always make more: there is no way to get stuck.
//                                   hp     cost              makes           workers deposit                time size
static FARM: Stats = extractor(250.0, &[(Wood, 1)], &[(Grain, 2)], 1, None, 12.0, 3);
static LUMBER_CAMP: Stats = extractor(400.0, &[], &[(Wood, 4)], 2, Some(Dep::Forest), 15.0, 2);
static QUARRY: Stats = extractor(500.0, &[(Wood, 2)], &[(Stone, 4)], 2, Some(Dep::Stone), 18.0, 2);
static FISHING_HUT: Stats = extractor(300.0, &[(Wood, 1)], &[(Fish, 2)], 1, Some(Dep::Water), 12.0, 2);
static HUNTING_LODGE: Stats = extractor(300.0, &[(Wood, 1)], &[(Meat, 2)], 1, Some(Dep::Game), 12.0, 2);
static ORCHARD: Stats = extractor(300.0, &[(Wood, 1)], &[(Fruit, 2)], 1, Some(Dep::Fertile), 12.0, 2);
static PASTURE: Stats = extractor(400.0, &[(Wood, 2)], &[(Horses, 2)], 1, Some(Dep::Horses), 15.0, 3);
// Medieval extractors.
static SHEEP_FARM: Stats = extractor(350.0, &[(Wood, 1)], &[(Wool, 2)], 1, Some(Dep::Hills), 14.0, 3);
static IRON_MINE: Stats = extractor(500.0, &[(Wood, 2)], &[(Iron, 3)], 2, Some(Dep::Iron), 20.0, 2);
static BRICKWORKS: Stats = extractor(450.0, &[(Wood, 1), (Stone, 1)], &[(Brick, 3)], 2, Some(Dep::Clay), 18.0, 2);

// Converters: they borrow their inputs, as long as they're free.
//                                  hp     cost                          takes          makes          workers time
static BAKERY: Stats = converter(400.0, &[(Wood, 1), (Stone, 1)], &[(Grain, 2)], &[(Bread, 2)], 1, 16.0);
static WEAVER: Stats = converter(350.0, &[(Wood, 2)], &[(Wool, 2)], &[(Clothes, 2)], 1, 16.0);
static BREWERY: Stats = converter(400.0, &[(Wood, 1), (Brick, 1)], &[(Grain, 2)], &[(Beer, 2)], 1, 16.0);
static SIEGE_WORKSHOP: Stats = building(800.0, 6.0, &[(Wood, 3), (Brick, 2)], 35.0, 3);

// The Wonder holds a great many slots while it stands, needs three builders
// and takes four minutes to rise. No fish: not every map has water nearby.
static WONDER: Stats = Stats { builders: 3, ..building(4000.0, 8.0, &[(Wood, 8), (Stone, 10), (Grain, 2), (Meat, 2), (Fruit, 2), (Horses, 2)], 240.0, 4) };

/// Unsupplied units (more held than supplied, newest first) lose this
/// fraction of their maximum health every second. 0 turns it off.
pub const UNSUPPLIED_DAMAGE: f32 = 0.01;

/// Seconds between newcomers arriving at a player's Capitol, while there's a
/// free bed somewhere.
pub const ARRIVAL_INTERVAL: f32 = 10.0;
/// Beds a house gives for each different good it gets.
pub const BEDS_PER_GOOD: u8 = 2;
/// How many different goods a house of this tier can use (3 for a hut).
pub fn house_max_goods(tier: u8) -> u8 {
    3 + 2 * tier
}
/// A player enters the next era when this many of their houses have
/// reached its tier (and keeps the era if they later drop back).
pub const HOUSES_FOR_ERA: u32 = 10;

impl Kind {
    /// Every kind, for loops over all of them: units, then buildings in
    /// tech-tree order (the tech tree panel shows them in this order).
    pub const ALL: [Kind; 31] = {
        use Kind::*;
        [
            Builder, Spearman, Archer, Horseman, Arrival, Swordsman, Crossbowman, Knight, Trebuchet, Capitol, Hut, Farm, LumberCamp, Quarry, FishingHut, HuntingLodge, Orchard, Pasture, Barracks, Range, Stable, Tower, Wonder, Cottage, SheepFarm,
            IronMine, Brickworks, Bakery, Weaver, Brewery, SiegeWorkshop,
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
            Builder => &BUILDER,
            Arrival => &ARRIVAL,
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
            Wonder => &WONDER,
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
        }
    }

    /// Real dependencies between buildings. Mostly, what a player can build
    /// is set by their era (`Kind::era`); these are the few that also need
    /// another building finished first. Lose those, and you lose the
    /// ability to build it again (but keep what you already have).
    pub fn requires(self) -> &'static [Kind] {
        use Kind::*;
        match self {
            Range => &[Barracks],
            Stable => &[Barracks, Pasture],
            Tower => &[Quarry],
            Wonder => &[Range, Stable, Tower],
            Weaver => &[SheepFarm],
            SiegeWorkshop => &[Barracks],
            _ => &[],
        }
    }

    /// Every buildable building, in tech-tree order (used by the UI and AI).
    /// Cottages aren't built: huts become cottages.
    pub const BUILDABLE: [Kind; 20] = {
        use Kind::*;
        [Hut, Farm, LumberCamp, Quarry, FishingHut, HuntingLodge, Orchard, Pasture, Barracks, Range, Stable, Tower, Wonder, SheepFarm, IronMine, Brickworks, Bakery, Weaver, Brewery, SiegeWorkshop]
    };

    /// What fights it is: see `Class` and `damage_mult`.
    pub fn class(self) -> Class {
        use Kind::*;
        match self {
            Builder | Arrival => Class::Civilian,
            Spearman | Swordsman => Class::Line,
            Archer | Crossbowman => Class::Ranged,
            Horseman | Knight => Class::Mounted,
            Trebuchet => Class::Siege,
            _ => Class::Building,
        }
    }

    /// The house this one becomes when it grows a tier, if any.
    pub fn upgrade(self) -> Option<Kind> {
        match self {
            Kind::Hut => Some(Kind::Cottage),
            _ => None,
        }
    }

    /// The house this one falls back to when it can't keep its goods.
    pub fn downgrade(self) -> Option<Kind> {
        match self {
            Kind::Cottage => Some(Kind::Hut),
            _ => None,
        }
    }

    pub fn is_building(self) -> bool {
        self as u32 >= BUILDINGS_FROM
    }

    pub fn is_military(self) -> bool {
        matches!(self.class(), Class::Line | Class::Ranged | Class::Mounted | Class::Siege)
    }

    /// The era a kind belongs to: 0 Ancient … 5 Atomic. Players can build
    /// and train kinds of their era and earlier.
    pub fn era(self) -> u8 {
        use Kind::*;
        match self {
            Swordsman | Crossbowman | Knight | Trebuchet | Cottage | SheepFarm | IronMine | Brickworks | Bakery | Weaver | Brewery | SiegeWorkshop => 1,
            _ => 0,
        }
    }

    /// The tier of a house, or `None` for anything that isn't one.
    pub fn house_tier(self) -> Option<u8> {
        match self {
            Kind::Hut => Some(0),
            Kind::Cottage => Some(1),
            _ => None,
        }
    }

    /// A unit that holds a bed: everything that walks except arrivals.
    pub fn holds_bed(self) -> bool {
        !self.is_building() && self != Kind::Arrival
    }

    /// Which units this building can train. A slice of a static array.
    pub fn trains(self) -> &'static [Kind] {
        match self {
            Kind::Capitol => &[Kind::Builder],
            Kind::Barracks => &[Kind::Spearman, Kind::Swordsman],
            Kind::Range => &[Kind::Archer, Kind::Crossbowman],
            Kind::Stable => &[Kind::Horseman, Kind::Knight],
            Kind::SiegeWorkshop => &[Kind::Trebuchet],
            _ => &[],
        }
    }

    /// Does this building block movement? Farms can be walked on.
    pub fn blocks(self) -> bool {
        self != Kind::Farm
    }

    pub fn radius(self) -> f32 {
        match self {
            Kind::Horseman | Kind::Knight => 0.42,
            Kind::Trebuchet => 0.45,
            Kind::Builder | Kind::Arrival => 0.28,
            _ => 0.32,
        }
    }
}

/// Rock-paper-scissors by class, so it carries across eras: line infantry
/// (spears, swords) beats mounted, mounted beats ranged, ranged beats line.
/// Siege engines are for walls. Match guards would work too, but matching
/// on the pair of classes says it most plainly.
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
        assert_eq!(Kind::from_u32(12), None);
    }
}
