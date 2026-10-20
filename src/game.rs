//! The simulation: entities, orders, movement, slots, combat, fog of war.
//!
//! The whole game advances in fixed steps of `DT` seconds (`Game::tick`).
//! Fixed steps keep the simulation deterministic no matter the frame rate;
//! the browser just calls `tick()` 20 times a second and interpolates drawing.

use crate::ai::Ai;
use crate::defs::*;
use crate::map::{self, Deposit, Map};
use crate::path::{Goal, Pathfinder};

pub const DT: f32 = 1.0 / 20.0;
pub const GAIA: u8 = 0;
pub const PLAYER: u8 = 1;
/// Up to four players. Player 0 is "nature" (gaia).
pub const MAX_PLAYERS: usize = 4;
/// Each player starts with two huts with this many residents each, and this
/// many builders. The Capitol's own grain and fruit give the huts 8 beds.
const START_RESIDENTS: u8 = 3;
const START_BUILDERS: usize = 2;
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
    /// A builder walking to a foundation, to be used up there.
    Build(u32),
    /// A newcomer walking to the house they'll live in.
    Arrive(u32),
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Anim {
    Idle = 0,
    Walk = 1,
    Work = 2,
    Fight = 3,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Travel {
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
    WonderBegun = 13, // someone laid a Wonder's foundation (data = owner)
    Eliminated = 14, // a player lost their Capitol and is out (data = player)
}

/// Why a command was refused. `code()` is the number JavaScript receives.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum CmdError {
    /// Not enough free slots of this resource.
    Short(Res),
    QueueFull,
    NoBuilding,
    BadSpot,
    /// Nobody is at home to train.
    NoPeople,
    /// An extractor has to stand next to its deposit.
    NoDeposit(Dep),
    /// The tech tree says no: this building is needed first.
    Locked(Kind),
}

impl CmdError {
    pub fn code(self) -> i32 {
        match self {
            CmdError::Short(r) => 1000 + r.idx() as i32,
            CmdError::QueueFull => 10,
            CmdError::NoBuilding => 11,
            CmdError::BadSpot => 12,
            CmdError::NoPeople => 13,
            CmdError::NoDeposit(d) => 20 + d as i32,
            CmdError::Locked(k) => 2000 + k as i32,
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
    /// A producer with its full crew of workers (always true for one that
    /// needs none). Worked out every tick, like `unsupplied`.
    pub crewed: bool,
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
    // --- houses ---
    /// Who lives here. People at home are the workers and future soldiers.
    pub residents: u8,
    /// Which goods this house gets, one bit per resource index. Its beds
    /// are `BEDS_PER_GOOD` for each.
    pub goods: u32,
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
            crewed: false,
            sfx: 0.0,
            tx: 0,
            ty: 0,
            built: 1.0,
            queue: Vec::new(),
            progress: 0.0,
            rally: None,
            builders_in: 0,
            residents: 0,
            goods: 0,
        }
    }

