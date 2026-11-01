//! The simulation: entities, orders, movement, slots, combat, fog of war.
//!
//! The whole game advances in fixed steps of `DT` seconds (`Game::tick`).
//! Fixed steps keep the simulation deterministic no matter the frame rate;
//! the browser just calls `tick()` 20 times a second and interpolates drawing.

use crate::ai::Ai;
use crate::defs::*;
use crate::map::{self, Deposit, Map};
use crate::path::{Goal, Pathfinder};
use crate::people::*;

pub const DT: f32 = 1.0 / 20.0;
pub const GAIA: u8 = 0;
pub const PLAYER: u8 = 1;
/// Up to four players. Player 0 is "nature" (gaia).
pub const MAX_PLAYERS: usize = 4;
/// Each player starts with this many workers at the campfire (none: the
/// Capitol's `CAPITOL_BEDS` fill with newcomers over the first half
/// minute), and no houses.
const START_WORKERS: usize = 0;
/// Seconds until the first newcomer turns up (playtest: 10 was too long to
/// stand around). The next ones follow at `growth_interval`.
const FIRST_ARRIVAL: f32 = 2.0;
const CELL: i32 = 4; // spatial-hash cell size in tiles

/// What a unit is currently trying to do. Enums with data are one of Rust's
/// best features: each variant carries exactly the fields it needs, and
/// `match` forces us to handle every case.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Order {
    Idle,
    Move { x: f32, y: f32 },
    AttackMove { x: f32, y: f32 },
    Attack { target: u32, auto: bool },
    /// A worker walking to a foundation, to be used up there as a builder.
    Build(u32),
    /// A worker walking to a producer, or working there.
    Work(u32),
    /// A free worker walking to a training building, to become a soldier.
    Enlist(u32),
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Anim {
    Idle = 0,
    Walk = 1,
    Work = 2,
    Fight = 3,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum Travel {
    Arrived,
    Moving,
    Blocked,
}

/// Things that happened during a tick that the UI may want to show or play a
/// sound for. The explicit numbers are what JavaScript receives; see
/// `handleEvents` in the web page.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Ev {
    Alert = 1,    // one of the player's things is under attack
    Trained = 2,  // the player finished training a unit
    Built = 3,    // the player finished a building
    Lost = 4,     // the player lost a building
    Death = 5,    // anything died (data = owner * 100 + kind)
    Melee = 6,    // a melee blow landed (data = attacker kind)
    Shoot = 7,    // an arrow was loosed (data = shooter kind)
    Hammer = 9,   // a construction stroke
    ArrowHit = 11, // an arrow struck (data = 1 if it hit a building)
    Short = 12,   // the player holds more than they make, and units suffer (data = resource)
    // 13 was WonderBegun (the Wonder is gone).
    Eliminated = 14, // a player lost their Capitol and is out (data = player)
    NukeArmed = 18,  // a silo has a nuke ready (data = owner); everyone hears
    NukeLaunched = 19, // someone launched a nuke at (x, y) (data = owner); everyone hears
    NukeDetonated = 20, // a nuke fell at (x, y) (data = owner)
    Upgraded = 15,   // one of the player's houses grew a tier (data = new kind)
    Downgraded = 16, // one of the player's houses fell back a tier (data = new kind)
    EraReached = 17, // a player entered an era (data = player * 16 + era)
    // 21 was CapitolLost (losing one Capitol no longer takes its town).
    NukeIntercepted = 22, // an air defense shot down a nuke at (x, y) (data = the nuke's owner)
    SiloBuilt = 23,  // someone finished a missile silo at (x, y) (data = owner); everyone hears
    NukeArming = 24, // someone started arming a nuke (data = owner); everyone hears
    Cheats = 25,     // the host turned cheat mode on or off (data = 1 on); everyone hears
}

/// Why a command was refused. `code()` is the number JavaScript receives.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum CmdError {
    /// Not enough free slots of this resource.
    Short(Res),
    QueueFull,
    NoBuilding,
    BadSpot,
    /// No free worker at the campfire to train.
    NoPeople,
    /// Not until this era.
    Era(u8),
    /// An extractor has to stand next to its deposit.
    NoDeposit(Dep),
    /// The tech tree says no: this building is needed first.
    Locked(Kind),
    /// A house that can't grow yet: a bed is free, or it lacks a good.
    NotReady,
}

impl CmdError {
    pub fn code(self) -> i32 {
        match self {
            CmdError::Short(r) => 1000 + r.idx() as i32,
            CmdError::QueueFull => 10,
            CmdError::NoBuilding => 11,
            CmdError::BadSpot => 12,
            CmdError::NoPeople => 13,
            CmdError::Era(e) => 30 + e as i32,
            CmdError::NoDeposit(d) => 20 + d as i32,
            CmdError::Locked(k) => 2000 + k as i32,
            CmdError::NotReady => 14,
        }
    }
}

/// One unit or building. A single struct for both keeps storage simple;
/// unit-only fields are just unused on buildings and vice versa.
#[derive(Clone)]
pub struct Entity {
    pub id: u32,
    pub kind: Kind,
    pub owner: u8,
    pub alive: bool,
    pub x: f32,
    pub y: f32,
    pub px: f32,
    pub py: f32,
    pub hp: f32,
    pub facing: f32,
    pub anim: Anim,
    pub hit_flash: f32,
    pub selected: bool,
    /// Has the player ever seen this (enemy) building?
    pub seen: bool,
    // --- units ---
    pub order: Order,
    /// Where to go back to after an automatic fight.
    pub resume: Option<(f32, f32)>,
    /// Waypoints, stored in *reverse* so the next one is `path.last()` and `pop()` is cheap.
    pub path: Vec<(f32, f32)>,
    pub goal: Option<Goal>,
    pub repath: f32,
    pub stuck: f32,
    pub cooldown: f32,
    pub scan: f32,
    /// Held more than its owner makes: losing health. Worked out afresh
    /// every tick (`Game::supply_units`), so it isn't saved.
    pub unsupplied: bool,
    /// Producers: workers standing at it now, workers on their way or there
    /// (`hired`), and whether the full crew is there (`crewed`; always for
    /// one that needs none). A converter is `fed` when it has its inputs
    /// too. All worked out every tick (`Game::resolve`), so not saved.
    pub crew: u8,
    pub hired: u8,
    pub crewed: bool,
    pub fed: bool,
    /// Timer for work sounds (hammering).
    pub sfx: f32,
    // --- buildings ---
    pub tx: i32,
    pub ty: i32,
    pub built: f32,
    pub queue: Vec<Kind>,
    pub progress: f32,
    pub rally: Option<(f32, f32)>,
    /// Builders who have reached this foundation (and been used up).
    pub builders_in: u8,
    /// Training buildings: recruits who have walked in and wait to be trained.
    pub recruits: u8,
    /// Producers: whether free workers come to work here by themselves.
    /// Moving its workers away turns it off (the producer is paused).
    pub hiring: bool,
    // --- houses ---
    /// People living here, for drawing: everyone is spread over the houses
    /// nearest the Capitol first. Worked out every tick.
    pub residents: u8,
    /// Which goods this house gets, one bit per resource index. Its beds
    /// follow from how many (`beds_for`).
    pub goods: u32,
    // --- missile silos ---
    /// 0 empty, 1 arming a nuke (progress in `progress`), 2 armed.
    /// (Air defenses count down their reload in `progress`.)
    pub nuke: u8,
    /// The Capitol a player started with: it holds no slots (any they
    /// found later holds its cost).
    pub starting: bool,
}

/// A nuke in flight, from the silo at (sx, sy) to (x, y). Everyone sees it.
#[derive(Clone)]
pub struct Nuke {
    pub owner: u8,
    pub sx: f32,
    pub sy: f32,
    pub x: f32,
    pub y: f32,
    /// Seconds until it lands.
    pub left: f32,
}

impl Entity {
    /// An entity with every field at its default, for loading a save into.
    pub(crate) fn blank(id: u32, kind: Kind, owner: u8) -> Entity {
        Entity::new(id, kind, owner, 0.0, 0.0)
    }

    fn new(id: u32, kind: Kind, owner: u8, x: f32, y: f32) -> Entity {
        Entity {
            id,
            kind,
            owner,
            alive: true,
            x,
            y,
            px: x,
            py: y,
            hp: kind.stats().hp,
            facing: 1.57,
            anim: Anim::Idle,
            hit_flash: 0.0,
            selected: false,
            seen: false,
            order: Order::Idle,
            resume: None,
            path: Vec::new(),
            goal: None,
            repath: 0.0,
            stuck: 0.0,
            cooldown: 0.0,
            scan: 0.0,
            unsupplied: false,
            crew: 0,
            hired: 0,
            crewed: false,
            fed: false,
            sfx: 0.0,
            tx: 0,
            ty: 0,
            built: 1.0,
            queue: Vec::new(),
            progress: 0.0,
            rally: None,
            builders_in: 0,
            recruits: 0,
            hiring: true,
            residents: 0,
            goods: 0,
            nuke: 0,
            starting: false,
        }
    }

    /// Beds in this house, from how many different goods it gets.
    pub fn beds(&self) -> u8 {
        if self.kind.house_tier().is_some() && self.built >= 1.0 { beds_for(self.goods.count_ones()) } else { 0 }
    }

    pub fn is_building(&self) -> bool {
        self.kind.is_building()
    }

    /// The area to walk to when interacting with this entity.
    pub fn goal(&self, reach: f32) -> Goal {
        if self.is_building() {
            Goal::rect(self.tx, self.ty, self.kind.stats().size, reach)
        } else {
            Goal::point(self.x, self.y, reach + self.kind.radius())
        }
    }

    /// Distance from a point to this entity's edge.
    pub fn edge_dist(&self, x: f32, y: f32) -> f32 {
        if self.is_building() {
            self.goal(0.0).dist(x, y)
        } else {
            ((self.x - x).powi(2) + (self.y - y).powi(2)).sqrt() - self.kind.radius()
        }
    }

    pub(crate) fn set_order(&mut self, order: Order) {
        self.order = order;
        self.path.clear();
        self.goal = None;
        self.stuck = 0.0;
    }
}

