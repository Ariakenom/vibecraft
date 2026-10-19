//! Static game data: what every unit and building costs and can do.
//!
//! Everything here is `const` / `'static`: it's baked into the binary and
//! never changes at runtime, so the rest of the code can hand out
//! `&'static Stats` references freely without worrying about lifetimes.

/// The four resources. `#[derive]` asks the compiler to write trait impls for us:
/// `Copy` makes this a plain value (like an int) instead of something that "moves".
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Res {
    Food = 0,
    Wood = 1,
    Stone = 2,
    Gold = 3,
}

impl Res {
    pub fn idx(self) -> usize {
        self as usize
    }
    pub fn from_idx(i: usize) -> Res {
        match i {
            0 => Res::Food,
            1 => Res::Wood,
            2 => Res::Stone,
            _ => Res::Gold,
        }
    }
    /// How many resource units per second a citizen gathers.
    pub fn gather_rate(self) -> f32 {
        match self {
            Res::Food => 0.95,
            Res::Wood => 0.8,
            Res::Stone => 0.6,
            Res::Gold => 0.65,
        }
    }
}

/// Every kind of entity. Units are 0..10, buildings are 10+.
/// The explicit numbers are what JavaScript sees over the FFI boundary.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Citizen = 0,
    Spearman = 1,
    Archer = 2,
    Horseman = 3,
    Capitol = 10,
    Barracks = 12,
    Range = 13,
    Stable = 14,
    Tower = 15,
    Settlement = 16,
    Farm = 17,
    Granary = 18,
    Sawmill = 19,
    Mason = 20,
    Smithy = 21,
    Market = 22,
    Temple = 23,
    Wonder = 24,
}

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
    /// [food, wood, stone, gold]
    pub cost: [u32; 4],
    /// Seconds to train, or seconds of work to construct.
    pub time: f32,
    /// Footprint in tiles (square). 0 for units.
    pub size: i32,
    /// Food eaten per minute just by existing. This is what limits army size.
    pub upkeep: f32,
}

// `const fn` can run at compile time, so these tables cost nothing at runtime.
#[allow(clippy::too_many_arguments)]
const fn unit(hp: f32, attack: f32, range: f32, cooldown: f32, speed: f32, sight: f32, cost: [u32; 4], time: f32, upkeep: f32) -> Stats {
    Stats { hp, attack, range, cooldown, speed, sight, cost, time, size: 0, upkeep }
}
const fn building(hp: f32, sight: f32, cost: [u32; 4], time: f32, size: i32) -> Stats {
    Stats { hp, attack: 0.0, range: 0.0, cooldown: 0.0, speed: 0.0, sight, cost, time, size, upkeep: 0.0 }
}

//                                 hp   atk  range  cd   speed sight cost [f, w, s, g]  time  upkeep/min
static CITIZEN: Stats = unit(45.0, 3.0, 0.4, 1.5, 2.3, 6.0, [50, 0, 0, 0], 12.0, 3.0);
static SPEARMAN: Stats = unit(95.0, 8.0, 0.4, 1.5, 2.1, 6.0, [40, 30, 0, 0], 15.0, 5.0);
static ARCHER: Stats = unit(55.0, 6.0, 5.5, 1.8, 2.1, 8.0, [0, 35, 0, 25], 16.0, 5.0);
static HORSEMAN: Stats = unit(120.0, 9.0, 0.4, 1.6, 3.6, 7.0, [60, 0, 0, 45], 20.0, 8.0);

static CAPITOL: Stats = Stats { attack: 5.0, range: 6.0, cooldown: 2.0, ..building(1600.0, 9.0, [0, 0, 0, 0], 60.0, 3) };
static BARRACKS: Stats = building(800.0, 6.0, [0, 150, 0, 0], 30.0, 3);
static RANGE: Stats = building(800.0, 6.0, [0, 175, 0, 0], 30.0, 3);
static STABLE: Stats = building(800.0, 6.0, [0, 150, 50, 0], 35.0, 3);
static TOWER: Stats = Stats { attack: 7.0, range: 7.0, cooldown: 1.5, ..building(700.0, 9.0, [0, 50, 125, 0], 30.0, 2) };
static SETTLEMENT: Stats = building(600.0, 6.0, [0, 100, 0, 0], 20.0, 2);
static FARM: Stats = building(250.0, 2.0, [0, 60, 0, 0], 12.0, 3);
static GRANARY: Stats = building(500.0, 4.0, [0, 120, 0, 0], 25.0, 2);
static SAWMILL: Stats = building(500.0, 4.0, [0, 100, 0, 0], 25.0, 2);
static MASON: Stats = building(600.0, 4.0, [0, 150, 0, 0], 30.0, 2);
static SMITHY: Stats = building(600.0, 4.0, [0, 100, 100, 0], 35.0, 2);
static MARKET: Stats = building(700.0, 5.0, [0, 175, 50, 0], 40.0, 3);
static TEMPLE: Stats = building(900.0, 6.0, [0, 0, 200, 100], 50.0, 2);
// The Wonder takes 2400 citizen-seconds of work: ten builders need four minutes.
static WONDER: Stats = building(4000.0, 8.0, [600, 600, 600, 600], 2400.0, 4);