    /// Beds in this house: two for each different good it gets.
    pub fn beds(&self) -> u8 {
        if self.kind.house_tier().is_some() && self.built >= 1.0 { self.goods.count_ones() as u8 * BEDS_PER_GOOD } else { 0 }
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

    fn set_order(&mut self, order: Order) {
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
    /// Living units (not buildings, not arrivals).
    pub pop: u32,
    /// Seconds until the next newcomer may arrive. Saved.
    pub arrive_timer: f32,
    /// The era this player has reached: 0 Ancient … 5 Atomic. Never goes
    /// back. (Phase 4 raises it, when enough houses reach a tier.) Saved.
    pub era: u8,
    // Worked out every tick (`Game::resolve`), so not saved:
    /// Slots of each good held by houses. They come last: buildings and
    /// units always get what they hold, houses get what's left.
    pub housed: [u16; N_RES],
    /// Beds in all houses, people living in them, units (each holds a bed,
    /// queued ones too), residents at work, and newcomers on their way.
    pub beds: u32,
    pub residents: u32,
    pub units: u32,
    pub working: u32,
    pub arriving: u32,
    /// Lost their Capitol: out of the game.
    pub defeated: bool,
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
            pop: 0,
            arrive_timer: ARRIVAL_INTERVAL,
            era: 0,
            housed: [0; N_RES],
            beds: 0,
            residents: 0,
            units: 0,
            working: 0,
            arriving: 0,
            defeated: false,
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
    /// Tear down your own buildings (not the Capitol).
    Demolish { ids: Vec<u32> },
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
    /// Who won (1 or 2), and whether by Wonder rather than conquest.
    pub winner: u8,
    pub by_wonder: bool,
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

impl Game {
    /// A new game: player 1 is the human, the rest are computer players.
    pub fn new(seed: u32, difficulty: u32, n_players: u8) -> Game {
        let n_players = n_players.clamp(2, MAX_PLAYERS as u8);
        let (map, deps, bases) = map::generate(seed, n_players as usize);
        let n = (map.w * map.h) as usize;
        let handicap = match difficulty {
            0 => 80,
            1 => 100,
            _ => 130,
        };
        // Player 1 is the human; the computer players get the handicap.
        let players = (0..=n_players).map(|p| Player::new(if p > 1 { handicap } else { 100 })).collect();
        // Each AI thinks on a slightly different tick, so they don't all spike at once.
        let ais = (0..=n_players).map(|p| Ai::new(difficulty, p > 1, p as f32 * 0.13)).collect();
        let mut g = Game::from_parts(seed, map, deps, Vec::new(), players, n_players, Vec::new(), vec![0; n], ais, PLAYER);
        for (i, &(bx, by)) in bases.iter().enumerate() {
            let owner = i as u8 + 1;
            g.spawn_building(Kind::Capitol, owner, bx - 1, by - 1, 1.0);
            // Two huts inside the cleared square around the town site.
            for (hx, hy) in [(bx - 4, by + 2), (bx + 2, by - 4)] {
                let h = g.spawn_building(Kind::Hut, owner, hx, hy, 1.0);
                g.ents[h as usize].residents = START_RESIDENTS;
            }
            for k in 0..START_BUILDERS {
                let a = k as f32 * 2.0944 + 0.6;
                g.spawn_unit(Kind::Builder, owner, bx as f32 + 0.5 + a.cos() * 2.6, by as f32 + 0.5 + a.sin() * 2.6);
            }
        }
        g.recount_pop();
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
            time: 0.0,
            fog,
            explored: vec![0; n],
            fog_timer: 0.0,
            state: 0,
            winner: 0,
            by_wonder: false,
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
    fn free_tile_near(&self, tx: i32, ty: i32, size: i32, px: f32, py: f32) -> Option<(f32, f32)> {
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

    /// Is every building `kind` requires in place?
    pub fn unlocked(&self, owner: u8, kind: Kind) -> bool {
        kind.requires().iter().all(|&k| self.has_built(owner, k))
    }

    /// Hand a player slot to the computer (or take it back). In multiplayer
    /// this happens when someone leaves: their people carry on without them.
    pub fn set_ai(&mut self, player: u8, on: bool) {
        if let Some(ai) = self.ais.get_mut(player as usize) {
            ai.on = on && player >= 1;
            if on {
                self.players[player as usize].supply_pct = 100;
            }
        }
    }

    /// Players 1..=n, for `for p in self.player_ids()`.
    pub fn player_ids(&self) -> std::ops::RangeInclusive<u8> {
        1..=self.n_players
    }

    pub fn find_first(&self, owner: u8, kind: Kind) -> Option<usize> {
        self.ents.iter().position(|e| e.alive && e.owner == owner && e.kind == kind)
    }

    /// Is an enemy (from `owner`'s point of view) able to be targeted?
    fn hostile(a: u8, b: u8) -> bool {
        a != b && a != GAIA && b != GAIA
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
    pub fn nearest_enemy(&self, i: usize, radius: f32) -> Option<u32> {
        let me = &self.ents[i];
        let (x, y, owner) = (me.x, me.y, me.owner);
        let reach = radius + if me.is_building() { me.kind.stats().size as f32 / 2.0 } else { me.kind.radius() };
        let mut best = None;
        let mut bd = f32::MAX;
        self.units_near(x, y, reach + 1.0, |id| {
            let e = &self.ents[id as usize];
            if e.alive && Self::hostile(owner, e.owner) {
                let d = e.edge_dist(x, y);
                if d <= reach && d < bd {
                    bd = d;
                    best = Some(id);
                }
            }
        });
        if best.is_some() {
            return best;
        }
        for e in self.ents.iter() {
            if e.alive && e.is_building() && Self::hostile(owner, e.owner) {
                let d = e.edge_dist(x, y);
                if d <= reach && d < bd {
                    bd = d;
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
        self.recount_pop();
        self.resolve();
        self.arrivals();
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

    /// Lose your Capitol and you're out: everything you own falls with it.
    /// The last player standing wins, or whoever finishes a Wonder first.
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
            if !self.players[p as usize].defeated && self.find_first(p, Kind::Capitol).is_none() {
                self.players[p as usize].defeated = true;
                for e in self.ents.iter_mut().filter(|e| e.alive && e.owner == p) {
                    e.hp = 0.0;
                }
                self.push_event(Ev::Eliminated, 0.0, 0.0, p as f32);
            }
        }
        let standing: Vec<u8> = self.player_ids().filter(|&p| !self.players[p as usize].defeated).collect();
        let wonder = self.player_ids().find(|&p| self.has_built(p, Kind::Wonder));
        let (w, by_wonder) = match (wonder, standing.as_slice()) {
            (Some(p), _) => (p, true),
            (None, [only]) => (*only, false),
            (None, []) => (self.local, false), // everyone fell at once: call it a draw, kindly
            _ => (0, false),
        };
        if w != 0 {
            self.state = 1;
            self.winner = w;
            self.by_wonder = by_wonder;
        }
    }

    fn recount_pop(&mut self) {
        for p in self.players.iter_mut() {
            p.pop = 0;
        }
        for e in self.ents.iter().filter(|e| e.alive && e.kind.holds_bed()) {
            self.players[e.owner as usize].pop += 1;
        }
    }

    /// Work out each player's economy from scratch, from what exists, in
    /// the design's fixed order (docs/design/economy-and-eras.md,
    /// *Resolution order*). Cheap enough to do every tick, which means slots
    /// come free the tick after something dies, and nothing but houses'
    /// residents and goods needs saving.
    ///
    /// 1. Residents at home are everyone living in a house.
    /// 2. Producers take their crews from them while enough are left:
    ///    producers of house goods first, then the rest, each in id order.
    ///    A producer without its full crew makes nothing. (Food first keeps
    ///    the economy from spiralling: losing people idles a lumber camp
    ///    before a farm, so beds don't vanish along with them.)
    /// 3. Supply comes from crewed producers.
    /// 4. Use: every building, foundation, unit and queued unit.
    /// 5. (Converters, from the Medieval era.)
    /// 6. Units over a shortage are unsupplied (`supply_units`).
    /// 7. Houses, nearest the Capitol first, take one slot of each good they
    ///    can use from what's left, keeping goods they already had first.
    /// 8. Residents who no longer fit leave, furthest houses first.
    pub(crate) fn resolve(&mut self) {
        self.resolve_with(true);
    }

    /// Work out all the counts `resolve` does, without changing anything
    /// that's saved (houses' goods and residents, units' health).
    pub(crate) fn recount(&mut self) {
        self.resolve_with(false);
    }

    fn resolve_with(&mut self, settle: bool) {
        let n = self.players.len();
        // Counted in u32, then clamped: no overflow, whatever a save holds.
        let mut supply = vec![[0u32; N_RES]; n];
        let mut used = vec![[0u32; N_RES]; n];
        let mut at_home = vec![0u32; n];
        let mut units = vec![0u32; n];
        for e in self.ents.iter().filter(|e| e.alive) {
            if e.kind.house_tier().is_some() {
                at_home[e.owner as usize] += e.residents as u32;
            }
            if e.kind.holds_bed() {
                units[e.owner as usize] += 1;
            }
            units[e.owner as usize] += e.queue.iter().filter(|k| k.holds_bed()).count() as u32;
        }
        // 2–3. Crews and supply: house goods' producers first, then the rest.
        let mut left = at_home.clone();
        for houses_first in [true, false] {
            for e in self.ents.iter_mut().filter(|e| e.alive) {
                let st = e.kind.stats();
                if st.produces.iter().any(|&(r, _)| r.is_house_good()) != houses_first {
                    continue;
                }
                let o = e.owner as usize;
                e.crewed = e.built >= 1.0 && left[o] >= st.workers as u32;
                if e.crewed && !st.produces.is_empty() {
                    left[o] -= st.workers as u32;
                    for &(r, k) in st.produces {
                        supply[o][r.idx()] += k as u32;
                    }
                }
            }
        }
        // 4. Use.
        for e in self.ents.iter().filter(|e| e.alive) {
            let o = e.owner as usize;
            let st = e.kind.stats();
            for &(r, k) in st.cost {
                used[o][r.idx()] += k as u32;
            }
            for q in &e.queue {
                for &(r, k) in q.stats().cost {
                    used[o][r.idx()] += k as u32;
                }
            }
        }
        for (o, p) in self.players.iter_mut().enumerate() {
            for r in 0..N_RES {
                // Integer percent, rounded down: exact on every computer.
                p.supply[r] = (supply[o][r] * p.supply_pct as u32 / 100).min(u16::MAX as u32) as u16;
                p.used[r] = used[o][r].min(u16::MAX as u32) as u16;
            }
            p.residents = at_home[o];
            p.working = at_home[o] - left[o];
            p.units = units[o];
        }
        // 6.
        self.supply_units(settle);
        // 7–8, player by player.
        for owner in self.player_ids() {
            self.house_goods(owner, settle);
        }
        let mut arriving = vec![0u32; n];
        for e in self.ents.iter().filter(|e| e.alive && e.kind == Kind::Arrival) {
            arriving[e.owner as usize] += 1;
        }
        for (o, p) in self.players.iter_mut().enumerate() {
            p.arriving = arriving[o];
        }
    }

    /// Houses of `owner`, nearest the Capitol first (ties by id): squared
    /// distance in whole tiles, so it's exact on every computer.
    fn houses_by_distance(&self, owner: u8) -> Vec<usize> {
        let (cx, cy) = self.find_first(owner, Kind::Capitol).map_or((0, 0), |c| (self.ents[c].tx, self.ents[c].ty));
        let mut hs: Vec<(i32, usize)> = self
            .ents
            .iter()
            .enumerate()
            .filter(|(_, e)| e.alive && e.owner == owner && e.kind.house_tier().is_some())
            .map(|(i, e)| ((e.tx - cx).pow(2) + (e.ty - cy).pow(2), i))
            .collect();
        hs.sort();
        hs.into_iter().map(|(_, i)| i).collect()
    }

    /// Steps 7 and 8 of `resolve` for one player.
    /// With `settle` false, only count what the houses hold now.
    fn house_goods(&mut self, owner: u8, settle: bool) {
        let houses = self.houses_by_distance(owner);
        if !settle {
            let p = &mut self.players[owner as usize];
            p.housed = [0; N_RES];
            p.beds = 0;
            p.residents = 0;
            for &i in &houses {
                let e = &self.ents[i];
                for (r, slot) in p.housed.iter_mut().enumerate() {
                    *slot += (e.goods >> r & 1) as u16;
                }
                p.beds += e.beds() as u32;
                p.residents += e.residents as u32;
            }
            p.working = p.working.min(p.residents);
            return;
        }
        let p = &self.players[owner as usize];
        // What's left for houses after buildings and units.
        let mut left: [i32; N_RES] = std::array::from_fn(|r| p.free(Res::ALL[r]).max(0));
        let wanted = |r: Res, tier: u8| r.is_house_good() && r.era() <= tier;
        let mut goods = vec![0u32; houses.len()];
        // First every house keeps what it had, nearest first, so a shortage
        // empties the furthest houses rather than shuffling goods around.
        for (h, &i) in houses.iter().enumerate() {
            let e = &self.ents[i];
            let Some(tier) = e.kind.house_tier().filter(|_| e.built >= 1.0) else { continue };
            for r in Res::ALL {
                if goods[h].count_ones() < house_max_goods(tier) as u32 && e.goods & (1 << r.idx()) != 0 && wanted(r, tier) && left[r.idx()] > 0 {
                    goods[h] |= 1 << r.idx();
                    left[r.idx()] -= 1;
                }
            }
        }
        // Then each house, nearest first, takes new goods from what's left.
        for (h, &i) in houses.iter().enumerate() {
            let e = &self.ents[i];
            let Some(tier) = e.kind.house_tier().filter(|_| e.built >= 1.0) else { continue };
            for r in Res::ALL {
                if goods[h].count_ones() < house_max_goods(tier) as u32 && goods[h] & (1 << r.idx()) == 0 && wanted(r, tier) && left[r.idx()] > 0 {
                    goods[h] |= 1 << r.idx();
                    left[r.idx()] -= 1;
                }
            }
        }
        let mut housed = [0u16; N_RES];
        let mut beds = 0u32;
        for (h, &i) in houses.iter().enumerate() {
            let e = &mut self.ents[i];
            e.goods = goods[h];
            for (r, slot) in housed.iter_mut().enumerate() {
                *slot += (goods[h] >> r & 1) as u16;
            }
            // 8. Nobody stays in a house without a bed for them...
            e.residents = e.residents.min(e.beds());
            beds += e.beds() as u32;
        }
        // ...and units hold beds too: if beds ran short, residents of the
        // furthest houses leave until everyone fits.
        let units = self.players[owner as usize].units;
        let mut residents: u32 = houses.iter().map(|&i| self.ents[i].residents as u32).sum();
        for &i in houses.iter().rev() {
            let over = (residents + units).saturating_sub(beds);
            if over == 0 {
                break;
            }
            let e = &mut self.ents[i];
            let go = over.min(e.residents as u32);
            e.residents -= go as u8;
            residents -= go;
        }
        let p = &mut self.players[owner as usize];
        p.housed = housed;
        p.beds = beds;
        p.residents = residents;
        p.working = p.working.min(residents);
    }

    /// Newcomers: every `ARRIVAL_INTERVAL` seconds, if there's a free bed
    /// (counting the ones already on their way), someone arrives at the
    /// Capitol and walks to the nearest house with room.
    fn arrivals(&mut self) {
        for owner in self.player_ids() {
            let p = &mut self.players[owner as usize];
            if p.defeated {
                continue;
            }
            p.arrive_timer -= DT;
            if p.arrive_timer > 0.0 {
                continue;
            }
            p.arrive_timer += ARRIVAL_INTERVAL;
            if p.residents + p.units + p.arriving >= p.beds {
                continue;
            }
            let Some(cap) = self.find_first(owner, Kind::Capitol) else { continue };
            let (cx, cy) = (self.ents[cap].x, self.ents[cap].y);
            let Some(house) = self.house_with_room(owner, cx, cy) else { continue };
            let c = &self.ents[cap];
            let (tx, ty, size) = (c.tx, c.ty, c.kind.stats().size);
            // Out of the Capitol's front door (the side facing +y).
            let (x, y) = self.free_tile_near(tx, ty, size, cx, cy + 2.0).unwrap_or((cx, cy + 2.0));
            let id = self.spawn_unit(Kind::Arrival, owner, x, y);
            self.ents[id as usize].order = Order::Arrive(house);
            self.players[owner as usize].arriving += 1;
        }
    }

    /// The house of `owner`'s nearest (x, y) with a bed nobody has or is
    /// walking to. Ties go to the lower id.
    pub fn house_with_room(&self, owner: u8, x: f32, y: f32) -> Option<u32> {
        let mut best = None;
        let mut bd = f32::MAX;
        for e in self.ents.iter().filter(|e| e.alive && e.owner == owner && e.kind.house_tier().is_some()) {
            let coming = self.ents.iter().filter(|a| a.alive && a.order == Order::Arrive(e.id)).count() as u32;
            if e.residents as u32 + coming >= e.beds() as u32 {
                continue;
            }
            let d = (e.x - x).powi(2) + (e.y - y).powi(2);
            if d < bd {
                bd = d;
                best = Some(e.id);
            }
        }
        best
    }

    /// The house of `owner`'s nearest (x, y) matching `ok`, by whole-tile
    /// squared distance (ties by id).
    fn nearest_house(&self, owner: u8, x: f32, y: f32, ok: impl Fn(&Entity) -> bool) -> Option<usize> {
        let (px, py) = (x as i32, y as i32);
        self.ents
            .iter()
            .enumerate()
            .filter(|(_, e)| e.alive && e.owner == owner && e.kind.house_tier().is_some() && ok(e))
            .min_by_key(|(i, e)| ((e.tx - px).pow(2) + (e.ty - py).pow(2), *i))
            .map(|(i, _)| i)
    }

    /// Remove a unit without a death: a builder used up at a foundation, a
    /// newcomer who moved in.
    fn vanish(&mut self, i: usize) {
        let e = &mut self.ents[i];
        e.alive = false;
        e.selected = false;
    }

    /// When a player holds more of a resource than they make (a producer was
    /// destroyed), their newest units holding it are unsupplied and slowly
    /// lose health, until supply is back or enough have died to fit.
    /// Buildings and queued units still hold their slots but don't suffer.
    /// With `settle` false, only mark them (no damage, no message).
    fn supply_units(&mut self, settle: bool) {
        for e in self.ents.iter_mut() {
            e.unsupplied = false;
        }
        for owner in self.player_ids() {
            let p = self.players[owner as usize];
            let mut any = false;
            let mut first_short = None;
            for r in Res::ALL {
                let mut deficit = -p.free(r);
                if deficit <= 0 {
                    continue;
                }
                first_short.get_or_insert(r);
                // Newest first: highest id first.
                for e in self.ents.iter_mut().rev() {
                    if deficit <= 0 {
                        break;
                    }
                    if !e.alive || e.owner != owner || e.is_building() {
                        continue;
                    }
                    if let Some(&(_, k)) = e.kind.stats().cost.iter().find(|&&(res, _)| res == r) {
                        e.unsupplied = true;
                        any = true;
                        deficit -= k as i32;
                    }
                }
            }
            if !settle {
                continue;
            }
            let was = self.players[owner as usize].short;
            self.players[owner as usize].short = any;
            if any && !was && owner == self.local {
                let r = first_short.map_or(0, |r| r.idx());
                self.push_event(Ev::Short, 0.0, 0.0, r as f32);
            }
        }
        if settle && UNSUPPLIED_DAMAGE > 0.0 {
            for e in self.ents.iter_mut().filter(|e| e.alive && e.unsupplied) {
                e.hp -= e.kind.stats().hp * UNSUPPLIED_DAMAGE * DT;
            }
        }
    }

    fn push_event(&mut self, ev: Ev, x: f32, y: f32, data: f32) {
        // If nobody drains the queue (e.g. a headless test), don't grow forever.
        if self.events.len() < 4096 {
            self.events.extend_from_slice(&[ev as u32 as f32, x, y, data]);
        }
    }

    /// Advance a unit's work-sound timer; true once per stroke (~0.9 s).
    /// The id offsets the phase so a crowd of woodcutters doesn't chop in unison.
    fn work_stroke(&mut self, i: usize) -> bool {
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
        if let Some(&unit) = self.ents[i].queue.first() {
            {
                self.ents[i].progress += DT / unit.stats().time;
                if self.ents[i].progress >= 1.0 {
                    self.ents[i].progress = 0.0;
                    self.ents[i].queue.remove(0);
                    let id = self.spawn_from(i, unit);
                    self.players[owner].pop += 1;
                    self.players[owner].trained += 1;
                    if owner == self.local as usize {
                        let (x, y) = (self.ents[id as usize].x, self.ents[id as usize].y);
                        self.push_event(Ev::Trained, x, y, unit as u32 as f32);
                    }
                }
            }
        }
    }

    /// A foundation with all its builders rises by itself over its build time.
    fn rise(&mut self, i: usize) {
        let b = &mut self.ents[i];
        let st = b.kind.stats();
        if b.builders_in < st.builders {
            return;
        }
        b.built += DT / st.time;
        b.hp = (b.hp + st.hp * 0.9 * DT / st.time).min(st.hp);
        if b.built >= 1.0 {
            b.built = 1.0;
            let (owner, kind, bx, by) = (b.owner, b.kind, b.x, b.y);
            self.players[owner as usize].built += 1;
            if owner == self.local {
                self.push_event(Ev::Built, bx, by, kind as u32 as f32);
            }
        } else if self.work_stroke(i) {
            let (bx, by) = (self.ents[i].x, self.ents[i].y);
            self.push_event(Ev::Hammer, bx, by, 0.0);
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
        if let Some(&(r, _)) = cost.iter().find(|&&(r, k)| p.free(r) < k as i32) {
            return Err(CmdError::Short(r));
        }
        for &(r, k) in cost {
            p.used[r.idx()] = p.used[r.idx()].saturating_add(k);
        }
        Ok(())
    }

    /// Give back slots taken this tick (a cancelled unit).
    fn unpay(&mut self, owner: u8, cost: Slots) {
        let p = &mut self.players[owner as usize];
        for &(r, k) in cost {
            p.used[r.idx()] = p.used[r.idx()].saturating_sub(k);
        }
    }

    /// The first resource `owner` lacks free slots of for `kind`, if any.
    pub fn short_of(&self, owner: u8, kind: Kind) -> Option<Res> {
        let p = &self.players[owner as usize];
        kind.stats().cost.iter().find(|&&(r, k)| p.free(r) < k as i32).map(|&(r, _)| r)
    }

    pub fn queue_unit(&mut self, building: u32, kind: Kind) -> Result<(), CmdError> {
        let b = &self.ents[building as usize];
        if !b.alive || b.built < 1.0 || !b.kind.trains().contains(&kind) {
            return Err(CmdError::NoBuilding);
        }
        if b.queue.len() >= 5 {
            return Err(CmdError::QueueFull);
        }
        let (owner, x, y) = (b.owner, b.x, b.y);
        // Every unit is a person: someone from the house nearest the
        // building leaves home for it at once.
        let home = self.nearest_house(owner, x, y, |h| h.residents > 0);
        if kind.holds_bed() && home.is_none() {
            return Err(CmdError::NoPeople);
        }
        self.pay(owner, kind.stats().cost)?; // `?` returns the error early if paying failed
        if let (true, Some(h)) = (kind.holds_bed(), home) {
            self.ents[h].residents -= 1;
            self.players[owner as usize].residents -= 1;
        }
        self.ents[building as usize].queue.push(kind);
        Ok(())
    }

    /// Take the last unit out of a queue. The person goes back home, to the
    /// nearest house with a free bed; with none, they're lost.
    pub fn cancel_unit(&mut self, building: u32) {
        let Some(b) = self.ents.get_mut(building as usize) else { return };
        if let Some(k) = b.queue.pop() {
            if b.queue.is_empty() {
                b.progress = 0.0;
            }
            let (owner, x, y) = (b.owner, b.x, b.y);
            self.unpay(owner, k.stats().cost);
            if k.holds_bed() {
                if let Some(h) = self.nearest_house(owner, x, y, |h| h.residents < h.beds()) {
                    self.ents[h].residents += 1;
                    self.players[owner as usize].residents += 1;
                }
            }
        }
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
        let s = kind.stats().size;
        for y in ty - margin..ty + s + margin {
            for x in tx - margin..tx + s + margin {
                if !self.map.inside(x, y) {
                    return false;
                }
                let i = self.map.idx(x, y);
                let inner = x >= tx && y >= ty && x < tx + s && y < ty + s;
                if self.map.bld_at[i] >= 0 || (inner && (self.map.terrain[i] == map::WATER || self.map.dep_at[i] >= 0)) {
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
        if !kind.is_building() || kind == Kind::Capitol || !self.spot_free(kind, tx, ty, owner, 0) {
            return Err(CmdError::BadSpot);
        }
        if !self.near_deposit(kind, tx, ty) {
            return Err(CmdError::NoDeposit(kind.stats().needs_deposit.unwrap_or(Dep::Forest)));
        }
        if let Some(&missing) = kind.requires().iter().find(|&&k| !self.has_built(owner, k)) {
            return Err(CmdError::Locked(missing));
        }
        self.pay(owner, kind.stats().cost)?;
        let id = self.spawn_building(kind, owner, tx, ty, 0.0);
        if kind == Kind::Wonder {
            let (x, y) = (self.ents[id as usize].x, self.ents[id as usize].y);
            self.push_event(Ev::WonderBegun, x, y, owner as f32);
        }
        for &b in builders {
            self.order_build(b, id);
        }
        Ok(id)
    }

    // -----------------------------------------------------------------------
    // Orders (used by both the player commands and the AI)

    fn is_builder(&self, id: u32) -> bool {
        self.alive(id) && self.ents[id as usize].kind == Kind::Builder
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
        if !self.is_builder(id) {
            return;
        }
        self.ents[id as usize].set_order(Order::Build(target));
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
            if !e.alive || e.is_building() || e.kind == Kind::Arrival {
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
        let any_builder = mine().any(|id| self.is_builder(id));
        match self.pick(x, y, fog) {
            Pick::Ent(t) if Self::hostile(owner, self.ents[t as usize].owner) => Intent::Attack(t),
            Pick::Ent(t) if any_builder && self.ents[t as usize].owner == owner && self.ents[t as usize].is_building() && self.ents[t as usize].built < 1.0 => Intent::Build(t),
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
                    if self.is_builder(u) {
                        self.order_build(u, t);
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
        // (Newcomers aren't anyone's to command.)
        let own = |g: &Game, ids: &[u32]| -> Vec<u32> { ids.iter().copied().filter(|&id| g.alive(id) && g.ents[id as usize].owner == owner && g.ents[id as usize].kind != Kind::Arrival).collect() };
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
                    if self.ents[id as usize].kind.is_military() {
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
                let builders: Vec<u32> = own(self, &ids).into_iter().filter(|&id| self.ents[id as usize].kind == Kind::Builder).collect();
                self.place(owner, kind, tx, ty, &builders)?;
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
            mix(e.residents as u32 | (e.builders_in as u32) << 8);
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
            mix(e.residents as u32 | (e.builders_in as u32) << 8);
            mix(e.goods);
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
            Order::Arrive(house) => self.do_arrive(i, house),
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
        if self.ents[i].kind.is_military() && self.ents[i].scan <= 0.0 {
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
        if !self.alive(target) {
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
            let (x, y) = (a.x, a.y);
            self.proj.push(Projectile { x, y, px: x, py: y, target, damage: dmg, attacker: a.id, alive: true });
            self.push_event(Ev::Shoot, x, y, kind);
        } else {
            let t = &self.ents[target as usize];
            let (tx, ty) = (t.x, t.y);
            self.damage(target, dmg, i as u32);
            self.push_event(Ev::Melee, tx, ty, kind);
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
                let (tg, dm, at) = (p.target, p.damage, p.attacker);
                let t = &self.ents[tg as usize];
                let (tx, ty, bld) = (t.x, t.y, t.is_building());
                self.damage(tg, dm, at);
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
                    self.map.blocked[j] = false;
                }
            }
        }
    }

    /// A player tears down their own building (not the Capitol): its slots,
    /// workers and beds come free next tick. Residents of a house move out;
    /// anyone queued in it is lost.
    fn demolish(&mut self, id: u32) {
        let e = &self.ents[id as usize];
        if !e.is_building() || e.kind == Kind::Capitol {
            return;
        }
        let (x, y, kind, owner) = (e.x, e.y, e.kind, e.owner);
        self.remove(id as usize);
        self.push_event(Ev::Death, x, y, owner as f32 * 100.0 + kind as u32 as f32);
    }

    // --- economy ---

    /// A builder walks to a foundation. On arrival, if it still needs
    /// builders, they're used up there (`builders_in` counts them);
    /// otherwise they wait beside it.
    fn do_build(&mut self, i: usize, target: u32) {
        if !self.alive(target) {
            self.ents[i].set_order(Order::Idle);
            return;
        }
        let t = &self.ents[target as usize];
        if t.built >= 1.0 || t.builders_in >= t.kind.stats().builders {
            self.ents[i].set_order(Order::Idle);
            return;
        }
        let goal = t.goal(0.75);
        match self.travel(i, goal, 3.0) {
            Travel::Moving => {}
            Travel::Blocked => self.ents[i].set_order(Order::Idle),
            Travel::Arrived => {
                let b = &mut self.ents[target as usize];
                b.builders_in += 1;
                let (bx, by) = (b.x, b.y);
                self.push_event(Ev::Hammer, bx, by, 0.0);
                self.vanish(i);
            }
        }
    }

    /// A newcomer walks to their house and moves in. If it's gone or full,
    /// they look for another; with none left, they go away again.
    fn do_arrive(&mut self, i: usize, house: u32) {
        let e = &self.ents[i];
        let (owner, x, y) = (e.owner, e.x, e.y);
        let room = |g: &Game, h: u32| g.alive(h) && g.ents[h as usize].owner == owner && g.ents[h as usize].residents < g.ents[h as usize].beds();
        if !room(self, house) {
            // Not counting ourselves as already on our way there.
            self.ents[i].order = Order::Idle;
            match self.house_with_room(owner, x, y) {
                Some(h) => self.ents[i].set_order(Order::Arrive(h)),
                None => self.vanish(i),
            }
            return;
        }
        let goal = self.ents[house as usize].goal(0.6);
        match self.travel(i, goal, 3.0) {
            Travel::Moving => {}
            Travel::Blocked => self.vanish(i),
            Travel::Arrived => {
                self.ents[house as usize].residents += 1;
                self.vanish(i);
            }
        }
    }

    // --- movement ---

    /// Move unit `i` toward `goal`, (re)computing a path when needed.
    fn travel(&mut self, i: usize, goal: Goal, repath_every: f32) -> Travel {
        let (x, y) = (self.ents[i].x, self.ents[i].y);
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
            if !a.alive || a.is_building() {
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
        let ok = |e: &Entity| e.alive && e.owner == me && e.kind != Kind::Arrival && (filter < 0 || e.kind as i32 == filter);
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

    pub fn select_idle_builder(&mut self) -> i32 {
        let n = self.ents.len() as u32;
        for k in 1..=n {
            let id = (self.idle_cursor + k) % n;
            let e = &self.ents[id as usize];
            if e.alive && e.owner == self.local && e.kind == Kind::Builder && e.order == Order::Idle {
                self.idle_cursor = id;
                self.clear_selection();
                self.ents[id as usize].selected = true;
                return id as i32;
            }
        }
        -1
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    /// What a player has, for printing: kind name → count.
    fn census(g: &Game, p: u8) -> String {
        let mut out = String::new();
        for k in Kind::ALL {
            let n = g.ents.iter().filter(|e| e.alive && e.owner == p && e.kind == k).count();
            if n > 0 {
                out += &format!("{k:?} {n}, ");
            }
        }
        let pl = &g.players[p as usize];
        out += &format!("| people {}+{} units/{} beds, {} working, {} coming | ", pl.residents, pl.units, pl.beds, pl.working, pl.arriving);
        for r in Res::ALL.iter().take(7) {
            out += &format!("{r:?} {}/{} ", pl.used[r.idx()], pl.supply[r.idx()]);
        }
        out
    }

    /// A spot near player 1's Capitol where `kind` can go, searching outward.
    fn spot(g: &Game, kind: Kind) -> (i32, i32) {
        let cap = &g.ents[g.find_first(1, Kind::Capitol).unwrap()];
        let (cx, cy) = (cap.tx, cap.ty);
        for r in 3..30 {
            for y in cy - r..=cy + r {
                for x in cx - r..=cx + r {
                    if g.can_place(kind, x, y, 1, 1) {
                        return (x, y);
                    }
                }
            }
        }
        panic!("no spot for {kind:?}");
    }

    /// A finished building of player 1's, put straight on the map.
    fn build(g: &mut Game, kind: Kind) -> u32 {
        let (x, y) = spot(g, kind);
        let id = g.spawn_building(kind, 1, x, y, 1.0);
        g.resolve();
        id
    }

    fn free(g: &Game, r: Res) -> i32 {
        g.players[1].free(r)
    }

    #[test]
    fn a_new_game_starts_with_nobody_short() {
        for players in 2..=4 {
            let mut g = Game::new(9, 1, players);
            g.tick();
            for p in 1..=players {
                assert!(Res::ALL.iter().all(|&r| g.players[p as usize].free(r) >= 0), "player {p} starts short");
                let pl = &g.players[p as usize];
                assert_eq!((pl.residents, pl.units, pl.beds), (6, 2, 8), "player {p}: 6 at home, 2 builders, 8 beds");
                let cap = g.find_first(p, Kind::Capitol).unwrap() as u32;
                assert!(g.queue_unit(cap, Kind::Builder).is_ok(), "player {p} can train a builder at once");
            }
        }
    }

    #[test]
    fn slots_come_free_the_tick_after_a_unit_dies() {
        let mut g = Game::new(5, 1, 2);
        build(&mut g, Kind::LumberCamp);
        let barracks = build(&mut g, Kind::Barracks);
        let wood = free(&g, Res::Wood);
        let soldier = g.spawn_unit(Kind::Spearman, 1, 30.0, 30.0);
        g.tick();
        assert_eq!(free(&g, Res::Wood), wood - 1, "a soldier holds a wood slot");
        g.ents[soldier as usize].hp = 0.0;
        g.tick(); // dies at the end of this tick
        g.tick();
        assert_eq!(free(&g, Res::Wood), wood, "and gives it back once dead");
        // Queued units hold their slots too; cancelling frees them at once.
        g.apply(1, Command::Train { ids: vec![barracks], kind: Kind::Spearman }).unwrap();
        assert_eq!(free(&g, Res::Wood), wood - 1);
        g.apply(1, Command::Cancel { id: barracks }).unwrap();
        assert_eq!(free(&g, Res::Wood), wood);
    }

    #[test]
    fn two_placements_in_one_tick_cannot_share_a_slot() {
        let mut g = Game::new(5, 1, 2);
        build(&mut g, Kind::LumberCamp);
        // Use up wood until exactly 3 are free: one Barracks' worth.
        while free(&g, Res::Wood) > 3 {
            g.spawn_unit(Kind::Spearman, 1, 30.0, 30.0);
            g.resolve();
        }
        let (x, y) = spot(&g, Kind::Barracks);
        assert!(g.apply(1, Command::Place { ids: vec![], kind: Kind::Barracks, tx: x, ty: y }).is_ok());
        let (x, y) = spot(&g, Kind::Barracks);
        let second = g.apply(1, Command::Place { ids: vec![], kind: Kind::Barracks, tx: x, ty: y });
        assert_eq!(second.err(), Some(CmdError::Short(Res::Wood)));
        g.tick();
        assert_eq!(free(&g, Res::Wood), 0);
    }

    #[test]
    fn extractors_need_their_deposit() {
        let mut g = Game::new(5, 1, 2);
        // A quarry right beside the Capitol is nowhere near stone.
        let cap = &g.ents[g.find_first(1, Kind::Capitol).unwrap()];
        let (x, y) = (cap.tx + 4, cap.ty);
        assert!(!g.near_deposit(Kind::Quarry, x, y));
        let r = g.apply(1, Command::Place { ids: vec![], kind: Kind::Quarry, tx: x, ty: y });
        assert_eq!(r.err(), Some(CmdError::NoDeposit(Dep::Stone)));
        // Next to stone it works, and once built it makes stone.
        let stone = g.players[1].supply[Res::Stone.idx()];
        build(&mut g, Kind::Quarry);
        assert_eq!(g.players[1].supply[Res::Stone.idx()], stone + 4);
    }

    #[test]
    fn a_lost_producer_leaves_the_newest_units_unsupplied() {
        let mut g = Game::new(5, 1, 2);
        let pasture = build(&mut g, Kind::Pasture);
        assert_eq!(free(&g, Res::Horses), 2);
        let older = g.spawn_unit(Kind::Horseman, 1, 30.0, 30.0);
        let newer = g.spawn_unit(Kind::Horseman, 1, 31.0, 30.0);
        g.tick();
        assert_eq!(free(&g, Res::Horses), 0);
        // The pasture burns: 2 horses held, none made. Nothing crashes.
        g.ents[pasture as usize].hp = 0.0;
        g.tick();
        g.tick();
        assert_eq!(free(&g, Res::Horses), -2);
        assert!(g.ents[newer as usize].unsupplied && g.ents[older as usize].unsupplied);
        // A second pasture covers two again; with one more horseman, only the
        // newest goes without.
        build(&mut g, Kind::Pasture);
        let newest = g.spawn_unit(Kind::Horseman, 1, 32.0, 30.0);
        let hp = g.ents[newest as usize].hp;
        let older_hp = g.ents[older as usize].hp;
        for _ in 0..20 {
            g.tick();
        }
        assert!(!g.ents[older as usize].unsupplied && !g.ents[newer as usize].unsupplied);
        assert!(g.ents[newest as usize].unsupplied);
        let lost = hp - g.ents[newest as usize].hp;
        let expect = Kind::Horseman.stats().hp * UNSUPPLIED_DAMAGE; // one second's worth
        assert!((lost - expect).abs() < 0.01, "lost {lost}, expected {expect}");
        assert_eq!(g.ents[older as usize].hp, older_hp, "supplied units don't lose health");
    }

    #[test]
    fn saves_keep_slots_in_step() {
        let mut a = Game::new(77, 2, 2);
        a.set_ai(1, true);
        let start = a.ents.len();
        for _ in 0..2000 {
            a.tick();
        }
        assert!(a.ents.len() > start + 5, "the AI should have built things by now");
        let mut b = Game::load(&a.save()).expect("load");
        assert_eq!((a.players[1].supply, a.players[1].used), (b.players[1].supply, b.players[1].used));
        for _ in 0..2000 {
            a.tick();
            b.tick();
        }
        assert_eq!(a.checksum(), b.checksum());
    }

    fn houses(g: &Game, p: u8) -> Vec<usize> {
        g.houses_by_distance(p)
    }

    #[test]
    fn beds_are_two_per_good() {
        let mut g = Game::new(5, 1, 2);
        // The Capitol's grain and fruit: both huts get 2 goods, 4 beds each.
        for h in houses(&g, 1) {
            assert_eq!((g.ents[h].goods.count_ones(), g.ents[h].beds()), (2, 4));
        }
        // Meat from a hunting lodge (crewed by a resident) makes it 3 goods: 6 beds.
        build(&mut g, Kind::HuntingLodge);
        g.resolve();
        for h in houses(&g, 1) {
            assert_eq!((g.ents[h].goods.count_ones(), g.ents[h].beds()), (3, 6));
        }
        // A hut uses at most 3 goods, however many there are.
        build(&mut g, Kind::FishingHut);
        g.resolve();
        for h in houses(&g, 1) {
            assert_eq!(g.ents[h].beds(), 6);
        }
        assert_eq!(g.players[1].beds, 12);
    }

    #[test]
    fn losing_a_farm_empties_the_furthest_houses_first() {
        let mut g = Game::new(5, 1, 2);
        build(&mut g, Kind::LumberCamp); // wood for the huts
        let farm = build(&mut g, Kind::Farm); // grain 2 + 2 = 4
        build(&mut g, Kind::Hut);
        build(&mut g, Kind::Hut);
        g.resolve();
        let hs = houses(&g, 1);
        assert_eq!(hs.len(), 4);
        let grain = 1 << Res::Grain.idx();
        assert!(hs.iter().all(|&h| g.ents[h].goods & grain != 0), "4 grain for 4 huts");
        g.ents[farm as usize].hp = 0.0;
        g.tick();
        g.tick();
        let has: Vec<bool> = hs.iter().map(|&h| g.ents[h].goods & grain != 0).collect();
        assert_eq!(has, [true, true, false, false], "the two nearest keep their grain");
    }

    #[test]
    fn a_unit_takes_a_resident_and_holds_a_bed_until_it_dies() {
        let mut g = Game::new(5, 1, 2);
        build(&mut g, Kind::LumberCamp);
        let barracks = build(&mut g, Kind::Barracks);
        let (res, units) = (g.players[1].residents, g.players[1].units);
        g.apply(1, Command::Train { ids: vec![barracks], kind: Kind::Spearman }).unwrap();
        g.tick();
        assert_eq!((g.players[1].residents, g.players[1].units), (res - 1, units + 1), "queued: one fewer at home, one more unit");
        for _ in 0..20 * 20 {
            g.tick();
        }
        let soldier = g.ents.iter().find(|e| e.alive && e.kind == Kind::Spearman).expect("trained").id;
        let p = &g.players[1];
        assert_eq!(p.residents + p.units + p.arriving, p.beds.min(res + units), "nobody new while every bed is taken");
        g.ents[soldier as usize].hp = 0.0;
        g.tick();
        g.tick();
        assert_eq!(g.players[1].units, units, "its bed is free again");
        // ...and someone new comes to fill it.
        for _ in 0..20 * 25 {
            g.tick();
        }
        assert_eq!(g.players[1].residents, res);
        // Nobody at home: training is refused.
        for h in houses(&g, 1) {
            g.ents[h].residents = 0;
        }
        let r = g.apply(1, Command::Train { ids: vec![barracks], kind: Kind::Spearman });
        assert_eq!(r.err(), Some(CmdError::NoPeople));
    }

    #[test]
    fn a_foundation_waits_for_all_its_builders() {
        let mut g = Game::new(5, 1, 2);
        let (x, y) = spot(&g, Kind::Wonder);
        let w = g.spawn_building(Kind::Wonder, 1, x, y, 0.0);
        let near = |k: f32| (x as f32 - 1.5 + k, y as f32 - 1.5);
        let b: Vec<u32> = (0..3).map(|k| g.spawn_unit(Kind::Builder, 1, near(k as f32).0, near(k as f32).1)).collect();
        g.order_build(b[0], w);
        g.order_build(b[1], w);
        for _ in 0..20 * 10 {
            g.tick();
        }
        let wonder = &g.ents[w as usize];
        assert_eq!((wonder.builders_in, wonder.built), (2, 0.0), "two of three builders: nothing happens");
        assert!(!g.alive(b[0]) && !g.alive(b[1]), "builders are used up at the foundation");
        g.order_build(b[2], w);
        for _ in 0..20 * 10 {
            g.tick();
        }
        assert_eq!(g.ents[w as usize].builders_in, 3);
        assert!(g.ents[w as usize].built > 0.0, "with the third it rises by itself");
    }

    #[test]
    fn crews_are_handed_out_in_id_order() {
        let mut g = Game::new(5, 1, 2);
        // 6 residents: three lumber camps of 2 get crews, a fourth doesn't.
        let camps: Vec<u32> = (0..4).map(|_| build(&mut g, Kind::LumberCamp)).collect();
        g.resolve();
        let crewed: Vec<bool> = camps.iter().map(|&c| g.ents[c as usize].crewed).collect();
        assert_eq!(crewed, [true, true, true, false]);
        assert_eq!(g.players[1].supply[Res::Wood.idx()], 4 + 3 * 4, "the idle camp makes nothing");
    }

    #[test]
    fn demolishing_frees_slots_and_workers() {
        let mut g = Game::new(5, 1, 2);
        let camps: Vec<u32> = (0..4).map(|_| build(&mut g, Kind::LumberCamp)).collect();
        let quarry = build(&mut g, Kind::Quarry);
        let wood = free(&g, Res::Wood);
        g.apply(1, Command::Demolish { ids: vec![camps[0], quarry] }).unwrap();
        g.tick();
        assert!(!g.alive(camps[0]) && !g.alive(quarry));
        assert!(g.ents[camps[3] as usize].crewed, "its workers went to the idle camp");
        assert_eq!(free(&g, Res::Wood), wood + 2, "the quarry's wood is free");
        let cap = g.find_first(1, Kind::Capitol).unwrap() as u32;
        g.apply(1, Command::Demolish { ids: vec![cap] }).unwrap();
        g.tick();
        assert!(g.alive(cap), "the Capitol can't be demolished");
    }

    /// Two Normal computer players play a whole game: someone wins, by
    /// Wonder or conquest, within an hour. Guards against the AI stalling.
    #[test]
    fn normal_ais_play_a_game_to_the_end() {
        for seed in [1234, 7, 42] {
            let mut g = Game::new(seed, 1, 2);
            g.set_ai(1, true);
            let mut ticks = 0;
            while g.state == 0 && ticks < 20 * 60 * 60 {
                g.tick();
                g.events.clear();
                ticks += 1;
            }
            assert_ne!(g.state, 0, "seed {seed}: nobody won in an hour");
            // The AI explored beyond its start, and only built where it had.
            let p = g.winner;
            let seen = g.explored.iter().filter(|&&b| b & (1 << p) != 0).count();
            assert!(seen > g.explored.len() / 4, "seed {seed}: the winner saw only {seen} tiles");
            for e in g.ents.iter().filter(|e| e.alive && e.is_building() && e.owner == p) {
                assert!(g.explored_by(p, e.tx, e.ty), "built on unexplored ground");
            }
        }
    }

    #[test]
    #[ignore]
    fn watch_the_ai() {
        // VC_SEED, VC_MINUTES and VC_EVERY tune the run from the shell.
        let env = |k: &str, d: u32| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
        let (seed, minutes, every) = (env("VC_SEED", 1234), env("VC_MINUTES", 14), env("VC_EVERY", 1));
        let (diff, players) = (env("VC_DIFF", 1), env("VC_PLAYERS", 2) as u8);
        let mut g = Game::new(seed, diff, players);
        g.set_ai(1, true);
        for min in 1..=minutes {
            for _ in 0..20 * 60 {
                g.tick();
            }
            if min % every == 0 || g.state != 0 {
                println!("{min:2} min  P1: {}", census(&g, 1));
                for p in 2..=players {
                    println!("        P{p}: {}", census(&g, p));
                }
            }
            if g.state != 0 {
                println!("winner {} wonder {}", g.winner, g.by_wonder);
                break;
            }
        }
    }
}
