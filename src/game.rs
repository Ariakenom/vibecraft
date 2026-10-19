//! The simulation: entities, orders, movement, economy, combat, fog of war.
//!
//! The whole game advances in fixed steps of `DT` seconds (`Game::tick`).
//! Fixed steps keep the simulation deterministic no matter the frame rate;
//! the browser just calls `tick()` 20 times a second and interpolates drawing.

use crate::ai::Ai;
use crate::defs::*;
use crate::map::{self, Map, Resource};
use crate::path::{Goal, Pathfinder};

pub const DT: f32 = 1.0 / 20.0;
pub const CARRY_MAX: f32 = 10.0;
pub const GAIA: u8 = 0;
pub const PLAYER: u8 = 1;
/// Up to four players. Player 0 is "nature" (gaia).
pub const MAX_PLAYERS: usize = 4;
const CELL: i32 = 4; // spatial-hash cell size in tiles

/// Something a citizen can gather from.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum ResNode {
    Node(usize), // index into `Game::res`
    Farm(u32),   // entity id of a farm
}

/// What a unit is currently trying to do. Enums with data are one of Rust's
/// best features: each variant carries exactly the fields it needs, and
/// `match` forces us to handle every case.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Order {
    Idle,
    Move { x: f32, y: f32 },
    AttackMove { x: f32, y: f32 },
    Attack { target: u32, auto: bool },
    Gather(ResNode),
    Return(ResNode),
    Build(u32),
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
    Work = 8,     // a gathering stroke (data = resource, +4 on a farm)
    Hammer = 9,   // a construction stroke
    DropOff = 10, // resources delivered (data = resource)
    ArrowHit = 11, // an arrow struck (data = 1 if it hit a building)
    Starving = 12, // the player's food ran out
    WonderBegun = 13, // someone laid a Wonder's foundation (data = owner)
    Eliminated = 14, // a player lost their Capitol and is out (data = player)
}

/// Why a command was refused. `code()` is the number JavaScript receives.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum CmdError {
    Short(Res),
    QueueFull,
    NoBuilding,
    BadSpot,
    /// The tech tree says no: this building is needed first.
    Locked(Kind),
}

impl CmdError {
    pub fn code(self) -> i32 {
        match self {
            CmdError::Short(r) => 1 + r.idx() as i32,
            CmdError::QueueFull => 10,
            CmdError::NoBuilding => 11,
            CmdError::BadSpot => 12,
            CmdError::Locked(k) => 100 + k as i32,
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
    pub carry_kind: Res,
    pub carry: f32,
    pub last_node: Option<ResNode>,
    /// Timer for work sounds (chopping, hammering).
    pub sfx: f32,
    // --- buildings ---
    pub tx: i32,
    pub ty: i32,
    pub built: f32,
    pub queue: Vec<Kind>,
    pub progress: f32,
    pub rally: Option<(f32, f32)>,
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
            carry_kind: Res::Food,
            carry: 0.0,
            last_node: None,
            sfx: 0.0,
            tx: 0,
            ty: 0,
            built: 1.0,
            queue: Vec::new(),
            progress: 0.0,
            rally: None,
        }
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
    pub stock: [f32; 4],
    /// Living units (not buildings).
    pub pop: u32,
    /// Food per minute all those units eat.
    pub upkeep: f32,
    /// True while the granary is empty and upkeep can't be paid.
    pub starving: bool,
    /// Lost their Capitol: out of the game.
    pub defeated: bool,
    /// Difficulty handicap/bonus on gathering (the AI's only "cheat").
    pub gather_mult: f32,
    /// What this player's finished buildings give them. Refreshed every second.
    pub bonus: Bonuses,
    /// Resources brought in during each of the last 60 seconds, per resource.
    /// A ring buffer: `Game::slot` says which second is "now".
    pub income: [[f32; 4]; 60],
    pub trained: u32,
    pub lost: u32,
    pub gathered: f32,
}

impl Player {
    /// Average income over the last minute, per resource.
    pub fn income_per_min(&self, r: usize, elapsed: f32) -> f32 {
        let sum: f32 = self.income.iter().map(|sec| sec[r]).sum();
        // Early on we have less than a minute of history: scale it up.
        sum * 60.0 / elapsed.clamp(10.0, 60.0)
    }
}

/// What a right-click means (see `Game::intent`).
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Intent {
    Nothing,
    Rally,
    Attack(u32),
    Gather(ResNode),
    Build(u32),
    DropOff,
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
}

pub enum Pick {
    Ent(u32),
    Res(usize),
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
    pub res: Vec<Resource>,
    pub ents: Vec<Entity>,
    /// Index 0 is unused (gaia); players are 1..=n_players.
    pub players: Vec<Player>,
    pub n_players: u8,
    pub proj: Vec<Projectile>,
    pub time: f32,
    /// Per tile, for the human player: 0 never seen, 1 explored, 2 visible now.
    pub fog: Vec<u8>,
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