#[derive(Clone)]
pub struct Projectile {
    pub x: f32,
    pub y: f32,
    pub px: f32,
    pub py: f32,
    pub target: u32,
    pub damage: f32,
    pub attacker: u32,
    pub alive: bool,
    /// For drawing only: where it was loosed, by what kind, and whether it
    /// flies at a building (the page arcs it from the bow to the target).
    pub sx: f32,
    pub sy: f32,
    pub shooter: Kind,
    pub at_building: bool,
}

#[derive(Clone, Copy)]
pub struct Player {
    /// Slots of each resource this player's producers make.
    pub supply: [u16; N_RES],
    /// Slots of each resource held by everything this player has: buildings
    /// (finished or not), units, units in training queues. `supply` and
    /// `used` are worked out afresh every tick (`Game::resolve`), so
    /// they aren't saved; `pay` adds to `used` at once so that two commands
    /// in one tick can't both spend the same free slot.
    pub used: [u16; N_RES],
    /// Supply in percent: the difficulty handicap or bonus (the AI's only
    /// "cheat"). 100 for people.
    pub supply_pct: u16,
    /// Seconds until the next newcomer may arrive. Saved.
    pub arrive_timer: f32,
    /// The era this player has reached: 0 Ancient … 5 Atomic. Never goes
    /// back. (Phase 4 raises it, when enough houses reach a tier.) Saved.
    pub era: u8,
    // Worked out every tick (`Game::resolve`), so not saved:
    /// Slots of each good held by houses. They come last: buildings and
    /// units always get what they hold, houses get what's left.
    pub housed: [u16; N_RES],
    /// Beds in all houses; people (everyone: workers, soldiers, recruits
    /// in training); free workers at the campfire; workers at (or walking
    /// to) producers; soldiers and recruits.
    pub beds: u32,
    pub people: u32,
    pub free: u32,
    pub working: u32,
    pub soldiers: u32,
    /// Lost their Capitol: out of the game.
    pub defeated: bool,
    /// Cheat mode (the host's switch, for people, not the computer): they
    /// can build and train anything, of any era, and nothing they have
    /// holds slots. Saved.
    pub cheat: bool,
    /// Some of this player's units were unsupplied last tick. Only used to
    /// tell the player once when it starts.
    pub short: bool,
    pub trained: u32,
    pub lost: u32,
    /// Buildings finished, for the end-of-game numbers.
    pub built: u32,
}

impl Player {
    pub(crate) fn new(supply_pct: u16) -> Player {
        Player {
            supply: [0; N_RES],
            used: [0; N_RES],
            supply_pct,
            arrive_timer: FIRST_ARRIVAL,
            era: 0,
            housed: [0; N_RES],
            beds: 0,
            people: 0,
            free: 0,
            working: 0,
            soldiers: 0,
            defeated: false,
            cheat: false,
            short: false,
            trained: 0,
            lost: 0,
            built: 0,
        }
    }

    /// Free slots of a resource for building and training: supply minus
    /// use. Negative when short. Goods in houses don't count: houses give
    /// them up.
    pub fn free(&self, r: Res) -> i32 {
        self.supply[r.idx()] as i32 - self.used[r.idx()] as i32
    }

    /// What's left over after houses took their goods too.
    pub fn spare(&self, r: Res) -> i32 {
        self.free(r) - self.housed[r.idx()] as i32
    }
}

/// What a right-click means (see `Game::intent`).
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Intent {
    Nothing,
    Rally,
    Attack(u32),
    Build(u32),
    Work(u32),
    Move,
}

/// Everything a player can tell the game to do. Owning `Vec`s means a
/// command can be built in one place and applied later (a few ticks from
/// now, in multiplayer).
#[derive(Clone, Debug)]
pub enum Command {
    Smart { ids: Vec<u32>, x: f32, y: f32 },
    AttackMove { ids: Vec<u32>, x: f32, y: f32 },
    Stop { ids: Vec<u32> },
    Train { ids: Vec<u32>, kind: Kind },
    Cancel { id: u32 },
    Place { ids: Vec<u32>, kind: Kind, tx: i32, ty: i32 },
    /// Give up: everything this player owns falls, as if their Capitol had.
    Surrender,
    /// Tear down your own buildings (not a Capitol), or have your own
    /// units fall on their swords.
    Demolish { ids: Vec<u32> },
    /// Pause producers (their workers go to the campfire) or resume them.
    Hire { ids: Vec<u32>, on: bool },
    /// Start arming a nuke in a missile silo.
    Arm { id: u32 },
    /// Launch a silo's armed nuke at (x, y).
    Launch { id: u32, x: f32, y: f32 },
    /// Grow houses into the next kind, where they can (`Game::house_upgrade`).
    Upgrade { ids: Vec<u32> },
}

pub enum Pick {
    Ent(u32),
    /// A deposit tile: nothing to do there, but it stops a click.
    Dep,
    Nothing,
}

// `Clone` on the whole game is what multiplayer's prediction rests on: the
// live copy you play in can be thrown away and replaced by a copy of the
// confirmed one. `derive` writes the copying code for every field, as long
// as every field's type can be cloned too (hence the derives above).
#[derive(Clone)]
pub struct Game {
    /// The map seed. Kept so a saved game can be redrawn the same way.
    pub seed: u32,
    pub map: Map,
    pub deps: Vec<Deposit>,
    pub ents: Vec<Entity>,
    /// Index 0 is unused (gaia); players are 1..=n_players.
    pub players: Vec<Player>,
    pub n_players: u8,
    pub proj: Vec<Projectile>,
    /// Nukes in flight, and where they fell (craters stay on the map).
    pub nukes: Vec<Nuke>,
    pub craters: Vec<(f32, f32)>,
    pub time: f32,
    /// Per tile, for the human player: 0 never seen, 1 explored, 2 visible now.
    pub fog: Vec<u8>,
    /// Per tile, one bit per player (bit `p`): has player `p` ever seen it?
    /// Unlike `fog`, kept for everyone, so it's part of the game: the AI only
    /// builds on ground and deposits it has explored.
    pub explored: Vec<u8>,
    fog_timer: f32,
    /// 0 while playing, 1 once someone has won.
    pub state: u8,
    /// Who won (1 to 4).
    pub winner: u8,
    /// Whose eyes this computer sees through: fog of war, alerts, the HUD.
    /// Always 1 in single player. In multiplayer it's 1 for the host and 2
    /// for the guest. None of the game's rules depend on it.
    pub local: u8,
    /// Lift the fog of war: see the whole map (spectators, replays, players
    /// who are out). Like `local`, only what this computer shows depends on it.
    pub reveal: bool,

    /// Notifications for the UI: groups of 4 floats [type, x, y, data].
    pub events: Vec<f32>,
    /// One computer brain per player slot; `on` says who it plays for.
    pub ais: Vec<Ai>,
    pf: Pathfinder,
    grid: Vec<Vec<u32>>,
    alert_cooldown: f32,
    idle_cursor: u32,
}

/// A computer player's supply, in percent, at each difficulty: Hard gets a
/// bonus (Easy plays slower instead, see `EASY_ERA_AT`).
pub fn handicap(difficulty: u32) -> u16 {
    if difficulty >= 2 { 130 } else { 100 }
}

impl Game {
    /// A new game: player 1 is the human, the rest are computer players.
    pub fn new(seed: u32, difficulty: u32, n_players: u8) -> Game {
        let n_players = n_players.clamp(2, MAX_PLAYERS as u8);
        let (map, deps, bases) = map::generate(seed, n_players as usize);
        let n = (map.w * map.h) as usize;
        let handicap = handicap(difficulty);
        // Player 1 is the human; the computer players get the handicap.
        let players = (0..=n_players).map(|p| Player::new(if p > 1 { handicap } else { 100 })).collect();
        // Each AI thinks on a slightly different tick, so they don't all spike at once.
        let ais = (0..=n_players).map(|p| Ai::new(difficulty, p > 1, p as f32 * 0.13)).collect();
        let mut g = Game::from_parts(seed, map, deps, Vec::new(), players, n_players, Vec::new(), vec![0; n], ais, PLAYER);
        for (i, &(bx, by)) in bases.iter().enumerate() {
            let owner = i as u8 + 1;
            let cap = g.spawn_building(Kind::Capitol, owner, bx - 1, by - 1, 1.0);
            g.ents[cap as usize].starting = true;
            for _ in 0..START_WORKERS {
                g.spawn_worker(owner, None);
            }
        }
        g.resolve();
        g.update_fog();
        g.explore();
        g
    }