impl Kind {
    /// Convert a number from JavaScript into a `Kind`. Returns `None` for junk,
    /// so bad input can't crash the game.
    pub fn from_u32(v: u32) -> Option<Kind> {
        use Kind::*;
        Some(match v {
            0 => Citizen,
            1 => Spearman,
            2 => Archer,
            3 => Horseman,
            10 => Capitol,
            12 => Barracks,
            13 => Range,
            14 => Stable,
            15 => Tower,
            16 => Settlement,
            17 => Farm,
            18 => Granary,
            19 => Sawmill,
            20 => Mason,
            21 => Smithy,
            22 => Market,
            23 => Temple,
            24 => Wonder,
            _ => return None,
        })
    }

    pub fn stats(self) -> &'static Stats {
        match self {
            Kind::Citizen => &CITIZEN,
            Kind::Spearman => &SPEARMAN,
            Kind::Archer => &ARCHER,
            Kind::Horseman => &HORSEMAN,
            Kind::Capitol => &CAPITOL,
            Kind::Barracks => &BARRACKS,
            Kind::Range => &RANGE,
            Kind::Stable => &STABLE,
            Kind::Tower => &TOWER,
            Kind::Settlement => &SETTLEMENT,
            Kind::Farm => &FARM,
            Kind::Granary => &GRANARY,
            Kind::Sawmill => &SAWMILL,
            Kind::Mason => &MASON,
            Kind::Smithy => &SMITHY,
            Kind::Market => &MARKET,
            Kind::Temple => &TEMPLE,
            Kind::Wonder => &WONDER,
        }
    }

    /// The tech tree. You can only build a building once you own a finished
    /// example of every building it requires. Lose those, and you lose the
    /// ability to build it again (but keep what you already have).
    pub fn requires(self) -> &'static [Kind] {
        use Kind::*;
        match self {
            Granary => &[Farm],
            Sawmill => &[Settlement],
            Mason => &[Sawmill],
            Range => &[Barracks, Sawmill],
            Tower => &[Mason],
            Smithy => &[Barracks, Mason],
            Stable => &[Smithy],
            Market => &[Granary, Sawmill],
            Temple => &[Market, Mason],
            Wonder => &[Temple, Smithy],
            _ => &[],
        }
    }

    /// Every buildable building, in tech-tree order (used by the UI and AI).
    #[allow(dead_code)]
    pub const BUILDABLE: [Kind; 13] = [
        Kind::Farm,
        Kind::Settlement,
        Kind::Barracks,
        Kind::Granary,
        Kind::Sawmill,
        Kind::Range,
        Kind::Mason,
        Kind::Tower,
        Kind::Smithy,
        Kind::Stable,
        Kind::Market,
        Kind::Temple,
        Kind::Wonder,
    ];

    pub fn is_building(self) -> bool {
        self as u8 >= 10
    }

    pub fn is_military(self) -> bool {
        matches!(self, Kind::Spearman | Kind::Archer | Kind::Horseman)
    }

    /// Which units this building can train. A slice of a static array.
    pub fn trains(self) -> &'static [Kind] {
        match self {
            Kind::Capitol => &[Kind::Citizen],
            Kind::Barracks => &[Kind::Spearman],
            Kind::Range => &[Kind::Archer],
            Kind::Stable => &[Kind::Horseman],
            _ => &[],
        }
    }

    /// Can citizens drop resources off here?
    pub fn is_drop_site(self) -> bool {
        matches!(self, Kind::Capitol | Kind::Settlement)
    }

    /// Does this building block movement? Farms can be walked on.
    pub fn blocks(self) -> bool {
        self != Kind::Farm
    }

    pub fn radius(self) -> f32 {
        match self {
            Kind::Horseman => 0.42,
            Kind::Citizen => 0.28,
            _ => 0.32,
        }
    }
}

/// What owning a finished building does for you, beyond what it unlocks.
/// Each bonus counts once: two Granaries are no better than one.
#[derive(Clone, Copy, Default, Debug)]
pub struct Bonuses {
    /// Multiplier on gathering speed, per resource.
    pub gather: [f32; 4],
    /// Multiplier on soldiers' damage.
    pub attack: f32,
    /// Fraction of max health every unit heals per second.
    pub regen: f32,
    /// Free gold per minute.
    pub gold_per_min: f32,
}

impl Bonuses {
    pub fn from_buildings(has: impl Fn(Kind) -> bool) -> Bonuses {
        let mut b = Bonuses { gather: [1.0; 4], attack: 1.0, ..Default::default() };
        if has(Kind::Granary) {
            b.gather[Res::Food.idx()] += 0.2;
        }
        if has(Kind::Sawmill) {
            b.gather[Res::Wood.idx()] += 0.2;
        }
        if has(Kind::Mason) {
            b.gather[Res::Stone.idx()] += 0.2;
            b.gather[Res::Gold.idx()] += 0.2;
        }
        if has(Kind::Smithy) {
            b.attack = 1.2;
        }
        if has(Kind::Market) {
            b.gold_per_min = 20.0;
        }
        if has(Kind::Temple) {
            b.regen = 0.01;
        }
        b
    }
}

/// Rock-paper-scissors: spears beat horses, horses beat archers, archers beat spears.
/// Match guards (`if ...`) let one arm cover a whole family of cases.
pub fn damage_mult(attacker: Kind, target: Kind) -> f32 {
    use Kind::*;
    match (attacker, target) {
        (Spearman, Horseman) => 2.5,
        (Horseman, Archer) => 2.0,
        (Archer, Spearman) => 1.5,
        (Archer, t) if t.is_building() => 0.2,
        (Horseman, t) if t.is_building() => 0.5,
        (Capitol | Tower, Horseman) => 1.3,
        _ => 1.0,
    }
}