    /// Notifications for the UI: groups of 4 floats [type, x, y, data].
    pub events: Vec<f32>,
    /// One computer brain per player slot; `on` says who it plays for.
    pub ais: Vec<Ai>,
    /// Index of the current second in each player's `income` ring buffer.
    pub slot: usize,
    second_timer: f32,
    pf: Pathfinder,
    grid: Vec<Vec<u32>>,
    alert_cooldown: f32,
    idle_cursor: u32,
}

impl Game {
    /// A new game: player 1 is the human, the rest are computer players.
    pub fn new(seed: u32, difficulty: u32, n_players: u8) -> Game {
        let n_players = n_players.clamp(2, MAX_PLAYERS as u8);
        let (map, res, bases) = map::generate(seed, n_players as usize);
        let n = (map.w * map.h) as usize;
        let start = Player { stock: [250.0, 250.0, 100.0, 100.0], pop: 0, upkeep: 0.0, starving: false, defeated: false, gather_mult: 1.0, bonus: Bonuses::default(), income: [[0.0; 4]; 60], trained: 0, lost: 0, gathered: 0.0 };
        let players = vec![start; n_players as usize + 1];
        // Each AI thinks on a slightly different tick, so they don't all spike at once.
        let ais = (0..=n_players).map(|p| Ai::new(difficulty, p > 1, p as f32 * 0.13)).collect();
        let mut g = Game::from_parts(seed, map, res, Vec::new(), players, n_players, Vec::new(), vec![0; n], ais, PLAYER);
        let handicap = match difficulty {
            0 => 0.8,
            1 => 1.0,
            _ => 1.3,
        };
        for p in 2..=n_players as usize {
            g.players[p].gather_mult = handicap;
        }
        for (i, &(bx, by)) in bases.iter().enumerate() {
            let owner = i as u8 + 1;
            g.spawn_building(Kind::Capitol, owner, bx - 1, by - 1, 1.0);
            for k in 0..5 {
                let a = k as f32 * 1.2566 + 0.6;
                g.spawn_unit(Kind::Citizen, owner, bx as f32 + 0.5 + a.cos() * 2.6, by as f32 + 0.5 + a.sin() * 2.6);
            }
        }
        g.recount_pop();
        g.update_fog();
        g
    }

    /// Assemble a game from its stored parts; scratch space (pathfinder
    /// buffers, the spatial grid) is made fresh. Used by `new` and `load`.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_parts(seed: u32, map: Map, res: Vec<Resource>, ents: Vec<Entity>, players: Vec<Player>, n_players: u8, proj: Vec<Projectile>, fog: Vec<u8>, ais: Vec<Ai>, local: u8) -> Game {
        let n = (map.w * map.h) as usize;
        let cells = ((map.w / CELL + 1) * (map.h / CELL + 1)) as usize;
        Game {
            seed,
            map,
            res,
            ents,
            players,
            n_players,
            proj,
            time: 0.0,
            fog,
            fog_timer: 0.0,
            state: 0,
            winner: 0,
            by_wonder: false,
            local,
            events: Vec::new(),
            ais,
            slot: 0,
            second_timer: 1.0,
            pf: Pathfinder::new(n),
            grid: vec![Vec::new(); cells],
            alert_cooldown: 0.0,
            idle_cursor: 0,
        }
    }