    /// Assemble a game from its stored parts; scratch space (pathfinder
    /// buffers, the spatial grid) is made fresh. Used by `new` and `load`.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_parts(seed: u32, map: Map, deps: Vec<Deposit>, ents: Vec<Entity>, players: Vec<Player>, n_players: u8, proj: Vec<Projectile>, fog: Vec<u8>, ais: Vec<Ai>, local: u8) -> Game {
        let n = (map.w * map.h) as usize;
        let cells = ((map.w / CELL + 1) * (map.h / CELL + 1)) as usize;
        let mut g = Game {
            seed,
            map,
            deps,
            ents,
            players,
            n_players,
            proj,
            nukes: Vec::new(),
            craters: Vec::new(),
            time: 0.0,
            fog,
            explored: vec![0; n],
            fog_timer: 0.0,
            state: 0,
            winner: 0,
            local,
            reveal: false,
            events: Vec::new(),
            ais,
            pf: Pathfinder::new(n),
            grid: vec![Vec::new(); cells],
            alert_cooldown: 0.0,
            idle_cursor: 0,
        };
        // Slots aren't saved: they follow from what exists. Only counted
        // here: a loaded game settles its houses on its next tick, exactly
        // as the saved one would have.
        g.recount();
        g
    }

    /// The private timers, for `save`/`load`.
    pub(crate) fn save_timers(&self) -> (f32, f32, u32) {
        (self.fog_timer, self.alert_cooldown, self.idle_cursor)
    }
    pub(crate) fn load_timers(&mut self, (fog, alert, idle): (f32, f32, u32)) {
        self.fog_timer = fog;
        self.alert_cooldown = alert;
        self.idle_cursor = idle;
    }

    /// Turn a fresh game into a multiplayer game, seen as player `local`.
    /// Every slot starts human; `set_ai` hands slots to the computer.
    pub fn setup_multiplayer(&mut self, local: u8) {
        self.local = local;
        for ai in self.ais.iter_mut() {
            ai.on = false;
        }
        for p in self.players.iter_mut() {
            p.supply_pct = 100; // no difficulty handicap between people
        }
        for e in self.ents.iter_mut() {
            e.seen = e.owner == local;
        }
        self.fog.iter_mut().for_each(|f| *f = 0);
        self.update_fog();
    }

    // -----------------------------------------------------------------------
    // Spawning and lookup

    pub fn spawn_unit(&mut self, kind: Kind, owner: u8, x: f32, y: f32) -> u32 {
        let id = self.ents.len() as u32;
        self.ents.push(Entity::new(id, kind, owner, x, y));
        id
    }

    pub fn spawn_building(&mut self, kind: Kind, owner: u8, tx: i32, ty: i32, built: f32) -> u32 {
        let id = self.ents.len() as u32;
        let size = kind.stats().size;
        let half = size as f32 / 2.0;
        let mut e = Entity::new(id, kind, owner, tx as f32 + half, ty as f32 + half);
        e.tx = tx;
        e.ty = ty;
        e.built = built;
        if built < 1.0 {
            e.hp = kind.stats().hp * 0.1;
        }
        e.seen = owner == self.local;
        self.ents.push(e);
        for y in ty..ty + size {
            for x in tx..tx + size {
                let i = self.map.idx(x, y);
                self.map.bld_at[i] = id as i32;
                if kind.blocks() {
                    self.map.blocked[i] = true;
                }
            }
        }
        if kind.blocks() {
            self.evict_units(tx, ty, size);
        }
        id
    }

    /// Push any units standing on a new building's footprint out to a free tile.
    fn evict_units(&mut self, tx: i32, ty: i32, size: i32) {
        for i in 0..self.ents.len() {
            let e = &self.ents[i];
            if !e.alive || e.is_building() {
                continue;
            }
            let (ux, uy) = (e.x.floor() as i32, e.y.floor() as i32);
            if ux >= tx && ux < tx + size && uy >= ty && uy < ty + size {
                if let Some((nx, ny)) = self.free_tile_near(tx, ty, size, e.x, e.y) {
                    let e = &mut self.ents[i];
                    e.x = nx;
                    e.y = ny;
                    e.px = nx;
                    e.py = ny;
                    e.path.clear();
                    e.goal = None;
                }
            }
        }
    }

    /// Closest passable tile centre on the rings around a rectangle.
    pub(crate) fn free_tile_near(&self, tx: i32, ty: i32, size: i32, px: f32, py: f32) -> Option<(f32, f32)> {
        for ring in 1..6 {
            let mut best: Option<(f32, f32)> = None;
            let mut bd = f32::MAX;
            for y in ty - ring..ty + size + ring {
                for x in tx - ring..tx + size + ring {
                    let on_ring = x == tx - ring || y == ty - ring || x == tx + size + ring - 1 || y == ty + size + ring - 1;
                    if !on_ring || !self.map.passable(x, y) {
                        continue;
                    }
                    let (cx, cy) = (x as f32 + 0.5, y as f32 + 0.5);
                    let d = (cx - px).powi(2) + (cy - py).powi(2);
                    if d < bd {
                        bd = d;
                        best = Some((cx, cy));
                    }
                }
            }
            if best.is_some() {
                return best;
            }
        }
        None
    }

    pub fn alive(&self, id: u32) -> bool {
        self.ents.get(id as usize).is_some_and(|e| e.alive)
    }

    /// Does `owner` have at least one *finished* building of this kind?
    pub fn has_built(&self, owner: u8, kind: Kind) -> bool {
        self.ents.iter().any(|e| e.alive && e.owner == owner && e.kind == kind && e.built >= 1.0)
    }

    /// Has `owner` reached `kind`'s era, with every building it requires in place?
    pub fn unlocked(&self, owner: u8, kind: Kind) -> bool {
        self.cheat(owner) || kind.era() <= self.players[owner as usize].era && kind.requires().iter().all(|&k| self.has_built(owner, k))
    }

    /// How many of `owner`'s finished houses are past their era's tier:
    /// `HOUSES_FOR_ERA` of them take the player into the next era.
    pub fn houses_past_era(&self, owner: u8) -> u32 {
        let era = self.players[owner as usize].era;
        self.ents.iter().filter(|e| e.alive && e.owner == owner && e.built >= 1.0 && e.kind.house_tier().is_some_and(|t| t > era)).count() as u32
    }

    /// Is `owner` in cheat mode?
    pub fn cheat(&self, owner: u8) -> bool {
        self.players.get(owner as usize).is_some_and(|p| p.cheat)
    }

    /// The host's cheat switch: every player a person plays (not the
    /// computer) can build anything, free. Everyone hears.
    pub fn set_cheats(&mut self, on: bool) {
        for p in self.player_ids() {
            let human = !self.ais[p as usize].on;
            self.players[p as usize].cheat = on && human;
        }
        self.push_event(Ev::Cheats, 0.0, 0.0, on as u32 as f32);
    }

    /// Hand a player slot to the computer (or take it back). In multiplayer
    /// this happens when someone leaves: their people carry on without them.
    pub fn set_ai(&mut self, player: u8, on: bool) {
        if let Some(ai) = self.ais.get_mut(player as usize) {
            ai.on = on && player >= 1;
            if on {
                self.players[player as usize].cheat = false; // cheats are for people
                self.players[player as usize].supply_pct = 100;
            }
        }
    }

    /// How well one computer player plays (0 Easy, 1 Normal, 2 Hard): each
    /// seat in the lobby picks its own. Its next attack, wave size and
    /// supply come from it; at the start of a game, before the recording.
    pub fn set_difficulty(&mut self, player: u8, difficulty: u32) {
        let d = difficulty.min(2);
        if player < 1 || player as usize >= self.players.len() {
            return;
        }
        if let Some(ai) = self.ais.get_mut(player as usize) {
            let fresh = Ai::new(d, ai.on, 0.0);
            (ai.difficulty, ai.next_attack, ai.wave_size) = (fresh.difficulty, fresh.next_attack, fresh.wave_size);
        }
        self.players[player as usize].supply_pct = handicap(d);
    }

    /// Players 1..=n, for `for p in self.player_ids()`.
    pub fn player_ids(&self) -> std::ops::RangeInclusive<u8> {
        1..=self.n_players
    }

    pub fn find_first(&self, owner: u8, kind: Kind) -> Option<usize> {
        self.ents.iter().position(|e| e.alive && e.owner == owner && e.kind == kind)
    }

    /// `owner`'s home: their oldest finished Capitol. The campfire burns
    /// there, and while they have one they're in the game.
    pub fn home_capitol(&self, owner: u8) -> Option<usize> {
        self.ents.iter().position(|e| e.alive && e.owner == owner && e.kind == Kind::Capitol && e.built >= 1.0)
    }

    /// How many of `kind` `owner` has, foundations included.
    pub fn count_of(&self, owner: u8, kind: Kind) -> usize {
        self.ents.iter().filter(|e| e.alive && e.owner == owner && e.kind == kind).count()
    }

    /// The most of `kind` the computer builds: the balance target
    /// `MAX_SAME`, except fields, houses and Capitols (no limit). Players
    /// have no limit.
    pub fn max_of(kind: Kind) -> usize {
        if kind == Kind::Capitol || kind == Kind::Farm || kind.house_tier().is_some() {
            usize::MAX
        } else {
            MAX_SAME
        }
    }

    /// Is an enemy (from `owner`'s point of view) able to be targeted?
    fn hostile(a: u8, b: u8) -> bool {
        a != b && a != GAIA && b != GAIA
    }

    #[cfg(test)]
    pub(crate) fn rebuild_grid_for_tests(&mut self) {
        self.rebuild_grid();
    }

    fn rebuild_grid(&mut self) {
        for c in self.grid.iter_mut() {
            c.clear();
        }
        let cw = self.map.w / CELL + 1;
        for e in self.ents.iter() {
            if e.alive && !e.is_building() {
                let c = (e.y as i32 / CELL) * cw + (e.x as i32 / CELL);
                self.grid[c as usize].push(e.id);
            }
        }
    }

    /// Calls `f` for every unit id in grid cells overlapping a circle.
    fn units_near(&self, x: f32, y: f32, r: f32, mut f: impl FnMut(u32)) {
        let cw = self.map.w / CELL + 1;
        let ch = self.map.h / CELL + 1;
        let c0x = (((x - r) as i32) / CELL).clamp(0, cw - 1);
        let c1x = (((x + r) as i32) / CELL).clamp(0, cw - 1);
        let c0y = (((y - r) as i32) / CELL).clamp(0, ch - 1);
        let c1y = (((y + r) as i32) / CELL).clamp(0, ch - 1);
        for cy in c0y..=c1y {
            for cx in c0x..=c1x {
                for &id in &self.grid[(cy * cw + cx) as usize] {
                    f(id);
                }
            }
        }
    }

    /// The best enemy to shoot at within `radius` of entity `i`. Prefers units over buildings.
    /// What to go for first: 0 units that fight, 1 buildings that fight
    /// (towers, the Capitol), 2 other units (workers), 3 other buildings.
    pub fn threat_tier(e: &Entity) -> u8 {
        let fights = e.kind.stats().attack > 0.0 && e.kind != Kind::Worker;
        match (e.is_building(), fights) {
            (false, true) => 0,
            (true, true) => 1,
            (false, false) => 2,
            (true, false) => 3,
        }
    }

    /// The enemy to fight within `radius`: whatever fights back first
    /// (`threat_tier`), the nearest of those.
    pub fn nearest_enemy(&self, i: usize, radius: f32) -> Option<u32> {
        let me = &self.ents[i];
        let (x, y, owner) = (me.x, me.y, me.owner);
        let reach = radius + if me.is_building() { me.kind.stats().size as f32 / 2.0 } else { me.kind.radius() };
        let mut best = None;
        let mut bk = (u8::MAX, f32::MAX);
        let me_kind = me.kind;
        let key = |e: &Entity| (Self::threat_tier(e), e.edge_dist(x, y));
        let better = |k: (u8, f32), bk: (u8, f32)| k.1 <= reach && (k.0 < bk.0 || (k.0 == bk.0 && k.1 < bk.1));
        self.units_near(x, y, reach + 1.0, |id| {
            let e = &self.ents[id as usize];
            if e.alive && Self::hostile(owner, e.owner) && me_kind.can_hit(e.kind) {
                let k = key(e);
                if better(k, bk) {
                    bk = k;
                    best = Some(id);
                }
            }
        });
        if bk.0 == 0 {
            return best;
        }
        for e in self.ents.iter() {
            if e.alive && e.is_building() && Self::hostile(owner, e.owner) && me_kind.can_hit(e.kind) {
                let k = key(e);
                if better(k, bk) {
                    bk = k;
                    best = Some(e.id);
                }
            }
        }
        best
    }

    pub fn visible_to_player(&self, x: f32, y: f32) -> bool {
        let (tx, ty) = (x.floor() as i32, y.floor() as i32);
        self.map.inside(tx, ty) && self.fog[self.map.idx(tx, ty)] == 2
    }

    // -----------------------------------------------------------------------
    // The main loop

    pub fn tick(&mut self) {
        if self.state != 0 {
            return;
        }
        self.time += DT;
        self.alert_cooldown -= DT;
        for e in self.ents.iter_mut().filter(|e| e.alive) {
            e.px = e.x;
            e.py = e.y;
            e.hit_flash = (e.hit_flash - DT).max(0.0);
        }
        self.resolve();
        self.grow();
        self.recruit();
        self.rebuild_grid();

        // Index loop rather than `for e in &mut self.ents`: each update needs
        // `&mut self` (to read other entities, spawn projectiles, ...), and the
        // borrow checker won't let us hold a borrow of one element meanwhile.
        for i in 0..self.ents.len() {
            if !self.ents[i].alive {
                continue;
            }
            if self.ents[i].is_building() {
                self.update_building(i);
            } else {
                self.update_unit(i);
            }
        }
        self.separate();
        self.update_projectiles();
        self.update_nukes();
        self.reap();

        self.fog_timer -= DT;
        if self.fog_timer <= 0.0 {
            self.fog_timer = 0.2;
            self.update_fog();
            self.explore();
        }
        for p in self.player_ids() {
            let ai = &mut self.ais[p as usize];
            ai.timer -= DT;
            if ai.on && ai.timer <= 0.0 && !self.players[p as usize].defeated {
                ai.timer = 0.5;
                self.ai_think(p);
            }
        }
        self.check_victory();
    }

    /// Lose your last Capitol and you're out: everything you own falls with
    /// it. (A foundation doesn't count.) The last player standing wins.
    /// A player gives up. Their things fall at the end of this tick, and
    /// `check_victory` puts them out of the game exactly as if their Capitol
    /// had been destroyed.
    fn surrender(&mut self, owner: u8) {
        if owner == GAIA || self.players.get(owner as usize).is_none_or(|p| p.defeated) {
            return;
        }
        for e in self.ents.iter_mut().filter(|e| e.alive && e.owner == owner) {
            e.hp = 0.0;
        }
    }

    fn check_victory(&mut self) {
        for p in self.player_ids() {
            if !self.players[p as usize].defeated && self.home_capitol(p).is_none() {
                self.players[p as usize].defeated = true;
                for e in self.ents.iter_mut().filter(|e| e.alive && e.owner == p) {
                    e.hp = 0.0;
                }
                self.push_event(Ev::Eliminated, 0.0, 0.0, p as f32);
            }
        }
        let standing: Vec<u8> = self.player_ids().filter(|&p| !self.players[p as usize].defeated).collect();
        let w = match standing.as_slice() {
            [only] => *only,
            [] => self.local, // everyone fell at once: call it a draw, kindly
            _ => 0,
        };
        if w != 0 {
            self.state = 1;
            self.winner = w;
        }
    }

    pub(crate) fn push_event(&mut self, ev: Ev, x: f32, y: f32, data: f32) {
        // If nobody drains the queue (e.g. a headless test), don't grow forever.
        if self.events.len() < 4096 {
            self.events.extend_from_slice(&[ev as u32 as f32, x, y, data]);
        }
    }

    /// Advance a unit's work-sound timer; true once per stroke (~0.9 s).
    /// The id offsets the phase so a crowd of woodcutters doesn't chop in unison.
    pub(crate) fn work_stroke(&mut self, i: usize) -> bool {
        let e = &mut self.ents[i];
        if e.sfx == 0.0 {
            e.sfx = (e.id % 7) as f32 * 0.13;
        }
        e.sfx += DT;
        if e.sfx >= 0.9 {
            e.sfx = 0.001;
            return true;
        }
        false
    }

    // -----------------------------------------------------------------------
    // Buildings

    fn update_building(&mut self, i: usize) {
        if self.ents[i].built < 1.0 {
            return self.rise(i);
        }
        let kind = self.ents[i].kind;
        let st = kind.stats();
        if st.attack > 0.0 {
            self.ents[i].cooldown -= DT;
            if self.ents[i].cooldown <= 0.0 {
                if let Some(t) = self.nearest_enemy(i, st.range) {
                    self.fire(i, t);
                    self.ents[i].cooldown = st.cooldown;
                }
            }
        }
        let owner = self.ents[i].owner as usize;
        if kind == Kind::AirDefense {
            let e = &mut self.ents[i];
            e.progress = (e.progress - DT).max(0.0);
        }
        // A silo arming its nuke.
        if self.ents[i].nuke == 1 {
            self.ents[i].progress += DT / NUKE_ARM_TIME;
            if self.ents[i].progress >= 1.0 {
                let e = &mut self.ents[i];
                e.progress = 0.0;
                e.nuke = 2;
                let (x, y) = (e.x, e.y);
                self.push_event(Ev::NukeArmed, x, y, owner as f32);
            }
        }
        // Training goes on while its recruit is inside.
        if let Some(&unit) = self.ents[i].queue.first() {
            if self.ents[i].recruits > 0 {
                self.ents[i].progress += DT / unit.stats().time;
                if self.ents[i].progress >= 1.0 {
                    self.ents[i].progress = 0.0;
                    self.ents[i].queue.remove(0);
                    self.ents[i].recruits -= 1;
                    let id = self.spawn_from(i, unit);
                    self.players[owner].trained += 1;
                    if owner == self.local as usize {
                        let (x, y) = (self.ents[id as usize].x, self.ents[id as usize].y);
                        self.push_event(Ev::Trained, x, y, unit as u32 as f32);
                    }
                }
            }
        }
    }

    fn spawn_from(&mut self, i: usize, kind: Kind) -> u32 {
        let b = &self.ents[i];
        let (owner, tx, ty, size, rally) = (b.owner, b.tx, b.ty, b.kind.stats().size, b.rally);
        let (gx, gy) = rally.unwrap_or((b.x, (ty + size) as f32 + 1.0));
        let (x, y) = self.free_tile_near(tx, ty, size, gx, gy).unwrap_or((b.x, b.y));
        let id = self.spawn_unit(kind, owner, x, y);
        if let Some((rx, ry)) = rally {
            self.smart_order(&[id], rx, ry, owner);
        }
        id
    }

    /// Take slots for something new, or explain which resource is short.
    /// Nothing is spent: the slots are held as long as the thing exists.
    /// They're added to `used` at once, so a second command in the same
    /// tick sees them taken.
    pub fn pay(&mut self, owner: u8, cost: Slots) -> Result<(), CmdError> {
        let p = &mut self.players[owner as usize];
        if p.cheat {
            return Ok(()); // nothing holds slots in cheat mode
        }
        if let Some(&(r, _)) = cost.iter().find(|&&(r, k)| p.free(r) < k as i32) {
            return Err(CmdError::Short(r));
        }
        for &(r, k) in cost {
            p.used[r.idx()] = p.used[r.idx()].saturating_add(k);
        }
        Ok(())
    }

    /// Give back slots taken this tick (a cancelled unit).
    pub(crate) fn unpay(&mut self, owner: u8, cost: Slots) {
        let p = &mut self.players[owner as usize];
        if p.cheat {
            return;
        }
        for &(r, k) in cost {
            p.used[r.idx()] = p.used[r.idx()].saturating_sub(k);
        }
    }

    /// The first resource `owner` lacks free slots of for `kind`, if any.
    pub fn short_of(&self, owner: u8, kind: Kind) -> Option<Res> {
        let p = &self.players[owner as usize];
        if p.cheat {
            return None;
        }
        kind.stats().cost.iter().find(|&&(r, k)| p.free(r) < k as i32).map(|&(r, _)| r)
    }

    /// Could `owner` put a `kind` here? The footprint must be free land, the
    /// `margin` ring around it free of buildings, and an extractor must
    /// stand next to its deposit.
    pub fn can_place(&self, kind: Kind, tx: i32, ty: i32, owner: u8, margin: i32) -> bool {
        self.spot_free(kind, tx, ty, owner, margin) && self.near_deposit(kind, tx, ty)
    }

    /// Is any tile right around the footprint (corners included) of the
    /// deposit `kind` needs? True for kinds that need none.
    pub fn near_deposit(&self, kind: Kind, tx: i32, ty: i32) -> bool {
        let Some(dep) = kind.stats().needs_deposit else { return true };
        let s = kind.stats().size;
        for y in ty - 1..=ty + s {
            for x in tx - 1..=tx + s {
                let on_ring = x == tx - 1 || y == ty - 1 || x == tx + s || y == ty + s;
                if !on_ring || !self.map.inside(x, y) {
                    continue;
                }
                let i = self.map.idx(x, y);
                let here = match dep {
                    Dep::Water => self.map.terrain[i] == map::WATER,
                    _ => self.map.dep_at[i] >= 0 && self.deps[self.map.dep_at[i] as usize].kind == dep,
                };
                if here {
                    return true;
                }
            }
        }
        false
    }

    pub fn spot_free(&self, kind: Kind, tx: i32, ty: i32, owner: u8, margin: i32) -> bool {
        self.spot_free_but(kind, tx, ty, owner, margin, -1)
    }

    /// `spot_free`, as if building `except` (an index into `ents`) were gone.
    pub(crate) fn spot_free_but(&self, kind: Kind, tx: i32, ty: i32, owner: u8, margin: i32, except: i32) -> bool {
        let s = kind.stats().size;
        for y in ty - margin..ty + s + margin {
            for x in tx - margin..tx + s + margin {
                if !self.map.inside(x, y) {
                    return false;
                }
                let i = self.map.idx(x, y);
                let inner = x >= tx && y >= ty && x < tx + s && y < ty + s;
                if (self.map.bld_at[i] >= 0 && self.map.bld_at[i] != except) || (inner && (self.map.terrain[i] == map::WATER || self.map.dep_at[i] >= 0)) {
                    return false;
                }
            }
        }
        // Keep every campfire clear: the free workers stand there.
        let (x0, y0, x1, y1) = (tx as f32, ty as f32, (tx + s) as f32, (ty + s) as f32);
        for p in self.player_ids() {
            if let Some((cx, cy)) = self.campfire(p) {
                let (nx, ny) = (cx.clamp(x0, x1), cy.clamp(y0, y1));
                if (nx - cx).powi(2) + (ny - cy).powi(2) < CAMPFIRE_CLEAR * CAMPFIRE_CLEAR {
                    return false;
                }
            }
        }
        // Don't build on top of enemy soldiers.
        for e in self.ents.iter() {
            if e.alive && !e.is_building() && e.owner != owner {
                let (ux, uy) = (e.x.floor() as i32, e.y.floor() as i32);
                if ux >= tx && ux < tx + s && uy >= ty && uy < ty + s {
                    return false;
                }
            }
        }
        true
    }

    pub fn place(&mut self, owner: u8, kind: Kind, tx: i32, ty: i32, builders: &[u32]) -> Result<u32, CmdError> {
        if !kind.is_building() || !self.spot_free(kind, tx, ty, owner, 0) {
            return Err(CmdError::BadSpot);
        }
        if !self.near_deposit(kind, tx, ty) {
            return Err(CmdError::NoDeposit(kind.stats().needs_deposit.unwrap_or(Dep::Forest)));
        }
        let cheat = self.cheat(owner);
        if kind.era() > self.players[owner as usize].era && !cheat {
            return Err(CmdError::Era(kind.era()));
        }
        if let Some(&missing) = kind.requires().iter().find(|&&k| !self.has_built(owner, k)).filter(|_| !cheat) {
            return Err(CmdError::Locked(missing));
        }
        self.pay(owner, kind.stats().cost)?;
        let id = self.spawn_building(kind, owner, tx, ty, 0.0);
        for &b in builders {
            self.order_build(b, id);
        }
        Ok(id)
    }

    // -----------------------------------------------------------------------
    // Orders (used by both the player commands and the AI)

    fn is_worker(&self, id: u32) -> bool {
        self.alive(id) && self.ents[id as usize].kind == Kind::Worker
    }

    pub fn order_move(&mut self, id: u32, x: f32, y: f32) {
        let e = &mut self.ents[id as usize];
        e.set_order(Order::Move { x, y });
        e.resume = None;
    }

    pub fn order_attack_move(&mut self, id: u32, x: f32, y: f32) {
        let e = &mut self.ents[id as usize];
        e.set_order(Order::AttackMove { x, y });
        e.resume = None;
    }

    pub fn order_attack(&mut self, id: u32, target: u32) {
        let e = &mut self.ents[id as usize];
        e.set_order(Order::Attack { target, auto: false });
        e.resume = None;
    }

    pub fn order_build(&mut self, id: u32, target: u32) {
        if !self.is_worker(id) {
            return;
        }
        self.ents[id as usize].set_order(Order::Build(target));
    }

    pub fn order_work(&mut self, id: u32, target: u32) {
        if !self.is_worker(id) {
            return;
        }
        self.ents[id as usize].set_order(Order::Work(target));
    }

    /// Positions in a loose square formation around a point.
    fn formation(n: usize, x: f32, y: f32) -> Vec<(f32, f32)> {
        let cols = (n as f32).sqrt().ceil() as usize;
        let sp = 0.8;
        (0..n)
            .map(|k| {
                let (c, r) = ((k % cols) as f32, (k / cols) as f32);
                let off = (cols as f32 - 1.0) / 2.0;
                (x + (c - off) * sp, y + (r - off) * sp)
            })
            .collect()
    }

    /// What's under a map position. With `fog`, only what the local player
    /// can see counts (for the mouse). The simulation itself always picks
    /// with `fog: false`, because each player's computer has different fog
    /// and in multiplayer both must reach the same answer.
    pub fn pick(&self, x: f32, y: f32, fog: bool) -> Pick {
        let mut best = None;
        let mut bd = f32::MAX;
        for e in self.ents.iter() {
            if !e.alive || e.is_building() {
                continue;
            }
            if fog && e.owner != self.local && !self.visible_to_player(e.x, e.y) {
                continue;
            }
            let d = ((e.x - x).powi(2) + (e.y - y).powi(2)).sqrt();
            if d < e.kind.radius() + 0.3 && d < bd {
                bd = d;
                best = Some(e.id);
            }
        }
        if let Some(id) = best {
            return Pick::Ent(id);
        }
        let (tx, ty) = (x.floor() as i32, y.floor() as i32);
        if !self.map.inside(tx, ty) {
            return Pick::Nothing;
        }
        let i = self.map.idx(tx, ty);
        if fog && self.fog[i] == 0 {
            return Pick::Nothing;
        }
        let b = self.map.bld_at[i];
        if b >= 0 {
            let e = &self.ents[b as usize];
            if !fog || e.owner == self.local || e.seen {
                return Pick::Ent(b as u32);
            }
        }
        let d = self.map.dep_at[i];
        if d >= 0 {
            return Pick::Dep;
        }
        Pick::Nothing
    }

    /// What a right-click at (x, y) would mean for these units. Used twice:
    /// by the mouse cursor (to show a sword, a hammer...) and by `smart_order`
    /// to actually do it, so the cursor never lies.
    pub fn intent(&self, ids: &[u32], x: f32, y: f32, owner: u8, fog: bool) -> Intent {
        let mine = || ids.iter().copied().filter(|&id| self.alive(id) && self.ents[id as usize].owner == owner);
        let any_units = mine().any(|id| !self.ents[id as usize].is_building());
        if !any_units {
            let can_rally = mine().any(|id| !self.ents[id as usize].kind.trains().is_empty());
            return if can_rally { Intent::Rally } else { Intent::Nothing };
        }
        let any_worker = mine().any(|id| self.is_worker(id));
        match self.pick(x, y, fog) {
            Pick::Ent(t) if Self::hostile(owner, self.ents[t as usize].owner) => Intent::Attack(t),
            Pick::Ent(t) if any_worker && self.ents[t as usize].owner == owner && self.ents[t as usize].is_building() => {
                let b = &self.ents[t as usize];
                if b.built < 1.0 {
                    Intent::Build(t)
                } else if b.kind.stats().workers > 0 {
                    Intent::Work(t)
                } else {
                    Intent::Move
                }
            }
            _ => Intent::Move,
        }
    }

    /// The right-click: work out what the player meant, then order each unit.
    /// Soldiers can't build, so they just walk there.
    pub fn smart_order(&mut self, ids: &[u32], x: f32, y: f32, owner: u8) {
        let units: Vec<u32> = ids.iter().copied().filter(|&id| self.alive(id) && self.ents[id as usize].owner == owner && !self.ents[id as usize].is_building()).collect();
        match self.intent(ids, x, y, owner, false) {
            Intent::Nothing => {}
            Intent::Rally => {
                for &id in ids {
                    if self.alive(id) && self.ents[id as usize].owner == owner && !self.ents[id as usize].kind.trains().is_empty() {
                        self.ents[id as usize].rally = Some((x, y));
                    }
                }
            }
            Intent::Attack(t) => {
                for &u in &units {
                    self.order_attack(u, t);
                }
            }
            Intent::Build(t) => {
                for &u in &units {
                    if self.is_worker(u) {
                        self.order_build(u, t);
                    } else {
                        self.order_move(u, x, y);
                    }
                }
            }
            Intent::Work(t) => {
                // Workers sent to a producer start it hiring again.
                self.ents[t as usize].hiring = true;
                for &u in &units {
                    if self.is_worker(u) {
                        self.order_work(u, t);
                    } else {
                        self.order_move(u, x, y);
                    }
                }
            }
            Intent::Move => {
                let spots = Self::formation(units.len(), x, y);
                for (&u, &(fx, fy)) in units.iter().zip(spots.iter()) {
                    self.order_move(u, fx, fy);
                }
            }
        }
    }

    /// Carry out one player command. Every change a player makes to the game
    /// goes through here, which is what makes multiplayer possible: both
    /// computers apply the same commands on the same tick, in the same order.
    pub fn apply(&mut self, owner: u8, cmd: Command) -> Result<(), CmdError> {
        // Only ever touch the issuing player's own, living things.
        let own = |g: &Game, ids: &[u32]| -> Vec<u32> { ids.iter().copied().filter(|&id| g.alive(id) && g.ents[id as usize].owner == owner).collect() };
        // Workers taken away from a producer pause it: note where they work
        // now, and afterwards stop hiring at any producer one of them left.
        let was_at: Vec<(u32, u32)> = match &cmd {
            Command::Smart { ids, .. } | Command::AttackMove { ids, .. } | Command::Stop { ids } => own(self, ids)
                .into_iter()
                .filter_map(|id| match self.ents[id as usize].order {
                    Order::Work(b) => Some((id, b)),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };
        let result = self.apply_inner(owner, cmd, own);
        for (id, b) in was_at {
            if self.ents[id as usize].order != Order::Work(b) {
                if let Some(t) = self.ents.get_mut(b as usize) {
                    t.hiring = false;
                }
            }
        }
        result
    }

    fn apply_inner(&mut self, owner: u8, cmd: Command, own: impl Fn(&Game, &[u32]) -> Vec<u32>) -> Result<(), CmdError> {
        match cmd {
            Command::Smart { ids, x, y } => {
                let ids = own(self, &ids);
                self.smart_order(&ids, x, y, owner);
            }
            Command::AttackMove { ids, x, y } => {
                for id in own(self, &ids) {
                    if self.ents[id as usize].is_building() {
                        continue;
                    }
                    // Anyone who can fight, workers too.
                    if self.ents[id as usize].kind.stats().attack > 0.0 {
                        self.order_attack_move(id, x, y);
                    } else {
                        self.order_move(id, x, y);
                    }
                }
            }
            Command::Stop { ids } => {
                for id in own(self, &ids) {
                    if !self.ents[id as usize].is_building() {
                        let (x, y) = (self.ents[id as usize].x, self.ents[id as usize].y);
                        self.order_move(id, x, y);
                    }
                }
            }
            Command::Train { ids, kind } => {
                // The least busy of the selected buildings that can train it.
                let best = own(self, &ids)
                    .into_iter()
                    .filter(|&id| self.ents[id as usize].built >= 1.0 && self.ents[id as usize].kind.trains().contains(&kind))
                    .min_by_key(|&id| self.ents[id as usize].queue.len());
                match best {
                    Some(b) => self.queue_unit(b, kind)?,
                    None => return Err(CmdError::NoBuilding),
                }
            }
            Command::Cancel { id } => {
                if own(self, &[id]).len() == 1 {
                    self.cancel_unit(id);
                }
            }
            Command::Place { ids, kind, tx, ty } => {
                let builders: Vec<u32> = own(self, &ids).into_iter().filter(|&id| self.ents[id as usize].kind == Kind::Worker).collect();
                self.place(owner, kind, tx, ty, &builders)?;
            }
            Command::Hire { ids, on } => {
                for id in own(self, &ids) {
                    self.set_hiring(id, on);
                }
            }
            Command::Arm { id } => {
                if own(self, &[id]).len() == 1 {
                    self.arm_nuke(id)?;
                }
            }
            Command::Upgrade { ids } => {
                let ids = own(self, &ids);
                self.upgrade_houses(owner, &ids)?;
            }
            Command::Launch { id, x, y } => {
                if own(self, &[id]).len() == 1 {
                    self.launch_nuke(id, x, y)?;
                }
            }
            Command::Surrender => self.surrender(owner),
            Command::Demolish { ids } => {
                for id in own(self, &ids) {
                    self.demolish(id);
                }
            }
        }
        Ok(())
    }

    /// A fingerprint of the whole game state. In multiplayer both computers
    /// compare these now and then: if they ever differ, the games have
    /// drifted apart ("desynced"). FNV-1a hashing: simple and good enough.
    /// Like `checksum`, but only one player's units and buildings: tells
    /// whether a correction actually changed anything of theirs.
    pub fn checksum_owner(&self, owner: u8) -> u32 {
        let mut h: u32 = 0x811c_9dc5;
        let mut mix = |v: u32| {
            for b in v.to_le_bytes() {
                h ^= b as u32;
                h = h.wrapping_mul(0x0100_0193);
            }
        };
        for e in self.ents.iter().filter(|e| e.alive && e.owner == owner) {
            mix(e.id);
            mix(e.x.to_bits());
            mix(e.y.to_bits());
            mix(e.hp.to_bits());
            mix(e.queue.len() as u32);
            mix(e.builders_in as u32 | (e.recruits as u32) << 8 | (e.hiring as u32) << 16);
            mix(e.goods);
        }
        if let Some(p) = self.players.get(owner as usize) {
            for r in 0..N_RES {
                mix(p.supply[r] as u32 | (p.used[r] as u32) << 16);
            }
        }
        h
    }

    pub fn checksum(&self) -> u32 {
        let mut h: u32 = 0x811c_9dc5;
        let mut mix = |v: u32| {
            for b in v.to_le_bytes() {
                h ^= b as u32;
                h = h.wrapping_mul(0x0100_0193);
            }
        };
        for e in self.ents.iter().filter(|e| e.alive) {
            mix(e.id);
            mix(e.x.to_bits());
            mix(e.y.to_bits());
            mix(e.hp.to_bits());
            mix(e.queue.len() as u32);
            mix(e.builders_in as u32 | (e.recruits as u32) << 8 | (e.hiring as u32) << 16);
            mix(e.goods);
            mix(e.nuke as u32 | (e.starting as u32) << 8);
        }
        for p in &self.players[1..] {
            mix(p.cheat as u32);
        }
        for n in &self.nukes {
            mix(n.left.to_bits());
        }
        for p in &self.players[1..] {
            for r in 0..N_RES {
                mix(p.supply[r] as u32 | (p.used[r] as u32) << 16);
            }
        }
        h
    }

    // -----------------------------------------------------------------------
    // Units

    fn update_unit(&mut self, i: usize) {
        {
            let e = &mut self.ents[i];
            e.cooldown -= DT;
            e.repath -= DT;
            e.scan -= DT;
        }
        match self.ents[i].order {
            Order::Idle => self.do_idle(i),
            Order::Move { x, y } => {
                if self.travel(i, Goal::point(x, y, 0.15), 1.0) != Travel::Moving {
                    self.ents[i].set_order(Order::Idle);
                }
            }
            Order::AttackMove { x, y } => self.do_attack_move(i, x, y),
            Order::Attack { target, auto } => self.do_attack(i, target, auto),
            Order::Build(target) => self.do_build(i, target),
            Order::Work(target) => self.do_work(i, target),
            Order::Enlist(target) => self.do_enlist(i, target),
        }
    }

    fn do_idle(&mut self, i: usize) {
        self.ents[i].anim = Anim::Idle;
        let e = &self.ents[i];
        if e.kind.is_military() && e.scan <= 0.0 {
            self.ents[i].scan = 0.5;
            let sight = self.ents[i].kind.stats().sight;
            if let Some(t) = self.nearest_enemy(i, sight) {
                let e = &mut self.ents[i];
                e.resume = Some((e.x, e.y));
                e.set_order(Order::Attack { target: t, auto: true });
            }
        }
    }

    fn do_attack_move(&mut self, i: usize, x: f32, y: f32) {
        if self.ents[i].kind.stats().attack > 0.0 && self.ents[i].scan <= 0.0 {
            self.ents[i].scan = 0.4;
            let sight = self.ents[i].kind.stats().sight;
            if let Some(t) = self.nearest_enemy(i, sight) {
                let e = &mut self.ents[i];
                e.set_order(Order::Attack { target: t, auto: true });
                e.resume = Some((x, y));
                return;
            }
        }
        if self.travel(i, Goal::point(x, y, 0.5), 1.0) != Travel::Moving {
            self.ents[i].set_order(Order::Idle);
        }
    }

    /// Stop fighting: go back to an attack-move if we were on one, else idle.
    fn end_attack(&mut self, i: usize) {
        let e = &mut self.ents[i];
        match e.resume.take() {
            Some((x, y)) => e.set_order(Order::AttackMove { x, y }),
            None => e.set_order(Order::Idle),
        }
    }

    fn do_attack(&mut self, i: usize, target: u32, auto: bool) {
        if !self.alive(target) || !self.ents[i].kind.can_hit(self.ents[target as usize].kind) {
            return self.end_attack(i);
        }
        let (x, y, kind) = (self.ents[i].x, self.ents[i].y, self.ents[i].kind);
        let st = kind.stats();
        let t = &self.ents[target as usize];
        let (tx, ty, t_is_bld) = (t.x, t.y, t.is_building());
        let d = t.edge_dist(x, y) - kind.radius();
        // Automatic fights give up when the target runs out of sight.
        if auto && d > st.sight * 1.3 {
            return self.end_attack(i);
        }
        // ...and turn to anything that fights back, when hitting something
        // that doesn't (a worker, a house).
        if auto && Self::threat_tier(&self.ents[target as usize]) > 0 && self.ents[i].scan <= 0.0 {
            self.ents[i].scan = 0.5;
            if let Some(t) = self.nearest_enemy(i, st.sight) {
                if Self::threat_tier(&self.ents[t as usize]) < Self::threat_tier(&self.ents[target as usize]) {
                    self.ents[i].set_order(Order::Attack { target: t, auto: true });
                    return;
                }
            }
        }
        if d <= st.range {
            let e = &mut self.ents[i];
            e.path.clear();
            e.goal = None;
            e.anim = Anim::Fight;
            e.facing = (ty - y).atan2(tx - x);
            if e.cooldown <= 0.0 {
                e.cooldown = st.cooldown;
                self.fire(i, target);
            }
            return;
        }
        let goal = self.ents[target as usize].goal(st.range * 0.9 + kind.radius());
        let every = if t_is_bld { 3.0 } else { 0.5 };
        if self.travel(i, goal, every) == Travel::Blocked && auto {
            self.end_attack(i);
        }
    }

    /// Deal damage: arrows for ranged attackers, instant hits for melee.
    fn fire(&mut self, i: usize, target: u32) {
        let a = &self.ents[i];
        let st = a.kind.stats();
        let dmg = st.attack * damage_mult(a.kind, self.ents[target as usize].kind);
        let kind = a.kind as u32 as f32;
        if st.range > 1.5 {
            let (x, y, shooter) = (a.x, a.y, a.kind);
            let at_building = self.ents[target as usize].is_building();
            self.proj.push(Projectile { x, y, px: x, py: y, target, damage: dmg, attacker: a.id, alive: true, sx: x, sy: y, shooter, at_building });
            self.push_event(Ev::Shoot, x, y, kind);
        } else {
            let t = &self.ents[target as usize];
            let (tx, ty) = (t.x, t.y);
            let (shooter, owner) = (self.ents[i].kind, self.ents[i].owner);
            self.damage(target, dmg, i as u32);
            self.splash(shooter, owner, i as u32, target, tx, ty);
            self.push_event(Ev::Melee, tx, ty, kind);
        }
    }

    /// Shells, rockets and bombs hurt everything hostile around where they
    /// land, not just their target: half their damage, less further out.
    fn splash(&mut self, shooter: Kind, owner: u8, attacker: u32, target: u32, x: f32, y: f32) {
        let r = splash_radius(shooter);
        if r <= 0.0 {
            return;
        }
        let base = shooter.stats().attack * SPLASH_SHARE;
        let mut hit: Vec<(u32, f32)> = Vec::new();
        self.units_near(x, y, r + 0.5, |id| {
            let e = &self.ents[id as usize];
            if id != target && e.alive && Self::hostile(owner, e.owner) && shooter.can_hit(e.kind) {
                let d = e.edge_dist(x, y).max(0.0);
                if d < r {
                    hit.push((id, base * damage_mult(shooter, e.kind) * (1.0 - d / r)));
                }
            }
        });
        // Buildings: their footprints, near where it landed.
        let ri = r.ceil() as i32 + 1;
        let (cx, cy) = (x.floor() as i32, y.floor() as i32);
        for ty in cy - ri..=cy + ri {
            for tx in cx - ri..=cx + ri {
                if !self.map.inside(tx, ty) {
                    continue;
                }
                let b = self.map.bld_at[self.map.idx(tx, ty)];
                if b < 0 || b as u32 == target || hit.iter().any(|&(id, _)| id == b as u32) {
                    continue;
                }
                let e = &self.ents[b as usize];
                if e.alive && Self::hostile(owner, e.owner) {
                    let d = e.edge_dist(x, y).max(0.0);
                    if d < r {
                        hit.push((b as u32, base * damage_mult(shooter, e.kind) * (1.0 - d / r)));
                    }
                }
            }
        }
        for (id, dmg) in hit {
            self.damage(id, dmg, attacker);
        }
    }

    fn damage(&mut self, target: u32, amount: f32, attacker: u32) {
        if !self.alive(target) {
            return;
        }
        let (ax, ay) = (self.ents[attacker as usize].x, self.ents[attacker as usize].y);
        let t = &mut self.ents[target as usize];
        t.hp -= amount;
        t.hit_flash = 0.15;
        let (owner, x, y, kind) = (t.owner, t.x, t.y, t.kind);
        // Soldiers standing around fight back.
        if kind.is_military() && t.order == Order::Idle {
            t.resume = Some((t.x, t.y));
            t.set_order(Order::Attack { target: attacker, auto: true });
        }
        if owner == self.local && self.alert_cooldown <= 0.0 {
            self.alert_cooldown = 12.0;
            self.push_event(Ev::Alert, x, y, kind as u32 as f32);
        }
        if let Some(ai) = self.ais.get_mut(owner as usize) {
            if ai.on {
                ai.alarm = Some((ax, ay));
            }
        }
    }

    fn update_projectiles(&mut self) {
        // Iterate by index again: `damage` needs `&mut self`.
        for k in 0..self.proj.len() {
            let p = &self.proj[k];
            if !self.alive(p.target) {
                self.proj[k].alive = false;
                continue;
            }
            let t = &self.ents[p.target as usize];
            let (dx, dy) = (t.x - p.x, t.y - p.y);
            let d = (dx * dx + dy * dy).sqrt();
            let step = 12.0 * DT;
            let p = &mut self.proj[k];
            p.px = p.x;
            p.py = p.y;
            if d <= step + 0.2 {
                p.alive = false;
                let (tg, dm, at, shooter) = (p.target, p.damage, p.attacker, p.shooter);
                let t = &self.ents[tg as usize];
                let (tx, ty, bld) = (t.x, t.y, t.is_building());
                let owner = self.ents[at as usize].owner;
                self.damage(tg, dm, at);
                self.splash(shooter, owner, at, tg, tx, ty);
                self.push_event(Ev::ArrowHit, tx, ty, bld as u32 as f32);
            } else {
                p.x += dx / d * step;
                p.y += dy / d * step;
            }
        }
        self.proj.retain(|p| p.alive);
    }

    fn reap(&mut self) {
        for i in 0..self.ents.len() {
            let e = &self.ents[i];
            if !e.alive || e.hp > 0.0 {
                continue;
            }
            let (owner, kind, x, y) = (e.owner, e.kind, e.x, e.y);
            self.players[owner as usize].lost += 1;
            self.remove(i);
            if kind.is_building() && owner == self.local {
                self.push_event(Ev::Lost, x, y, kind as u32 as f32);
            }
            self.push_event(Ev::Death, x, y, owner as f32 * 100.0 + kind as u32 as f32);
        }
    }

    /// Take something off the map: it's gone, and a building's tiles are free.
    fn remove(&mut self, i: usize) {
        let e = &mut self.ents[i];
        e.alive = false;
        e.selected = false;
        let (kind, tx, ty) = (e.kind, e.tx, e.ty);
        if kind.is_building() {
            let s = kind.stats().size;
            for yy in ty..ty + s {
                for xx in tx..tx + s {
                    let j = self.map.idx(xx, yy);
                    self.map.bld_at[j] = -1;
                    self.map.blocked[j] = self.map.terrain[j] == map::CRATER; // craters stay blocked
                }
            }
        }
    }

    /// A player tears down their own building (not the Capitol): its slots,
    /// workers and beds come free next tick. Residents of a house move out;
    /// anyone queued in it is lost.
    fn demolish(&mut self, id: u32) {
        let e = &self.ents[id as usize];
        if !e.is_building() {
            // A unit: it falls where it stands (`reap` takes it this tick).
            self.ents[id as usize].hp = 0.0;
            return;
        }
        if e.kind == Kind::Capitol {
            return;
        }
        let (x, y, kind, owner) = (e.x, e.y, e.kind, e.owner);
        self.remove(id as usize);
        self.push_event(Ev::Death, x, y, owner as f32 * 100.0 + kind as u32 as f32);
    }

    // --- movement ---

    /// Move unit `i` toward `goal`, (re)computing a path when needed.
    pub(crate) fn travel(&mut self, i: usize, goal: Goal, repath_every: f32) -> Travel {
        let (x, y) = (self.ents[i].x, self.ents[i].y);
        if self.ents[i].kind.is_air() {
            return self.fly(i, goal);
        }
        if goal.reached(x, y) {
            let e = &mut self.ents[i];
            e.path.clear();
            e.goal = None;
            e.stuck = 0.0;
            return Travel::Arrived;
        }
        let need = {
            let e = &self.ents[i];
            match e.goal {
                None => true,
                Some(g) => e.repath <= 0.0 && (g != goal || e.stuck > 0.5),
            }
        };
        if need {
            self.compute_path(i, goal);
            self.ents[i].repath = repath_every;
        }
        let speed = self.ents[i].kind.stats().speed * DT;
        let target = match self.ents[i].path.last() {
            Some(&p) => p,
            None => goal.nearest_point(x, y),
        };
        let moved = self.step_toward(i, target.0, target.1, speed);
        let e = &mut self.ents[i];
        if let Some(&(wx, wy)) = e.path.last() {
            if (e.x - wx).abs() < 0.15 && (e.y - wy).abs() < 0.15 {
                e.path.pop();
            }
        }
        e.anim = Anim::Walk;
        if moved > speed * 0.3 {
            e.stuck = 0.0;
        } else {
            e.stuck += DT;
        }
        if e.stuck > 2.0 {
            e.stuck = 0.0;
            e.goal = None;
            return Travel::Blocked;
        }
        Travel::Moving
    }

    fn compute_path(&mut self, i: usize, goal: Goal) {
        let (x, y) = (self.ents[i].x, self.ents[i].y);
        let tiles = self.pf.find(&self.map, x, y, &goal);
        let pts: Vec<(f32, f32)> = tiles.iter().map(|&(tx, ty)| (tx as f32 + 0.5, ty as f32 + 0.5)).collect();
        // String-pulling: skip waypoints we can see past, so units walk in straight lines.
        let mut smooth = Vec::with_capacity(pts.len());
        let mut cur = (x, y);
        let mut k = 0;
        while k < pts.len() {
            let mut far = k;
            for j in (k..pts.len().min(k + 12)).rev() {
                if self.map.line_clear(cur, pts[j]) {
                    far = j;
                    break;
                }
            }
            smooth.push(pts[far]);
            cur = pts[far];
            k = far + 1;
        }
        smooth.reverse();
        let e = &mut self.ents[i];
        e.path = smooth;
        e.goal = Some(goal);
    }

    /// Aircraft fly straight to their goal, over anything, and stay over
    /// the map.
    fn fly(&mut self, i: usize, goal: Goal) -> Travel {
        let e = &mut self.ents[i];
        if goal.reached(e.x, e.y) {
            e.path.clear();
            e.goal = None;
            return Travel::Arrived;
        }
        let (tx, ty) = goal.nearest_point(e.x, e.y);
        let (dx, dy) = (tx - e.x, ty - e.y);
        let d = (dx * dx + dy * dy).sqrt().max(1e-4);
        let s = (e.kind.stats().speed * DT).min(d);
        e.x = (e.x + dx / d * s).clamp(0.5, self.map.w as f32 - 0.5);
        e.y = (e.y + dy / d * s).clamp(0.5, self.map.h as f32 - 0.5);
        e.facing = dy.atan2(dx);
        e.anim = Anim::Walk;
        Travel::Moving
    }

    /// Returns how far the unit actually moved. Slides along walls.
    fn step_toward(&mut self, i: usize, tx: f32, ty: f32, max: f32) -> f32 {
        let e = &self.ents[i];
        let (dx, dy) = (tx - e.x, ty - e.y);
        let d = (dx * dx + dy * dy).sqrt();
        if d < 1e-4 {
            return 0.0;
        }
        let s = max.min(d);
        let (nx, ny) = (e.x + dx / d * s, e.y + dy / d * s);
        let free = |x: f32, y: f32| self.map.passable_at(x, y) || !self.map.passable_at(e.x, e.y);
        let (fx, fy) = if free(nx, ny) {
            (nx, ny)
        } else if free(nx, e.y) {
            (nx, e.y)
        } else if free(e.x, ny) {
            (e.x, ny)
        } else {
            return 0.0;
        };
        let (ox, oy) = (e.x, e.y);
        let e = &mut self.ents[i];
        e.x = fx;
        e.y = fy;
        e.facing = dy.atan2(dx);
        ((fx - ox).powi(2) + (fy - oy).powi(2)).sqrt()
    }

    /// Nudge overlapping units apart so they don't stack into one blob.
    fn separate(&mut self) {
        let mut pushes: Vec<(usize, f32, f32)> = Vec::new();
        for i in 0..self.ents.len() {
            let a = &self.ents[i];
            if !a.alive || a.is_building() || a.kind.is_air() {
                continue;
            }
            let (ax, ay, ar) = (a.x, a.y, a.kind.radius());
            let a_busy = a.anim == Anim::Work || a.anim == Anim::Fight;
            self.units_near(ax, ay, 1.0, |id| {
                let j = id as usize;
                if j <= i {
                    return;
                }
                let b = &self.ents[j];
                if b.kind.is_air() {
                    return;
                }
                let (dx, dy) = (b.x - ax, b.y - ay);
                let d2 = dx * dx + dy * dy;
                let min = ar + b.kind.radius();
                if d2 >= min * min {
                    return;
                }
                let d = d2.sqrt().max(0.01);
                let (nx, ny) = if d2 < 1e-6 { (((i * 7 + j) % 5) as f32 - 2.0, 1.0) } else { (dx / d, dy / d) };
                let overlap = (min - d) * 0.5;
                let b_busy = b.anim == Anim::Work || b.anim == Anim::Fight;
                let (wa, wb) = match (a_busy, b_busy) {
                    (true, false) => (0.15, 0.85),
                    (false, true) => (0.85, 0.15),
                    _ => (0.5, 0.5),
                };
                pushes.push((i, -nx * overlap * wa * 2.0, -ny * overlap * wa * 2.0));
                pushes.push((j, nx * overlap * wb * 2.0, ny * overlap * wb * 2.0));
            });
        }
        for (i, dx, dy) in pushes {
            let e = &self.ents[i];
            let (nx, ny) = (e.x + dx, e.y + dy);
            if self.map.passable_at(nx, ny) {
                let e = &mut self.ents[i];
                e.x = nx;
                e.y = ny;
            }
        }
    }

    // -----------------------------------------------------------------------
    // Fog of war (for the human player only; the AI sees everything)

    /// Mark what every player's things can see as explored by them.
    pub(crate) fn explore(&mut self) {
        let (w, h) = (self.map.w, self.map.h);
        for e in self.ents.iter().filter(|e| e.alive && e.owner != GAIA && e.owner < 8) {
            let st = e.kind.stats();
            let r = st.sight + st.size as f32 / 2.0;
            let ri = r.ceil() as i32;
            let (cx, cy) = (e.x.floor() as i32, e.y.floor() as i32);
            let bit = 1u8 << e.owner;
            for dy in -ri..=ri {
                for dx in -ri..=ri {
                    let (x, y) = (cx + dx, cy + dy);
                    if x >= 0 && y >= 0 && x < w && y < h && ((dx * dx + dy * dy) as f32) <= r * r {
                        self.explored[(y * w + x) as usize] |= bit;
                    }
                }
            }
        }
    }

    /// Has player `p` ever seen tile (x, y)?
    pub fn explored_by(&self, p: u8, x: i32, y: i32) -> bool {
        self.map.inside(x, y) && self.explored[self.map.idx(x, y)] & (1 << p) != 0
    }

    pub(crate) fn update_fog(&mut self) {
        if self.reveal {
            self.fog.iter_mut().for_each(|v| *v = 2);
            for e in self.ents.iter_mut().filter(|e| e.alive && e.is_building()) {
                e.seen = true;
            }
            return;
        }
        for v in self.fog.iter_mut() {
            if *v == 2 {
                *v = 1;
            }
        }
        let w = self.map.w;
        let me = self.local;
        for e in self.ents.iter().filter(|e| e.alive && e.owner == me) {
            let st = e.kind.stats();
            let r = st.sight + st.size as f32 / 2.0;
            let ri = r.ceil() as i32;
            let (cx, cy) = (e.x.floor() as i32, e.y.floor() as i32);
            for dy in -ri..=ri {
                for dx in -ri..=ri {
                    let (x, y) = (cx + dx, cy + dy);
                    if x >= 0 && y >= 0 && x < w && y < self.map.h && ((dx * dx + dy * dy) as f32) <= r * r {
                        self.fog[(y * w + x) as usize] = 2;
                    }
                }
            }
        }
        for k in 0..self.ents.len() {
            let e = &self.ents[k];
            if e.alive && e.is_building() && !e.seen && self.visible_to_player(e.x, e.y) {
                self.ents[k].seen = true;
            }
        }
    }

    // -----------------------------------------------------------------------
    // Player-only commands (called from lib.rs)


    pub fn clear_selection(&mut self) {
        for e in self.ents.iter_mut() {
            e.selected = false;
        }
    }

    pub fn select_rect(&mut self, x0: f32, y0: f32, x1: f32, y1: f32, add: bool, filter: i32) {
        if !add {
            self.clear_selection();
        }
        let (lx, hx, ly, hy) = (x0.min(x1), x0.max(x1), y0.min(y1), y0.max(y1));
        let inside = |e: &Entity| {
            let r = if e.is_building() { 0.0 } else { e.kind.radius() };
            e.x + r >= lx && e.x - r <= hx && e.y + r >= ly && e.y - r <= hy
        };
        let me = self.local;
        let ok = |e: &Entity| e.alive && e.owner == me && (filter < 0 || e.kind as i32 == filter);
        let any_units = self.ents.iter().any(|e| ok(e) && !e.is_building() && inside(e));
        for e in self.ents.iter_mut() {
            if ok(e) && inside(e) && (e.is_building() != any_units) {
                e.selected = true;
            }
        }
    }

    pub fn select_at(&mut self, x: f32, y: f32, add: bool) -> i32 {
        match self.pick(x, y, true) {
            Pick::Ent(id) => {
                let own = self.ents[id as usize].owner == self.local;
                if !add || !own {
                    self.clear_selection();
                }
                let e = &mut self.ents[id as usize];
                e.selected = if add && own { !e.selected } else { true };
                id as i32
            }
            _ => {
                if !add {
                    self.clear_selection();
                }
                -1
            }
        }
    }

    /// Select every free worker at the local player's campfire. Returns one
    /// of their ids, or -1 if there are none.
    pub fn select_free_workers(&mut self) -> i32 {
        let free: Vec<usize> = (0..self.ents.len()).filter(|&i| self.ents[i].owner == self.local && self.is_free_worker(&self.ents[i])).collect();
        let Some(&first) = free.first() else { return -1 };
        self.clear_selection();
        for i in free {
            self.ents[i].selected = true;
        }
        first as i32
    }

}

// ---------------------------------------------------------------------------
// The nuke

impl Game {
    /// Start arming a nuke: it holds `NUKE_COST` from now until it's launched.
    fn arm_nuke(&mut self, id: u32) -> Result<(), CmdError> {
        let e = &self.ents[id as usize];
        if !e.alive || e.kind != Kind::MissileSilo || e.built < 1.0 || e.nuke != 0 {
            return Err(CmdError::NoBuilding);
        }
        let owner = e.owner;
        self.pay(owner, NUKE_COST)?;
        let e = &mut self.ents[id as usize];
        e.nuke = 1;
        e.progress = 0.0;
        let (x, y) = (e.x, e.y);
        self.push_event(Ev::NukeArming, x, y, owner as f32);
        Ok(())
    }

    /// Launch an armed nuke at (x, y). Its slots come free at once.
    fn launch_nuke(&mut self, id: u32, x: f32, y: f32) -> Result<(), CmdError> {
        let e = &self.ents[id as usize];
        if !e.alive || e.kind != Kind::MissileSilo || e.nuke != 2 {
            return Err(CmdError::NoBuilding);
        }
        let (owner, sx, sy) = (e.owner, e.x, e.y);
        let (x, y) = (x.clamp(0.0, self.map.w as f32), y.clamp(0.0, self.map.h as f32));
        self.ents[id as usize].nuke = 0;
        self.unpay(owner, NUKE_COST);
        self.nukes.push(Nuke { owner, sx, sy, x, y, left: NUKE_FLIGHT });
        self.push_event(Ev::NukeLaunched, x, y, owner as f32);
        Ok(())
    }

    fn update_nukes(&mut self) {
        let mut fell = Vec::new();
        for n in self.nukes.iter_mut() {
            n.left -= DT;
            if n.left <= 0.0 {
                fell.push((n.owner, n.x, n.y));
            }
        }
        self.nukes.retain(|n| n.left > 0.0);
        for (owner, x, y) in fell {
            if let Some(d) = self.interceptor(owner, x, y) {
                self.ents[d].progress = AIR_DEFENSE_RELOAD;
                self.push_event(Ev::NukeIntercepted, x, y, owner as f32);
            } else {
                self.detonate(owner, x, y);
            }
        }
    }

    /// A ready air defense (not the attacker's) within `AIR_DEFENSE_COVER`
    /// of where a nuke falls: the nearest one, oldest first on a tie.
    fn interceptor(&self, owner: u8, x: f32, y: f32) -> Option<usize> {
        let mut best = None;
        let mut bd = f32::MAX;
        for (i, e) in self.ents.iter().enumerate() {
            if e.alive && e.kind == Kind::AirDefense && e.built >= 1.0 && e.owner != owner && e.owner != GAIA && e.progress <= 0.0 {
                let d = e.edge_dist(x, y);
                if d <= AIR_DEFENSE_COVER && d < bd {
                    bd = d;
                    best = Some(i);
                }
            }
        }
        best
    }

    /// Everything near the blast suffers, the nuke's owner's things too:
    /// units die, buildings take `NUKE_DAMAGE`, less with distance. The
    /// ground at the middle becomes a crater nothing can cross or build on.
    fn detonate(&mut self, owner: u8, x: f32, y: f32) {
        for i in 0..self.ents.len() {
            let e = &self.ents[i];
            if !e.alive || e.owner == GAIA {
                continue;
            }
            let d = e.edge_dist(x, y);
            if d > NUKE_RADIUS {
                continue;
            }
            let id = e.id;
            let dmg = if e.is_building() { NUKE_DAMAGE * (1.0 - d / NUKE_RADIUS) } else { e.kind.stats().hp * 10.0 };
            // The silo's owner is the attacker (alerts, fighting back).
            let attacker = self.find_first(owner, Kind::MissileSilo).map_or(id, |s| self.ents[s].id);
            self.damage(id, dmg, attacker);
        }
        let r = CRATER_RADIUS.ceil() as i32;
        for ty in y as i32 - r..=y as i32 + r {
            for tx in x as i32 - r..=x as i32 + r {
                let (cx, cy) = (tx as f32 + 0.5, ty as f32 + 0.5);
                if !self.map.inside(tx, ty) || (cx - x).hypot(cy - y) > CRATER_RADIUS {
                    continue;
                }
                let i = self.map.idx(tx, ty);
                self.map.terrain[i] = map::CRATER;
                self.map.blocked[i] = true;
            }
        }
        self.craters.push((x, y));
        self.push_event(Ev::NukeDetonated, x, y, owner as f32);
    }
}