    /// The private timers, for `save`/`load`.
    pub(crate) fn save_timers(&self) -> (f32, f32, f32, u32) {
        (self.fog_timer, self.second_timer, self.alert_cooldown, self.idle_cursor)
    }
    pub(crate) fn load_timers(&mut self, (fog, second, alert, idle): (f32, f32, f32, u32)) {
        self.fog_timer = fog;
        self.second_timer = second;
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
            p.gather_mult = 1.0; // no difficulty handicap between people
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

    fn add_income(&mut self, owner: u8, r: usize, amount: f32) {
        let slot = self.slot;
        let p = &mut self.players[owner as usize];
        p.income[slot][r] += amount;
        p.gathered += amount;
    }

    /// Once a second: start a new income slot, refresh building bonuses.
    fn every_second(&mut self) {
        self.slot = (self.slot + 1) % 60;
        for owner in self.player_ids() {
            let bonus = Bonuses::from_buildings(|k| self.has_built(owner, k));
            let p = &mut self.players[owner as usize];
            p.income[self.slot] = [0.0; 4];
            p.bonus = bonus;
        }
    }

    /// Hand a player slot to the computer (or take it back). In multiplayer
    /// this happens when someone leaves: their people carry on without them.
    pub fn set_ai(&mut self, player: u8, on: bool) {
        if let Some(ai) = self.ais.get_mut(player as usize) {
            ai.on = on && player >= 1;
            if on {
                self.players[player as usize].gather_mult = 1.0;
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

    pub fn node_kind(&self, n: ResNode) -> Res {
        match n {
            ResNode::Node(i) => self.res[i].kind,
            ResNode::Farm(_) => Res::Food,
        }
    }

    fn node_valid(&self, n: ResNode) -> bool {
        match n {
            ResNode::Node(i) => self.res[i].alive,
            ResNode::Farm(id) => self.alive(id) && self.ents[id as usize].built >= 1.0,
        }
    }

    pub fn nearest_node(&self, kind: Res, x: f32, y: f32, max_d: f32) -> Option<usize> {
        let mut best = None;
        let mut bd = max_d * max_d;
        for (i, r) in self.res.iter().enumerate() {
            if !r.alive || r.kind != kind {
                continue;
            }
            let (cx, cy) = r.center();
            let d = (cx - x).powi(2) + (cy - y).powi(2);
            if d < bd {
                bd = d;
                best = Some(i);
            }
        }
        best
    }

    fn nearest_drop_site(&self, owner: u8, x: f32, y: f32) -> Option<usize> {
        let mut best = None;
        let mut bd = f32::MAX;
        for (i, e) in self.ents.iter().enumerate() {
            if e.alive && e.owner == owner && e.kind.is_drop_site() && e.built >= 1.0 {
                let d = e.edge_dist(x, y);
                if d < bd {
                    bd = d;
                    best = Some(i);
                }
            }
        }
        best
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
        self.eat();
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
        }
        self.second_timer -= DT;
        if self.second_timer <= 0.0 {
            self.second_timer += 1.0;
            self.every_second();
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
            p.upkeep = 0.0;
        }
        for e in self.ents.iter().filter(|e| e.alive && !e.is_building()) {
            let p = &mut self.players[e.owner as usize];
            p.pop += 1;
            p.upkeep += e.kind.stats().upkeep;
        }
    }

    /// Every unit eats a little food every tick. With an empty granary,
    /// everyone slowly loses health until food comes in again.
    fn eat(&mut self) {
        for owner in self.player_ids() {
            let gold = self.players[owner as usize].bonus.gold_per_min / 60.0 * DT;
            if gold > 0.0 {
                self.players[owner as usize].stock[Res::Gold.idx()] += gold;
                self.add_income(owner, Res::Gold.idx(), gold);
            }
        }
        let regen: Vec<f32> = self.players.iter().map(|p| p.bonus.regen).collect();
        for e in self.ents.iter_mut().filter(|e| e.alive && !e.is_building()) {
            let max = e.kind.stats().hp;
            e.hp = (e.hp + max * regen[e.owner as usize] * DT).min(max);
        }
        for owner in self.player_ids() {
            let p = &mut self.players[owner as usize];
            let food = &mut p.stock[Res::Food.idx()];
            *food -= p.upkeep / 60.0 * DT;
            let was = p.starving;
            p.starving = *food < 0.0;
            if p.starving {
                *food = 0.0;
            }
            if p.starving && !was && owner == self.local {
                self.push_event(Ev::Starving, 0.0, 0.0, 0.0);
            }
        }
        // A separate pass: we can't hold `p` (a borrow of `self.players`)
        // while also mutating `self.ents`. Copy the flags out first.
        let starving: Vec<bool> = self.players.iter().map(|p| p.starving).collect();
        if starving.iter().any(|&s| s) {
            for e in self.ents.iter_mut().filter(|e| e.alive && !e.is_building()) {
                if starving[e.owner as usize] {
                    e.hp -= e.kind.stats().hp * 0.015 * DT;
                }
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
            return;
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

    /// Spend resources, or explain which one is missing.
    pub fn pay(&mut self, owner: u8, cost: [u32; 4]) -> Result<(), CmdError> {
        let stock = &mut self.players[owner as usize].stock;
        for r in 0..4 {
            if stock[r] < cost[r] as f32 {
                return Err(CmdError::Short(Res::from_idx(r)));
            }
        }
        for r in 0..4 {
            stock[r] -= cost[r] as f32;
        }
        Ok(())
    }

    fn refund(&mut self, owner: u8, cost: [u32; 4]) {
        for r in 0..4 {
            self.players[owner as usize].stock[r] += cost[r] as f32;
        }
    }

    pub fn queue_unit(&mut self, building: u32, kind: Kind) -> Result<(), CmdError> {
        let b = &self.ents[building as usize];
        if !b.alive || b.built < 1.0 || !b.kind.trains().contains(&kind) {
            return Err(CmdError::NoBuilding);
        }
        if b.queue.len() >= 5 {
            return Err(CmdError::QueueFull);
        }
        let owner = b.owner;
        self.pay(owner, kind.stats().cost)?; // `?` returns the error early if paying failed
        self.ents[building as usize].queue.push(kind);
        Ok(())
    }

    pub fn cancel_unit(&mut self, building: u32) {
        let Some(b) = self.ents.get_mut(building as usize) else { return };
        if let Some(k) = b.queue.pop() {
            if b.queue.is_empty() {
                b.progress = 0.0;
            }
            let owner = b.owner;
            self.refund(owner, k.stats().cost);
        }
    }

    pub fn can_place(&self, kind: Kind, tx: i32, ty: i32, owner: u8, margin: i32) -> bool {
        let s = kind.stats().size;
        for y in ty - margin..ty + s + margin {
            for x in tx - margin..tx + s + margin {
                if !self.map.inside(x, y) {
                    return false;
                }
                let i = self.map.idx(x, y);
                if self.map.terrain[i] == map::WATER || self.map.bld_at[i] >= 0 || self.map.res_at[i] >= 0 {
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
        if !kind.is_building() || kind == Kind::Capitol || !self.can_place(kind, tx, ty, owner, 0) {
            return Err(CmdError::BadSpot);
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

    fn is_citizen(&self, id: u32) -> bool {
        self.alive(id) && self.ents[id as usize].kind == Kind::Citizen
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

    pub fn order_gather(&mut self, id: u32, node: ResNode) {
        if !self.is_citizen(id) {
            return;
        }
        let e = &mut self.ents[id as usize];
        e.set_order(Order::Gather(node));
        e.last_node = Some(node);
        e.resume = None;
    }

    pub fn order_build(&mut self, id: u32, target: u32) {
        if !self.is_citizen(id) {
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
        let r = self.map.res_at[i];
        if r >= 0 {
            return Pick::Res(r as usize);
        }
        Pick::Nothing
    }

    /// What a right-click at (x, y) would mean for these units. Used twice:
    /// by the mouse cursor (to show an axe, a sword...) and by `smart_order`
    /// to actually do it, so the cursor never lies.
    pub fn intent(&self, ids: &[u32], x: f32, y: f32, owner: u8, fog: bool) -> Intent {
        let mine = || ids.iter().copied().filter(|&id| self.alive(id) && self.ents[id as usize].owner == owner);
        let any_units = mine().any(|id| !self.ents[id as usize].is_building());
        if !any_units {
            let can_rally = mine().any(|id| !self.ents[id as usize].kind.trains().is_empty());
            return if can_rally { Intent::Rally } else { Intent::Nothing };
        }
        let any_citizen = mine().any(|id| self.is_citizen(id));
        match self.pick(x, y, fog) {
            Pick::Ent(t) if Self::hostile(owner, self.ents[t as usize].owner) => Intent::Attack(t),
            Pick::Res(r) if any_citizen => Intent::Gather(ResNode::Node(r)),
            Pick::Ent(t) if any_citizen && self.ents[t as usize].owner == owner && self.ents[t as usize].is_building() => {
                let b = &self.ents[t as usize];
                if b.built < 1.0 {
                    Intent::Build(t)
                } else if b.kind == Kind::Farm {
                    Intent::Gather(ResNode::Farm(t))
                } else if b.kind.is_drop_site() && mine().any(|id| self.ents[id as usize].carry > 0.0) {
                    Intent::DropOff
                } else {
                    Intent::Move
                }
            }
            _ => Intent::Move,
        }
    }

    /// The right-click: work out what the player meant, then order each unit.
    /// Soldiers can't gather or build, so they just walk there.
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
            Intent::Gather(node) => {
                for &u in &units {
                    if self.is_citizen(u) {
                        self.order_gather(u, node);
                    } else {
                        self.order_move(u, x, y);
                    }
                }
            }
            Intent::Build(t) => {
                for &u in &units {
                    if self.is_citizen(u) {
                        self.order_build(u, t);
                    } else {
                        self.order_move(u, x, y);
                    }
                }
            }
            Intent::DropOff => {
                for &u in &units {
                    let e = &self.ents[u as usize];
                    if e.carry > 0.0 {
                        let back = e.last_node.unwrap_or(ResNode::Farm(u32::MAX));
                        self.ents[u as usize].set_order(Order::Return(back));
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
                let builders: Vec<u32> = own(self, &ids).into_iter().filter(|&id| self.ents[id as usize].kind == Kind::Citizen).collect();
                self.place(owner, kind, tx, ty, &builders)?;
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
        }
        if let Some(p) = self.players.get(owner as usize) {
            for v in p.stock {
                mix(v.to_bits());
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
        }
        for p in &self.players[1..] {
            for v in p.stock {
                mix(v.to_bits());
            }
        }
        for r in self.res.iter().filter(|r| r.alive) {
            mix(r.amount.to_bits());
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
            Order::Gather(node) => self.do_gather(i, node),
            Order::Return(node) => self.do_return(i, node),
            Order::Build(target) => self.do_build(i, target),
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
        let mut dmg = st.attack * damage_mult(a.kind, self.ents[target as usize].kind);
        if a.kind.is_military() {
            dmg *= self.players[a.owner as usize].bonus.attack;
        }
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
            let (owner, kind, tx, ty, x, y) = (e.owner, e.kind, e.tx, e.ty, e.x, e.y);
            let e = &mut self.ents[i];
            e.alive = false;
            e.selected = false;
            self.players[owner as usize].lost += 1;
            if kind.is_building() {
                let s = kind.stats().size;
                for yy in ty..ty + s {
                    for xx in tx..tx + s {
                        let j = self.map.idx(xx, yy);
                        self.map.bld_at[j] = -1;
                        self.map.blocked[j] = false;
                    }
                }
                if owner == self.local {
                    self.push_event(Ev::Lost, x, y, kind as u32 as f32);
                }
            }
            self.push_event(Ev::Death, x, y, owner as f32 * 100.0 + kind as u32 as f32);
        }
    }

    // --- economy ---

    /// Is someone other than `me` already working this farm? When two
    /// citizens want the same farm, the one with the lower id keeps it.
    fn farm_taken(&self, farm: u32, me: u32) -> bool {
        self.ents.iter().any(|e| {
            e.alive && e.id < me && matches!(e.order, Order::Gather(ResNode::Farm(f)) | Order::Return(ResNode::Farm(f)) if f == farm)
        })
    }

    /// A finished farm of `owner`'s that nobody is working.
    pub fn free_farm(&self, owner: u8) -> Option<u32> {
        self.ents
            .iter()
            .filter(|f| f.alive && f.owner == owner && f.kind == Kind::Farm && f.built >= 1.0)
            .find(|f| !self.ents.iter().any(|e| e.alive && matches!(e.order, Order::Gather(ResNode::Farm(id)) | Order::Return(ResNode::Farm(id)) if id == f.id)))
            .map(|f| f.id)
    }

    fn do_gather(&mut self, i: usize, node: ResNode) {
        // One farmer per farm. Extras move to a free farm, or stand idle.
        if let ResNode::Farm(f) = node {
            if self.farm_taken(f, i as u32) {
                let owner = self.ents[i].owner;
                match self.free_farm(owner) {
                    Some(other) => self.order_gather(i as u32, ResNode::Farm(other)),
                    None => self.ents[i].set_order(Order::Idle),
                }
                return;
            }
        }
        let node = if self.node_valid(node) {
            node
        } else {
            // Tree cut down? Look for another of the same kind nearby.
            let kind = self.node_kind(node);
            let (x, y) = (self.ents[i].x, self.ents[i].y);
            match (node, self.nearest_node(kind, x, y, 10.0)) {
                (ResNode::Node(_), Some(n)) => {
                    let n = ResNode::Node(n);
                    self.ents[i].set_order(Order::Gather(n));
                    self.ents[i].last_node = Some(n);
                    n
                }
                _ => {
                    if self.ents[i].carry > 0.0 {
                        self.ents[i].set_order(Order::Return(node));
                    } else {
                        self.ents[i].set_order(Order::Idle);
                    }
                    return;
                }
            }
        };
        let kind = self.node_kind(node);
        let e = &self.ents[i];
        if e.carry >= CARRY_MAX || (e.carry > 0.0 && e.carry_kind != kind) && e.carry >= 5.0 {
            self.ents[i].set_order(Order::Return(node));
            return;
        }
        let goal = match node {
            ResNode::Node(r) => {
                let res = &self.res[r];
                Goal::rect(res.tx, res.ty, 1, 0.75)
            }
            ResNode::Farm(id) => {
                let f = &self.ents[id as usize];
                Goal::rect(f.tx, f.ty, 3, 0.0)
            }
        };
        match self.travel(i, goal, 3.0) {
            Travel::Moving => {}
            Travel::Blocked => self.ents[i].set_order(Order::Idle),
            Travel::Arrived => {
                let owner = self.ents[i].owner as usize;
                let p = &self.players[owner];
                let mut rate = kind.gather_rate() * p.gather_mult * p.bonus.gather[kind.idx()] * DT;
                if let ResNode::Farm(_) = node {
                    rate *= 0.8;
                }
                if let ResNode::Node(r) = node {
                    let res = &mut self.res[r];
                    rate = rate.min(res.amount);
                    res.amount -= rate;
                    if res.amount <= 0.0 {
                        res.alive = false;
                        let j = self.map.idx(res.tx, res.ty);
                        self.map.blocked[j] = false;
                        self.map.res_at[j] = -1;
                    }
                }
                let e = &mut self.ents[i];
                if e.carry_kind != kind {
                    e.carry = 0.0;
                    e.carry_kind = kind;
                }
                e.carry += rate;
                e.anim = Anim::Work;
                let (gx, gy) = match node {
                    ResNode::Node(r) => self.res[r].center(),
                    ResNode::Farm(_) => (e.x, e.y + 0.3),
                };
                e.facing = (gy - e.y).atan2(gx - e.x);
                let (x, y) = (e.x, e.y);
                if self.work_stroke(i) {
                    let farm = if let ResNode::Farm(_) = node { 4.0 } else { 0.0 };
                    self.push_event(Ev::Work, x, y, kind.idx() as f32 + farm);
                }
            }
        }
    }

    fn do_return(&mut self, i: usize, node: ResNode) {
        let (x, y, owner) = (self.ents[i].x, self.ents[i].y, self.ents[i].owner);
        let Some(site) = self.nearest_drop_site(owner, x, y) else {
            self.ents[i].set_order(Order::Idle);
            return;
        };
        let goal = self.ents[site].goal(0.7);
        match self.travel(i, goal, 3.0) {
            Travel::Moving => {}
            Travel::Blocked => self.ents[i].set_order(Order::Idle),
            Travel::Arrived => {
                let e = &mut self.ents[i];
                let (k, amt) = (e.carry_kind, e.carry);
                e.carry = 0.0;
                let p = &mut self.players[owner as usize];
                p.stock[k.idx()] += amt;
                self.add_income(owner, k.idx(), amt);
                self.push_event(Ev::DropOff, x, y, k.idx() as f32);
                if self.node_valid(node) || matches!(node, ResNode::Node(_)) {
                    self.ents[i].set_order(Order::Gather(node));
                } else {
                    self.ents[i].set_order(Order::Idle);
                }
            }
        }
    }

    fn do_build(&mut self, i: usize, target: u32) {
        if !self.alive(target) {
            self.ents[i].set_order(Order::Idle);
            return;
        }
        if self.ents[target as usize].built >= 1.0 {
            return self.after_build(i, target);
        }
        let goal = self.ents[target as usize].goal(0.75);
        match self.travel(i, goal, 3.0) {
            Travel::Moving => {}
            Travel::Blocked => self.ents[i].set_order(Order::Idle),
            Travel::Arrived => {
                let b = &mut self.ents[target as usize];
                let st = b.kind.stats();
                b.built += DT / st.time;
                b.hp = (b.hp + st.hp * 0.9 * DT / st.time).min(st.hp);
                let (bx, by) = (b.x, b.y);
                if b.built >= 1.0 {
                    b.built = 1.0;
                    let (owner, kind) = (b.owner, b.kind);
                    if owner == self.local {
                        self.push_event(Ev::Built, bx, by, kind as u32 as f32);
                    }
                }
                let e = &mut self.ents[i];
                e.anim = Anim::Work;
                e.facing = (by - e.y).atan2(bx - e.x);
                if self.work_stroke(i) {
                    self.push_event(Ev::Hammer, bx, by, 0.0);
                }
            }
        }
    }

    /// A builder finished: farm it, or help with another building nearby, or go back to work.
    fn after_build(&mut self, i: usize, target: u32) {
        // The first builder farms it; the rest move on to the next job.
        if self.ents[target as usize].kind == Kind::Farm && !self.farm_taken(target, i as u32) {
            return self.order_gather(i as u32, ResNode::Farm(target));
        }
        let (x, y, owner) = (self.ents[i].x, self.ents[i].y, self.ents[i].owner);
        let other = self.ents.iter().find(|b| b.alive && b.owner == owner && b.is_building() && b.built < 1.0 && b.edge_dist(x, y) < 10.0).map(|b| b.id);
        match (other, self.ents[i].last_node) {
            (Some(b), _) => self.order_build(i as u32, b),
            (None, Some(n)) if self.node_valid(n) => self.order_gather(i as u32, n),
            _ => self.ents[i].set_order(Order::Idle),
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

    fn update_fog(&mut self) {
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

    pub fn select_idle_citizen(&mut self) -> i32 {
        let n = self.ents.len() as u32;
        for k in 1..=n {
            let id = (self.idle_cursor + k) % n;
            let e = &self.ents[id as usize];
            if e.alive && e.owner == self.local && e.kind == Kind::Citizen && e.order == Order::Idle {
                self.idle_cursor = id;
                self.clear_selection();
                self.ents[id as usize].selected = true;
                return id as i32;
            }
        }
        -1
    }

}
