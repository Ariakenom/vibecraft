//! Tests of the simulation's rules: slots, people, houses, the AI.
//! (Saves have their own tests in save.rs.)

use crate::defs::*;
use crate::game::*;


/// A game with the start these tests were written for: two huts and eight
/// workers each (a real game starts with nobody and no houses).
pub fn town(seed: u32, difficulty: u32, players: u8) -> Game {
    let mut g = Game::new(seed, difficulty, players);
    for p in 1..=g.n_players {
        let c = g.find_first(p, Kind::Capitol).unwrap();
        let (bx, by) = (g.ents[c].tx + 1, g.ents[c].ty + 1);
        for (hx, hy) in [(bx - 4, by + 1), (bx + 2, by - 4)] {
            g.spawn_building(Kind::Hut, p, hx, hy, 1.0);
        }
        for _ in 0..8 {
            g.spawn_worker(p, None);
        }
        // A settled town: no newcomer in the first seconds (the 2 s welcome
        // is for a game's very start).
        g.players[p as usize].arrive_timer = growth_interval(0);
    }
    g.resolve();
    g
}

/// How many slots of `r` a `k` makes.
pub fn makes(k: Kind, r: Res) -> u16 {
    k.stats().produces.iter().find(|&&(q, _)| q == r).map_or(0, |&(_, n)| n)
}

/// What a player has, for printing: kind name → count, people, slots.
pub fn census(g: &Game, p: u8) -> String {
    let mut out = String::new();
    for k in Kind::ALL {
        let n = g.ents.iter().filter(|e| e.alive && e.owner == p && e.kind == k).count();
        if n > 0 {
            out += &format!("{k:?} {n}, ");
        }
    }
    let pl = &g.players[p as usize];
    out += &format!("| people {}/{} beds: {} free, {} working, {} soldiers | ", pl.people, pl.beds, pl.free, pl.working, pl.soldiers);
    out += &format!("era {} | ", pl.era);
    if std::env::var("VC_HOUSES").is_ok() {
        for h in g.houses_by_distance(p) {
            let e = &g.ents[h];
            out += &format!("{}{}/{}g{} ", if e.kind == Kind::Hut { "h" } else { "c" }, e.residents, e.beds(), e.goods.count_ones());
        }
        out += &format!("| spare {:?} | ", Res::ALL.iter().take(7).map(|&r| pl.spare(r)).collect::<Vec<_>>());
        for e in g.ents.iter().filter(|e| e.alive && e.owner == p && e.is_building() && e.built < 1.0) {
            out += &format!("[unfinished {:?} at {},{} builders {} built {:.2}] ", e.kind, e.tx, e.ty, e.builders_in, e.built);
        }
    }
    for r in Res::ALL.iter().filter(|r| pl.used[r.idx()] > 0 || pl.supply[r.idx()] > 0) {
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

/// A finished building of player 1's, put straight on the map, with its
/// crew standing at it (new workers, not ones from the campfire).
fn build(g: &mut Game, kind: Kind) -> u32 {
    let (x, y) = spot(g, kind);
    let id = g.spawn_building(kind, 1, x, y, 1.0);
    for _ in 0..kind.stats().workers {
        let w = g.spawn_unit(Kind::Worker, 1, x as f32 - 0.3, y as f32 - 0.3);
        g.ents[w as usize].order = Order::Work(id);
    }
    g.resolve();
    id
}

fn free(g: &Game, r: Res) -> i32 {
    g.players[1].free(r)
}

fn run(g: &mut Game, seconds: f32) {
    for _ in 0..(seconds * 20.0) as u32 {
        g.tick();
        g.events.clear();
    }
}

/// Take every free worker away, so tests can control who goes where.
fn empty_campfire(g: &mut Game) {
    for i in 0..g.ents.len() {
        if g.ents[i].owner == 1 && g.is_free_worker(&g.ents[i]) {
            g.ents[i].alive = false;
        }
    }
    g.resolve();
}

#[test]
fn a_new_game_starts_with_free_workers_and_nobody_short() {
    for players in 2..=4 {
        let mut g = Game::new(9, 1, players);
        g.tick();
        for p in 1..=players {
            let pl = &g.players[p as usize];
            assert!(Res::ALL.iter().all(|&r| pl.free(r) >= 0), "player {p} starts short");
            assert_eq!((pl.people, pl.beds), (0, CAPITOL_BEDS), "player {p}: nobody yet, the Capitol's beds");
            assert!(!g.ents.iter().any(|e| e.alive && e.owner == p && e.kind.house_tier().is_some()), "no houses");
        }
        // Newcomers fill the Capitol's beds in the first minute.
        let mut g = Game::new(9, 1, players);
        for p in 1..=players {
            g.set_ai(p, false);
        }
        run(&mut g, 60.0);
        assert_eq!(g.players[1].people, CAPITOL_BEDS, "four newcomers");
    }
}

#[test]
fn slots_come_free_the_tick_after_a_unit_dies() {
    let mut g = town(5, 1, 2);
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
    let mut g = town(5, 1, 2);
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
    let mut g = town(5, 1, 2);
    // A quarry right beside the Capitol is nowhere near stone.
    let cap = &g.ents[g.find_first(1, Kind::Capitol).unwrap()];
    let (x, y) = (cap.tx - 3, cap.ty - 3);
    assert!(!g.near_deposit(Kind::Quarry, x, y));
    let r = g.apply(1, Command::Place { ids: vec![], kind: Kind::Quarry, tx: x, ty: y });
    assert_eq!(r.err(), Some(CmdError::NoDeposit(Dep::Stone)));
    // Next to stone it works, and with its crew it makes stone.
    let stone = g.players[1].supply[Res::Stone.idx()];
    build(&mut g, Kind::Quarry);
    assert_eq!(g.players[1].supply[Res::Stone.idx()], stone + makes(Kind::Quarry, Res::Stone));
}

#[test]
fn a_lost_producer_leaves_the_newest_units_unsupplied() {
    let mut g = town(5, 1, 2);
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
    run(&mut g, 1.0);
    assert!(!g.ents[older as usize].unsupplied && !g.ents[newer as usize].unsupplied);
    assert!(g.ents[newest as usize].unsupplied);
    let lost = hp - g.ents[newest as usize].hp;
    let expect = Kind::Horseman.stats().hp * UNSUPPLIED_DAMAGE; // one second's worth
    assert!((lost - expect).abs() < 0.01, "lost {lost}, expected {expect}");
    assert_eq!(g.ents[older as usize].hp, older_hp, "supplied units don't lose health");
}

#[test]
fn saves_keep_slots_in_step() {
    let mut a = town(77, 2, 2);
    a.set_ai(1, true);
    let start = a.ents.len();
    run(&mut a, 100.0);
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
    let mut g = town(5, 1, 2);
    // Grain and fruit (the Capitol's, a farm's and an orchard's): both huts
    // get 2 goods, 4 beds each.
    build(&mut g, Kind::Farm);
    build(&mut g, Kind::Orchard);
    g.resolve();
    for h in houses(&g, 1) {
        assert_eq!((g.ents[h].goods.count_ones(), g.ents[h].beds()), (2, 4));
    }
    // Meat from a hunting lodge makes it 3 goods: 6 beds.
    build(&mut g, Kind::HuntingLodge);
    g.resolve();
    for h in houses(&g, 1) {
        assert_eq!((g.ents[h].goods.count_ones(), g.ents[h].beds()), (3, 6));
    }
    // A hut uses at most 3 goods, however many there are; a full hut
    // with 3 goods has become a cottage, which uses all 4.
    build(&mut g, Kind::FishingHut);
    g.resolve();
    for h in houses(&g, 1) {
        let e = &g.ents[h];
        assert_eq!(e.beds(), if e.kind == Kind::Hut { 6 } else { 8 }, "{:?}", e.kind);
    }
}

#[test]
fn losing_a_farm_empties_the_furthest_houses_first() {
    let mut g = town(5, 1, 2);
    build(&mut g, Kind::LumberCamp); // wood for the huts
    let farm = build(&mut g, Kind::Farm); // grain 1 + 2 = 3
    build(&mut g, Kind::Hut);
    g.resolve();
    let hs = houses(&g, 1);
    assert_eq!(hs.len(), 3);
    let grain = 1 << Res::Grain.idx();
    assert!(hs.iter().all(|&h| g.ents[h].goods & grain != 0), "3 grain for 3 huts");
    g.ents[farm as usize].hp = 0.0;
    g.tick();
    g.tick();
    let has: Vec<bool> = hs.iter().map(|&h| g.ents[h].goods & grain != 0).collect();
    assert_eq!(has, [true, false, false], "the nearest keeps its grain");
}

#[test]
fn a_free_worker_walks_over_and_becomes_the_soldier() {
    let mut g = town(5, 1, 2);
    build(&mut g, Kind::LumberCamp);
    let barracks = build(&mut g, Kind::Barracks);
    g.tick();
    let (people, free_before) = (g.players[1].people, g.players[1].free);
    g.apply(1, Command::Train { ids: vec![barracks], kind: Kind::Spearman }).unwrap();
    g.tick();
    g.tick();
    let walking = g.ents.iter().filter(|e| e.alive && e.order == Order::Enlist(barracks)).count();
    assert_eq!(walking, 1, "one free worker sets off for the barracks");
    assert_eq!(g.players[1].free, free_before - 1);
    run(&mut g, 40.0);
    let soldiers = g.ents.iter().filter(|e| e.alive && e.owner == 1 && e.kind == Kind::Spearman).count();
    assert_eq!(soldiers, 1, "and comes out a spearman");
    assert_eq!(g.players[1].people, people, "the same number of people: a worker became a soldier");
    // With nobody free at the campfire, training is refused.
    empty_campfire(&mut g);
    let r = g.apply(1, Command::Train { ids: vec![barracks], kind: Kind::Spearman });
    assert_eq!(r.err(), Some(CmdError::NoPeople));
}

#[test]
fn a_foundation_waits_for_all_its_builders() {
    let mut g = town(5, 1, 2);
    // Plenty of everything, so the airfield's slots don't empty the houses.
    g.players[1].supply_pct = 400;
    empty_campfire(&mut g);
    assert_eq!(Kind::Airfield.stats().builders, 3);
    let (x, y) = spot(&g, Kind::Airfield);
    let w = g.spawn_building(Kind::Airfield, 1, x, y, 0.0);
    // Workers away from the campfire aren't free: nobody sends them.
    let far = |k: u32| (x as f32 + 1.0 + k as f32, y as f32 + 5.5);
    let b: Vec<u32> = (0..3).map(|k| g.spawn_unit(Kind::Worker, 1, far(k).0, far(k).1)).collect();
    g.order_build(b[0], w);
    g.order_build(b[1], w);
    run(&mut g, 10.0);
    let field = &g.ents[w as usize];
    assert_eq!((field.builders_in, field.built), (2, 0.0), "two of three builders: nothing happens");
    assert!(g.alive(b[0]) && g.alive(b[1]), "builders aren't used up: they stay and build");
    g.order_build(b[2], w);
    run(&mut g, 10.0);
    assert!(g.ents[w as usize].builders_in >= 3);
    assert!(g.ents[w as usize].built > 0.0, "with the third it rises");
    run(&mut g, Kind::Airfield.stats().time + 5.0);
    assert!(g.ents[w as usize].built >= 1.0);
    // Done: builders become its crew, as many as it needs; the rest go home.
    let crew = g.ents.iter().filter(|e| e.alive && e.order == Order::Work(w)).count();
    assert_eq!(crew, Kind::Airfield.stats().workers as usize, "builders went to work there");
    assert!(g.ents.iter().all(|e| !e.alive || e.order != Order::Build(w)), "nobody is still building");
    assert!(b.iter().all(|&id| g.alive(id)));
}

#[test]
fn free_workers_go_to_work_by_themselves() {
    let mut g = town(5, 1, 2);
    // 8 free workers, eight lumber camps of 1 placed without crews: they all
    // fill, in id order. A ninth gets nobody.
    let camps: Vec<u32> = (0..9)
        .map(|_| {
            let (x, y) = spot(&g, Kind::LumberCamp);
            let id = g.spawn_building(Kind::LumberCamp, 1, x, y, 1.0);
            g.resolve();
            id
        })
        .collect();
    run(&mut g, 30.0);
    let crewed: Vec<bool> = camps.iter().map(|&c| g.ents[c as usize].crewed).collect();
    assert_eq!(crewed, [true, true, true, true, true, true, true, true, false]);
    assert_eq!(g.players[1].supply[Res::Wood.idx()], makes(Kind::Capitol, Res::Wood) + 8 * makes(Kind::LumberCamp, Res::Wood), "the camp with nobody makes nothing");
    assert_eq!(g.players[1].free, 0);
}

#[test]
fn moving_workers_away_pauses_a_producer() {
    let mut g = town(5, 1, 2);
    let (x, y) = spot(&g, Kind::LumberCamp);
    let camp = g.spawn_building(Kind::LumberCamp, 1, x, y, 1.0);
    run(&mut g, 30.0);
    assert!(g.ents[camp as usize].crewed);
    let crew: Vec<u32> = g.ents.iter().filter(|e| e.alive && e.order == Order::Work(camp)).map(|e| e.id).collect();
    assert_eq!(crew.len(), 1, "a lumber camp takes one worker");
    let wood = g.players[1].supply[Res::Wood.idx()];
    // Send one of them off: the camp stops, and doesn't hire anyone else.
    g.apply(1, Command::Smart { ids: vec![crew[0]], x: 20.0, y: 20.0 }).unwrap();
    run(&mut g, 20.0);
    assert!(!g.ents[camp as usize].hiring && !g.ents[camp as usize].crewed);
    assert_eq!(g.players[1].supply[Res::Wood.idx()], wood - makes(Kind::LumberCamp, Res::Wood));
    // Sending a worker back starts it hiring again: it fills up.
    g.apply(1, Command::Smart { ids: vec![crew[0]], x: g.ents[camp as usize].x, y: g.ents[camp as usize].y }).unwrap();
    run(&mut g, 30.0);
    assert!(g.ents[camp as usize].hiring && g.ents[camp as usize].crewed);
}

#[test]
fn a_killed_worker_stops_the_producer_until_someone_replaces_them() {
    let mut g = town(5, 1, 2);
    let (x, y) = spot(&g, Kind::LumberCamp);
    let camp = g.spawn_building(Kind::LumberCamp, 1, x, y, 1.0);
    run(&mut g, 30.0);
    let w = g.ents.iter().find(|e| e.alive && e.order == Order::Work(camp)).unwrap().id;
    g.ents[w as usize].hp = 0.0;
    g.tick();
    g.tick();
    assert!(!g.ents[camp as usize].crewed, "one worker short: no wood");
    run(&mut g, 30.0);
    assert!(g.ents[camp as usize].crewed && g.ents[camp as usize].hiring, "a free worker took their place");
}

#[test]
fn newcomers_fill_free_beds_faster_in_a_bigger_town() {
    assert!(growth_interval(80) < growth_interval(40) && growth_interval(40) < growth_interval(8));
    let mut g = town(5, 1, 2);
    build(&mut g, Kind::HuntingLodge); // a third good: 12 beds
    build(&mut g, Kind::LumberCamp);
    build(&mut g, Kind::LumberCamp);
    g.tick();
    let p = g.players[1];
    assert_eq!((p.people, p.beds), (11, 12));
    run(&mut g, growth_interval(12) * 2.0 + 0.2);
    assert_eq!(g.players[1].people, 12, "one newcomer came, and no more: every bed is taken");
    let newest = g.ents.iter().rev().find(|e| e.alive && e.kind == Kind::Worker).unwrap();
    assert!(g.is_free_worker(newest), "they turn up at the campfire");
}

#[test]
fn when_beds_run_short_free_workers_leave_first() {
    let mut g = town(5, 1, 2);
    let lodge = build(&mut g, Kind::HuntingLodge); // 12 beds
    let camp = build(&mut g, Kind::LumberCamp);
    run(&mut g, 20.0);
    let soldiers: Vec<u32> = (0..3).map(|k| g.spawn_unit(Kind::Spearman, 1, 28.0 + k as f32, 28.0)).collect();
    g.tick();
    // The lodge burns: back to 8 beds for 15 people. The free go first.
    g.ents[lodge as usize].hp = 0.0;
    g.tick();
    g.tick();
    let p = g.players[1];
    assert!(p.people <= p.beds, "{} people, {} beds", p.people, p.beds);
    assert!(soldiers.iter().all(|&s| g.alive(s)), "soldiers keep their beds");
    assert!(g.ents[camp as usize].crewed, "workers at work stay while the free ones can go");
}

#[test]
fn demolishing_frees_slots_and_sends_workers_home() {
    let mut g = town(5, 1, 2);
    let quarry = build(&mut g, Kind::Quarry);
    let crew: Vec<u32> = g.ents.iter().filter(|e| e.alive && e.order == Order::Work(quarry)).map(|e| e.id).collect();
    let wood = free(&g, Res::Wood);
    g.apply(1, Command::Demolish { ids: vec![quarry] }).unwrap();
    run(&mut g, 15.0);
    assert!(!g.alive(quarry));
    assert_eq!(free(&g, Res::Wood), wood + 2, "the quarry's wood is free");
    assert!(crew.iter().all(|&w| g.is_free_worker(&g.ents[w as usize])), "its workers walked back to the campfire");
    let cap = g.find_first(1, Kind::Capitol).unwrap() as u32;
    g.apply(1, Command::Demolish { ids: vec![cap] }).unwrap();
    g.tick();
    assert!(g.alive(cap), "the Capitol can't be demolished");
}

#[test]
fn nothing_is_built_on_the_campfire() {
    let g = town(5, 1, 2);
    let (cx, cy) = g.campfire(1).unwrap();
    assert!(!g.can_place(Kind::Hut, cx as i32 - 1, cy as i32 - 1, 1, 0));
}

/// Two Normal computer players grow their towns into the Medieval era
/// within 45 minutes: guards against the AI stalling. (They no longer
/// finish each other off within the hour: two equal AIs raid each other
/// for a long time. See the plan's open questions.)
///
/// Single seeds are chaotic (any change to where people stand shifts which
/// AI ends up at the Ancient era's ceiling, with 7 of every food kind in
/// use), and about one AI in six stays Ancient until the era pacing pass, so
/// five of the six must reach Medieval. `ai_stats` judges changes properly.
#[test]
fn normal_ais_reach_the_medieval_era() {
    let mut medieval = 0;
    for seed in [1, 2, 3] {
        let mut g = Game::new(seed, 1, 2);
        g.set_ai(1, true);
        run(&mut g, 45.0 * 60.0);
        for p in 1..=2u8 {
            medieval += (g.players[p as usize].era >= 1) as u32;
            assert!(g.players[p as usize].people >= 40, "seed {seed}: P{p} stayed small: {}", census(&g, p));
            // It explored beyond its start, and only built where it had.
            let seen = g.explored.iter().filter(|&&b| b & (1 << p) != 0).count();
            assert!(seen > g.explored.len() / 4, "seed {seed}: P{p} saw only {seen} tiles");
            for e in g.ents.iter().filter(|e| e.alive && e.is_building() && e.owner == p) {
                assert!(g.explored_by(p, e.tx, e.ty), "built on unexplored ground");
            }
        }
    }
    assert!(medieval >= 5, "only {medieval} of 6 computer players reached the Medieval era in 45 minutes");
}

/// The Medieval chain (Brickworks, Sawmill) was where the computer players
/// used to freeze: they never explored their own clay, and cottages held every
/// spare stone so a Sawmill (2 stone) never found any. After twenty minutes
/// most of them must have both.
#[test]
fn ais_get_brickworks_and_sawmills() {
    let (mut both, mut n) = (0, 0);
    for seed in [3, 5, 11] {
        let mut g = Game::new(seed, 1, 2);
        g.set_ai(1, true);
        run(&mut g, 20.0 * 60.0);
        for p in 1..=2u8 {
            n += 1;
            let has = |k: Kind| g.ents.iter().any(|e| e.alive && e.owner == p && e.kind == k && e.built >= 1.0);
            both += (has(Kind::Brickworks) && has(Kind::Sawmill)) as u32;
        }
    }
    assert!(both >= 5, "only {both} of {n} computer players had a Brickworks and a Sawmill after 20 minutes");
}

/// With nobody to fight, the computer's economy has to keep climbing: it
/// used to freeze in the Medieval era with every wood and stone slot held
/// (the first town stuck at 55 people), and now makes its houses Tenements
/// within half an hour. `ai_peace` measures it over twelve maps.
#[test]
fn a_peaceful_ai_keeps_climbing_the_eras() {
    let mut g = Game::new(3, 1, 2);
    g.set_ai(1, true);
    for a in g.ais.iter_mut() {
        a.next_attack = 1.0e9;
    }
    run(&mut g, 30.0 * 60.0);
    for p in 1..=2usize {
        assert!(g.players[p].era >= 2, "P{p} stopped in era {}: {}", g.players[p].era, census(&g, p as u8));
        assert!(g.players[p].people >= 150, "P{p} has only {} people", g.players[p].people);
    }
}

/// An Easy computer player doesn't hurry: however well its town does, no era
/// comes before its time (`EASY_ERA_AT`), and it keeps fewer soldiers.
#[test]
fn easy_computer_players_pace_their_eras() {
    let mut easy = Game::new(3, 0, 2);
    let mut normal = Game::new(3, 1, 2);
    for g in [&mut easy, &mut normal] {
        g.set_ai(1, true);
        for a in g.ais.iter_mut() {
            a.next_attack = 1.0e9;
        }
        run(g, 9.5 * 60.0);
    }
    // The same map and economy: Normal is already past the Ancient era.
    assert!(normal.players[1].era >= 1 || normal.players[2].era >= 1, "Normal should be Medieval by now");
    for p in 1..=2usize {
        assert_eq!(easy.players[p].era, 0, "Easy P{p} entered an era before {} s", EASY_ERA_AT[0]);
        assert!(easy.players[p].soldiers * 10 <= easy.players[p].people * 2, "Easy P{p}: {} soldiers of {}", easy.players[p].soldiers, easy.players[p].people);
    }
}

/// Each computer seat has its own skill: an Easy and a Hard player in the
/// same game, each with its own supply and its own pace.
#[test]
fn each_computer_player_has_its_own_difficulty() {
    let mut g = Game::new(3, 1, 3);
    g.set_difficulty(2, 0);
    g.set_difficulty(3, 2);
    assert_eq!((g.ais[2].difficulty, g.players[2].supply_pct), (0, 100));
    assert_eq!((g.ais[3].difficulty, g.players[3].supply_pct), (2, 130));
    assert!(g.ais[2].next_attack > g.ais[3].next_attack, "Easy attacks later than Hard");
    // The Easy one keeps its pace: no era before its time.
    for a in g.ais.iter_mut() {
        a.next_attack = 1.0e9;
    }
    run(&mut g, 9.5 * 60.0);
    assert_eq!(g.players[2].era, 0, "Easy entered an era before {} s", EASY_ERA_AT[0]);
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
        run(&mut g, 60.0);
        if min % every == 0 || g.state != 0 {
            println!("{min:2} min  P1: {}", census(&g, 1));
            for p in 2..=players {
                println!("        P{p}: {}", census(&g, p));
            }
        }
        if g.state != 0 {
            println!("winner {}", g.winner);
            break;
        }
    }
}



// ---------------------------------------------------------------------------
// Phase 4: house tiers, eras, converters, classes

#[test]
fn a_full_hut_with_every_good_can_become_a_cottage_and_stays_one() {
    let mut g = town(5, 1, 2);
    g.players[1].supply_pct = 200; // the Capitol's grain and fruit, doubled
    build(&mut g, Kind::LumberCamp); // wood to spare
    build(&mut g, Kind::HuntingLodge); // meat: 3 goods for both huts, 12 beds
    for _ in 0..4 {
        g.spawn_worker(1, None);
    }
    run(&mut g, 0.5);
    let used = |g: &Game| (g.players[1].used[Res::Wood.idx()], g.players[1].used[Res::Stone.idx()]);
    let hs = houses(&g, 1);
    assert!(hs.iter().all(|&h| g.ents[h].kind == Kind::Hut), "nothing grows by itself (it's the player's call)");
    assert!(hs.iter().all(|&h| g.house_upgrade(h) == Ok(Kind::Cottage)), "full, 3 goods, materials free: they could");
    g.apply(1, Command::Upgrade { ids: hs.iter().map(|&h| h as u32).collect() }).unwrap();
    assert!(hs.iter().all(|&h| g.ents[h].kind == Kind::Cottage), "Upgrade: both grow");
    // A cottage holds 2 wood and a stone (a hut held 1 wood); the lodge 1 wood.
    assert_eq!(used(&g), (2 * 2 + 1, 2));
    // The lodge burns: 2 goods is fewer than a cottage can use, but it stays
    // a cottage (with fewer beds) and keeps its materials.
    let beds = g.players[1].beds;
    let lodge = g.find_first(1, Kind::HuntingLodge).unwrap();
    g.ents[lodge].hp = 0.0;
    run(&mut g, 0.5);
    assert!(houses(&g, 1).iter().all(|&h| g.ents[h].kind == Kind::Cottage), "houses never shrink");
    assert_eq!(used(&g), (2 * 2, 2));
    assert!(g.players[1].beds < beds);
    // A cottage that isn't full can't grow (and says why).
    assert_eq!(g.house_upgrade(hs[0]).err(), Some(CmdError::Era(1)));
}

#[test]
fn ten_houses_of_the_next_tier_bring_the_next_era() {
    let mut g = town(5, 1, 2);
    g.players[1].supply_pct = 1000; // plenty of slots, so nothing else gets in the way
    build(&mut g, Kind::HuntingLodge); // and a third good, so cottages keep their tier
    let cottages = |g: &Game| g.ents.iter().filter(|e| e.alive && e.owner == 1 && e.kind == Kind::Cottage).count() as u32;
    // Add cottages one by one (the two huts may grow into some too): the
    // era comes on the tick there are ten, not before.
    while g.players[1].era == 0 {
        let before = cottages(&g);
        assert!(before < HOUSES_FOR_ERA, "{before} cottages and still Ancient");
        let (x, y) = spot(&g, Kind::Hut);
        g.spawn_building(Kind::Cottage, 1, x, y, 1.0);
        g.events.clear();
        g.tick();
    }
    assert!(cottages(&g) >= HOUSES_FOR_ERA);
    assert!(g.events.chunks(4).any(|e| e[0] == Ev::EraReached as u32 as f32 && e[3] == 17.0), "event: player 1, era 1");
    // Medieval kinds are unlocked now; the era is kept even if houses fall back.
    assert!(g.unlocked(1, Kind::IronMine));
    for i in 0..g.ents.len() {
        if g.ents[i].kind == Kind::Cottage {
            g.ents[i].hp = 0.0;
        }
    }
    run(&mut g, 1.0);
    assert_eq!(g.players[1].era, 1);
}

#[test]
fn medieval_things_wait_for_the_medieval_era() {
    let mut g = town(5, 1, 2);
    g.players[1].supply_pct = 200;
    build(&mut g, Kind::LumberCamp);
    let (x, y) = spot(&g, Kind::Bakery);
    let r = g.apply(1, Command::Place { ids: vec![], kind: Kind::Bakery, tx: x, ty: y });
    assert_eq!(r.err(), Some(CmdError::Era(1)));
    let barracks = build(&mut g, Kind::Barracks);
    let r = g.apply(1, Command::Train { ids: vec![barracks], kind: Kind::Swordsman });
    assert_eq!(r.err(), Some(CmdError::Era(1)));
    assert!(g.apply(1, Command::Train { ids: vec![barracks], kind: Kind::Spearman }).is_ok());
}

#[test]
fn converters_hold_their_inputs_and_the_newest_stops_first() {
    let mut g = town(5, 1, 2);
    g.players[1].era = 1;
    g.players[1].supply_pct = 200; // the Capitol's grain, doubled: 2
    let supply = |g: &Game, r: Res| g.players[1].supply[r.idx()];
    // The Capitol's 2 grain feed one bakery: 4 bread.
    let first = build(&mut g, Kind::Bakery);
    assert!(g.ents[first as usize].fed);
    assert_eq!((supply(&g, Res::Bread), free(&g, Res::Grain)), (4, 0));
    // A second bakery finds no grain free: it stops, the first goes on.
    let second = build(&mut g, Kind::Bakery);
    assert!(g.ents[first as usize].fed && !g.ents[second as usize].fed);
    assert_eq!(supply(&g, Res::Bread), 4);
    // A farm feeds it too.
    build(&mut g, Kind::Farm);
    assert!(g.ents[second as usize].fed);
    assert_eq!(supply(&g, Res::Bread), 8);
    // Paused, a bakery makes nothing but still holds its grain.
    let grain = free(&g, Res::Grain);
    g.apply(1, Command::Hire { ids: vec![first], on: false }).unwrap();
    g.resolve();
    assert_eq!(supply(&g, Res::Bread), 4);
    assert_eq!(free(&g, Res::Grain), grain);
}

#[test]
fn counters_go_by_class_across_eras() {
    use Kind::*;
    for (a, t, m) in [(Spearman, Horseman, 2.5), (Swordsman, Knight, 2.5), (Spearman, Knight, 2.5), (Knight, Crossbowman, 2.0), (Crossbowman, Swordsman, 1.5), (Trebuchet, Barracks, 3.0), (Trebuchet, Spearman, 0.3), (Archer, Barracks, 0.2), (Tower, Knight, 1.3), (Worker, Worker, 1.0)] {
        assert_eq!(damage_mult(a, t), m, "{a:?} against {t:?}");
    }
}

// ---------------------------------------------------------------------------
// Phase 5: the Gunpowder era

#[test]
fn a_full_cottage_with_five_goods_becomes_a_townhouse_from_the_medieval_era() {
    let mut g = town(5, 1, 2);
    g.players[1].supply_pct = 300; // plenty of wood and stone
    for k in [Kind::LumberCamp, Kind::Quarry, Kind::HuntingLodge, Kind::Brickworks] {
        build(&mut g, k);
    }
    let cottage = |g: &mut Game| {
        let (x, y) = spot(g, Kind::Hut);
        g.spawn_building(Kind::Cottage, 1, x, y, 1.0) as usize
    };
    let c = cottage(&mut g);
    // Five goods: the Capitol's grain and fruit, meat, and two Medieval
    // goods once there are bakeries and a weaver.
    g.players[1].era = 1;
    build(&mut g, Kind::Farm);
    build(&mut g, Kind::Bakery);
    build(&mut g, Kind::Farm);
    build(&mut g, Kind::Brewery);
    for _ in 0..30 {
        g.spawn_worker(1, None);
    }
    run(&mut g, 2.0);
    let _ = c;
    let cottages = |g: &Game| g.ents.iter().filter(|e| e.alive && e.owner == 1 && e.kind == Kind::Cottage).map(|e| e.id).collect::<Vec<u32>>();
    g.apply(1, Command::Upgrade { ids: cottages(&g) }).unwrap();
    let townhouses = |g: &Game| g.ents.iter().filter(|e| e.alive && e.kind == Kind::Townhouse).count();
    assert!(townhouses(&g) >= 1, "{}", census(&g, 1));
    // In the Ancient era it would have stayed a cottage.
    let mut g2 = town(5, 1, 2);
    g2.players[1].supply_pct = 300;
    build(&mut g2, Kind::HuntingLodge);
    let c2 = cottage(&mut g2);
    for _ in 0..30 {
        g2.spawn_worker(1, None);
    }
    run(&mut g2, 2.0);
    let _ = c2;
    assert_eq!(g2.apply(1, Command::Upgrade { ids: cottages(&g2) }).err(), Some(CmdError::Era(1)));
    assert_eq!(townhouses(&g2), 0);
}

#[test]
fn gunpowder_comes_from_nitrate_and_wood() {
    let mut g = town(5, 1, 2);
    g.players[1].era = 2;
    g.players[1].supply_pct = 300;
    build(&mut g, Kind::LumberCamp);
    build(&mut g, Kind::Brickworks); // the works and the mill are built with brick
    let works = build(&mut g, Kind::SaltpeterWorks);
    assert_eq!(g.players[1].supply[Res::Nitrate.idx()], 3 * makes(Kind::SaltpeterWorks, Res::Nitrate), "its nitrate, times 3");
    let mill = build(&mut g, Kind::PowderMill);
    assert!(g.ents[mill as usize].fed);
    assert!(g.players[1].supply[Res::Gunpowder.idx()] >= 3);
    // Musketeers and cannon need it.
    build(&mut g, Kind::IronMine);
    assert_eq!(g.short_of(1, Kind::Musketeer), None, "{}", census(&g, 1));
    assert_eq!(g.short_of(1, Kind::Cannon), None);
    // No saltpeter, no powder: the mill stops.
    g.ents[works as usize].hp = 0.0;
    run(&mut g, 0.2);
    assert!(!g.ents[mill as usize].fed);
    assert_eq!(g.players[1].supply[Res::Gunpowder.idx()], 0);
}

/// How Normal AIs fare over many maps: `cargo test --release ai_stats --
/// --ignored --nocapture`. VC_MINUTES sets the length (45).
#[test]
#[ignore]
fn ai_stats() {
    let minutes = std::env::var("VC_MINUTES").ok().and_then(|v| v.parse().ok()).unwrap_or(45.0);
    let (mut medieval, mut people, mut ended, mut n) = (0, 0, 0, 0);
    let mut eras = [0u32; 8];
    for seed in 1..=12 {
        let mut g = Game::new(seed, std::env::var("VC_DIFF").ok().and_then(|v| v.parse().ok()).unwrap_or(1), 2);
        g.set_ai(1, true);
        run(&mut g, minutes * 60.0);
        for p in 1..=2usize {
            n += 1;
            medieval += (g.players[p].era >= 1) as u32;
            people += g.players[p].people;
            eras[(g.players[p].era as usize).min(7)] += 1;
        }
        ended += (g.state != 0) as u32;
        println!("seed {seed:2}: eras {} {}, people {} {}, ended {}", g.players[1].era, g.players[2].era, g.players[1].people, g.players[2].people, g.state != 0);
    }
    println!("players per era (Ancient first): {eras:?}");
    println!("after {minutes} min: {medieval} of {n} players Medieval, {} people on average, {ended} of 12 games over", people / n);
}

// ---------------------------------------------------------------------------
// Phase 6: the Industrial era

#[test]
fn steel_comes_from_iron_and_coal_and_makes_field_guns_possible() {
    let mut g = town(5, 1, 2);
    g.players[1].era = 3;
    g.players[1].supply_pct = 300;
    // Beds for all the crews (people over beds leave, crews too).
    for _ in 0..4 {
        let (x, y) = spot(&g, Kind::Hut);
        g.spawn_building(Kind::Hut, 1, x, y, 1.0);
    }
    empty_campfire(&mut g);
    for k in [Kind::Brickworks, Kind::IronMine, Kind::CoalMine] {
        build(&mut g, k);
    }
    let mill = build(&mut g, Kind::SteelMill);
    assert!(g.ents[mill as usize].fed, "{}", census(&g, 1));
    assert!(g.players[1].supply[Res::Steel.idx()] >= 3);
    // Shells: nitrate and coal. Field guns: steel, shells and a horse.
    build(&mut g, Kind::SaltpeterWorks);
    let works = build(&mut g, Kind::ExplosivesWorks);
    assert!(g.ents[works as usize].fed, "{}", census(&g, 1));
    build(&mut g, Kind::Pasture);
    assert!(g.unlocked(1, Kind::Factory));
    assert_eq!(g.short_of(1, Kind::FieldGun), None, "{}", census(&g, 1));
    assert_eq!(Kind::Townhouse.upgrade(), Some(Kind::Tenement));
    assert_eq!(Kind::Tenement.house_tier(), Some(3));
    assert!(Kind::Apartment.stats().cost.iter().any(|&(r, _)| r == Res::Steel));
}

/// The houses that bring an era are grown in the era before it, so they
/// can only be made of what that era has. (Tenements once needed steel,
/// which only the Industrial era they bring makes: nobody got there.)
#[test]
fn every_house_is_made_of_what_the_era_before_it_has() {
    let mut house = Some(Kind::Hut);
    while let Some(k) = house {
        let tier = k.house_tier().unwrap();
        for &(r, _) in k.stats().cost {
            assert!(tier == 0 || r.era() < tier, "{k:?} (brings era {tier}) needs {r:?}, of era {}", r.era());
        }
        house = k.upgrade();
    }
}

/// How long a tick takes late in a game, natively: `cargo test --release
/// tick_cost -- --ignored --nocapture`. (The browser runs the wasm build,
/// a little slower; `node test/wasm.mjs` measures the start of a game.)
#[test]
#[ignore]
fn tick_cost() {
    for players in [2u8, 4] {
        let mut g = Game::new(1234, 1, players);
        g.set_ai(1, true);
        run(&mut g, 30.0 * 60.0);
        let t = std::time::Instant::now();
        let n = 20 * 60;
        let mut paths = 0;
        for _ in 0..n {
            g.tick();
            g.events.clear();
            paths += g.ents.iter().filter(|e| e.alive && !e.path.is_empty()).count();
        }
        let units = g.ents.iter().filter(|e| e.alive && !e.is_building()).count();
        println!("{players} players, {}x{} map, {units} units: {:.3} ms a tick (walking with a path: {} on average)", g.map.w, g.map.h, t.elapsed().as_secs_f64() * 1000.0 / n as f64, paths / n);
    }
}

// ---------------------------------------------------------------------------
// Phase 7: the Modern era

#[test]
fn aircraft_fly_over_anything_and_only_some_units_hit_them() {
    let mut g = town(5, 1, 2);
    // A fighter of player 2's over player 1's spearman: the spearman can't
    // touch it; a machine gunner can.
    let (x, y) = (30.0, 30.0);
    let fighter = g.spawn_unit(Kind::Fighter, 2, x, y);
    let spear = g.spawn_unit(Kind::Spearman, 1, x + 1.0, y);
    let mg = g.spawn_unit(Kind::MachineGunner, 1, x + 1.5, y + 0.5);
    g.rebuild_grid_for_tests();
    assert_eq!(g.nearest_enemy(spear as usize, 6.0), None);
    assert_eq!(g.nearest_enemy(mg as usize, 6.0), Some(fighter));
    // Ordered to attack it anyway, the spearman gives up.
    g.order_attack(spear, fighter);
    g.tick();
    assert_eq!(g.ents[spear as usize].order, Order::Idle);
    // It flies straight across the map, water and buildings alike, at its speed.
    let cap = g.find_first(1, Kind::Capitol).unwrap();
    let (cx, cy) = (g.ents[cap].x, g.ents[cap].y);
    let plane = g.spawn_unit(Kind::Fighter, 1, cx - 3.0, cy);
    g.order_move(plane, cx + 3.0, cy);
    run(&mut g, 1.2);
    let p = &g.ents[plane as usize];
    assert!((p.y - cy).abs() < 0.01 && p.x > cx + 2.9, "straight over the Capitol: {} {}", p.x, p.y);
}

#[test]
fn a_chain_of_converters_works_in_any_order() {
    let mut g = town(5, 1, 2);
    g.players[1].era = 4;
    g.players[1].supply_pct = 300;
    for _ in 0..6 {
        let (x, y) = spot(&g, Kind::Hut);
        g.spawn_building(Kind::Hut, 1, x, y, 1.0);
    }
    empty_campfire(&mut g);
    for k in [Kind::Brickworks, Kind::IronMine, Kind::CoalMine, Kind::SteelMill, Kind::SteelMill] {
        build(&mut g, k);
    }
    // The radio factory is older than the power plant it needs.
    let radios = build(&mut g, Kind::RadioFactory);
    build(&mut g, Kind::PowerPlant);
    g.resolve();
    assert!(g.ents[radios as usize].fed, "{}", census(&g, 1));
    assert!(g.players[1].supply[Res::Radios.idx()] >= 3);
}

// ---------------------------------------------------------------------------
// Phase 8: the Atomic era and the nuke

#[test]
fn a_nuke_is_armed_launched_and_leaves_a_crater() {
    let mut g = town(5, 1, 2);
    g.players[1].era = 5;
    g.players[1].supply_pct = 300;
    for _ in 0..6 {
        let (x, y) = spot(&g, Kind::Hut);
        g.spawn_building(Kind::Hut, 1, x, y, 1.0);
    }
    empty_campfire(&mut g);
    for k in [Kind::Brickworks, Kind::UraniumMine, Kind::SaltpeterWorks, Kind::CoalMine, Kind::ExplosivesWorks] {
        build(&mut g, k);
    }
    let silo = build(&mut g, Kind::MissileSilo);
    let uranium = free(&g, Res::Uranium);
    // Arming holds the nuke's slots and takes its time.
    g.apply(1, Command::Arm { id: silo }).unwrap();
    g.tick();
    assert_eq!(free(&g, Res::Uranium), uranium - 2);
    assert_eq!(g.apply(1, Command::Launch { id: silo, x: 10.0, y: 10.0 }).err(), Some(CmdError::NoBuilding), "not armed yet");
    run(&mut g, NUKE_ARM_TIME + 0.5);
    assert_eq!(g.ents[silo as usize].nuke, 2);
    // At player 2's Capitol: it flies, then everything near it falls.
    let cap = g.find_first(2, Kind::Capitol).unwrap();
    let (cx, cy) = (g.ents[cap].x, g.ents[cap].y);
    g.set_ai(2, false); // their spearmen stay put
    g.players[2].supply_pct = 400; // and supplied
    let near = g.spawn_unit(Kind::Spearman, 2, cx - 2.0, cy - 2.0);
    // Just outside the blast, toward the middle of the map.
    let (mx, my) = (g.map.w as f32 / 2.0 - cx, g.map.h as f32 / 2.0 - cy);
    let m = mx.hypot(my);
    let far = g.spawn_unit(Kind::Spearman, 2, cx + mx / m * (NUKE_RADIUS + 3.0), cy + my / m * (NUKE_RADIUS + 3.0));
    g.apply(1, Command::Launch { id: silo, x: cx, y: cy }).unwrap();
    g.tick();
    assert_eq!(free(&g, Res::Uranium), uranium, "launched: its slots come free");
    assert_eq!(g.nukes.len(), 1);
    run(&mut g, NUKE_FLIGHT - 1.0);
    assert!(g.alive(near), "still in flight");
    run(&mut g, 1.5);
    assert!(g.nukes.is_empty());
    assert!(!g.alive(near) && g.alive(far), "near {:?} far {:?} at {cx},{cy}", (g.ents[near as usize].x, g.ents[near as usize].y, g.ents[near as usize].hp), (g.ents[far as usize].x, g.ents[far as usize].y, g.ents[far as usize].hp));
    assert!(!g.ents[cap].alive, "the Capitol at the centre is gone");
    assert_eq!(g.winner, 1, "and with it player 2");
    let i = g.map.idx(cx as i32, cy as i32);
    assert!(g.map.blocked[i] && g.map.terrain[i] == crate::map::CRATER);
    assert_eq!(g.craters.len(), 1);
}

/// Playtest: the builders of a producer stay on as its crew when it's done,
/// even when free workers at the campfire could have come instead.
#[test]
fn builders_start_work_where_they_built() {
    let mut g = town(5, 1, 2);
    build(&mut g, Kind::LumberCamp);
    let (x, y) = spot(&g, Kind::Quarry);
    let q = g.apply(1, Command::Place { ids: vec![], kind: Kind::Quarry, tx: x, ty: y }).map(|_| g.ents.len() as u32 - 1).unwrap();
    assert_eq!(g.ents[q as usize].kind, Kind::Quarry);
    let mut builder = None;
    for _ in 0..20 * 120 {
        g.tick();
        if builder.is_none() {
            builder = g.ents.iter().find(|e| e.alive && e.order == Order::Build(q) && g.ents[q as usize].builders_in > 0).map(|e| e.id);
        }
        if g.ents[q as usize].built >= 1.0 {
            break;
        }
    }
    let b = builder.expect("someone built it");
    g.tick();
    g.tick();
    assert_eq!(g.ents[b as usize].order, Order::Work(q), "the builder went to work there");
}

/// Playtest: attackers go for what fights back before workers and houses.
#[test]
fn attackers_go_for_what_fights_first() {
    let mut g = town(5, 1, 2);
    g.set_ai(2, false);
    let (x, y) = (60.0, 60.0);
    let me = g.spawn_unit(Kind::Spearman, 1, x, y);
    let worker = g.spawn_unit(Kind::Worker, 2, x + 1.0, y);
    let soldier = g.spawn_unit(Kind::Spearman, 2, x + 4.0, y);
    g.rebuild_grid_for_tests();
    assert_eq!(g.nearest_enemy(me as usize, 6.0), Some(soldier), "the soldier, though the worker is nearer");
    // Already hitting the worker: it turns to the soldier.
    g.order_attack(me, worker);
    g.ents[me as usize].order = Order::Attack { target: worker, auto: true };
    g.tick();
    g.tick();
    assert_eq!(g.ents[me as usize].order, Order::Attack { target: soldier, auto: true });
    let _ = worker;
}

/// How much brick a town needs, era by era, against how much one clay
/// deposit can make: `cargo test --release brick_budget -- --ignored
/// --nocapture`. The town: ten houses of the tier that brings the next era,
/// with every good they can use (one slot each), and the producers for those
/// goods and for everything those producers take, one barracks-like
/// building per era, and the houses' own materials.
#[test]
#[ignore]
fn brick_budget() {
    use std::collections::BTreeMap;
    let producer = |r: Res| Kind::BUILDABLE.into_iter().find(|k| k.stats().produces.iter().any(|&(p, _)| p == r));
    let mut house = Kind::Cottage;
    while let Some(next) = house.upgrade() {
        let tier = next.house_tier().unwrap(); // brings era `tier`, grown in era tier-1
        let era = tier - 1;
        // Goods the houses use: the first `max` house goods of their era or older.
        let max = house_max_goods(tier) as usize;
        let goods: Vec<Res> = Res::ALL.into_iter().filter(|r| r.is_house_good() && r.era() <= tier && producer(*r).is_some_and(|k| k.era() <= era)).take(max).collect();
        // Slots needed of everything: 10 of each good, then what makes them.
        let mut need: BTreeMap<usize, u32> = BTreeMap::new();
        for r in &goods {
            *need.entry(r.idx()).or_default() += 10;
        }
        let mut buildings: BTreeMap<&'static str, u32> = BTreeMap::new();
        let mut brick_in_buildings = 0u32;
        // Resolve producers, most refined first (several passes are enough).
        let mut made: BTreeMap<usize, u32> = BTreeMap::new();
        for _ in 0..8 {
            for (&ri, &n) in need.clone().iter() {
                let have = *made.get(&ri).unwrap_or(&0);
                if have >= n || Res::ALL[ri] == Res::Brick {
                    continue;
                }
                let Some(k) = producer(Res::ALL[ri]) else { continue };
                let out = k.stats().produces.iter().find(|&&(p, _)| p.idx() == ri).unwrap().1 as u32;
                let count = (n - have).div_ceil(out);
                *buildings.entry(Box::leak(format!("{k:?}").into_boxed_str())).or_default() += count;
                for &(p, q) in k.stats().produces {
                    *made.entry(p.idx()).or_default() += q as u32 * count;
                }
                for &(c, q) in k.stats().consumes {
                    *need.entry(c.idx()).or_default() += q as u32 * count;
                }
                for &(c, q) in k.stats().cost {
                    if c == Res::Brick {
                        brick_in_buildings += q as u32 * count;
                    }
                }
            }
        }
        let brick_in_houses: u32 = next.stats().cost.iter().filter(|c| c.0 == Res::Brick).map(|c| c.1 as u32).sum::<u32>() * 10;
        let total = brick_in_buildings + brick_in_houses + need.get(&Res::Brick.idx()).copied().unwrap_or(0);
        let per = Kind::Brickworks.stats().produces[0].1 as u32;
        println!(
            "{:?} era (growing 10 {next:?}s, {} goods each): brick in houses {brick_in_houses}, in producers {brick_in_buildings}, taken {} => {total} brick = {} brickworks of {per}",
            ["Ancient", "Medieval", "Gunpowder", "Industrial", "Modern", "Atomic"][era as usize], goods.len(), need.get(&Res::Brick.idx()).copied().unwrap_or(0), total.div_ceil(per)
        );
        println!("   producers: {buildings:?}");
        house = next;
    }
    // How many brickworks fit around a base's clay.
    for seed in 1..=4 {
        let mut g = town(seed, 1, 2);
        let mut n = 0;
        let (cx, cy) = { let c = g.find_first(1, Kind::Capitol).unwrap(); (g.ents[c].x, g.ents[c].y) };
        for y in 0..g.map.h {
            for x in 0..g.map.w {
                if ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt() < 40.0 && g.can_place(Kind::Brickworks, x, y, 1, 0) {
                    g.spawn_building(Kind::Brickworks, 1, x, y, 1.0);
                    n += 1;
                }
            }
        }
        println!("seed {seed}: {n} brickworks fit by the clay within 40 tiles of the Capitol = {} brick", n * Kind::Brickworks.stats().produces[0].1 as u32);
    }
}

#[test]
fn musketeers_fight_each_other() {
    let mut g = town(3, 1, 2);
    g.set_ai(2, false);
    g.players[1].supply_pct = 400;
    g.players[2].supply_pct = 400;
    let a = g.spawn_unit(Kind::Musketeer, 1, 60.0, 60.0);
    let b = g.spawn_unit(Kind::Musketeer, 2, 65.0, 60.0);
    run(&mut g, 6.0);
    assert!(g.ents[a as usize].hp < Kind::Musketeer.stats().hp || g.ents[b as usize].hp < Kind::Musketeer.stats().hp, "{:?} {:?}", g.ents[a as usize].order, g.ents[b as usize].order);
}

// ---------------------------------------------------------------------------
// October 2026 playtest: fewer buildings, Capitols, nukes and air defense

/// A spot for `kind` at least `far` tiles from player 1's Capitol.
fn spot_away(g: &Game, kind: Kind, far: i32) -> (i32, i32) {
    let cap = &g.ents[g.find_first(1, Kind::Capitol).unwrap()];
    let (cx, cy) = (cap.tx, cap.ty);
    for r in far..60 {
        for y in cy - r..=cy + r {
            for x in cx - r..=cx + r {
                if (x - cx).abs().max((y - cy).abs()) == r && g.can_place(kind, x, y, 1, 1) {
                    return (x, y);
                }
            }
        }
    }
    panic!("no spot for {kind:?}");
}

#[test]
fn seven_of_a_kind_is_a_target_not_a_rule() {
    let mut g = town(5, 1, 2);
    g.players[1].supply_pct = 1000;
    for _ in 0..MAX_SAME {
        build(&mut g, Kind::FishingHut);
    }
    let (x, y) = spot(&g, Kind::FishingHut);
    g.apply(1, Command::Place { ids: vec![], kind: Kind::FishingHut, tx: x, ty: y }).expect("an eighth is allowed");
    assert_eq!(Game::max_of(Kind::FishingHut), MAX_SAME, "the computer keeps to seven");
}

#[test]
fn capitols_can_be_founded_and_only_the_last_one_counts() {
    let mut g = town(5, 1, 2);
    g.set_ai(2, false);
    g.players[1].supply_pct = 1000;
    build(&mut g, Kind::Brickworks);
    let (x, y) = spot_away(&g, Kind::Capitol, 18);
    assert_eq!(g.apply(1, Command::Place { ids: vec![], kind: Kind::Capitol, tx: x, ty: y }).err(), Some(CmdError::Era(1)), "not in the Ancient era");
    g.players[1].era = 1;
    let wood = free(&g, Res::Wood);
    let beds = g.players[1].beds;
    g.apply(1, Command::Place { ids: vec![], kind: Kind::Capitol, tx: x, ty: y }).unwrap();
    let second = g.ents.len() - 1;
    g.tick();
    assert_eq!(free(&g, Res::Wood), wood - 8, "a founded Capitol holds its cost (the first holds nothing)");
    g.ents[second].built = 1.0;
    g.ents[second].hp = Kind::Capitol.stats().hp;
    g.tick();
    assert_eq!(g.players[1].beds, beds + CAPITOL_BEDS, "a finished one has beds of its own");
    let first = g.find_first(1, Kind::Capitol).unwrap();
    let hut = build(&mut g, Kind::Hut);
    // The first falls: nothing else does, and the player plays on.
    g.ents[first].hp = 0.0;
    run(&mut g, 0.2);
    assert!(g.alive(hut), "losing a Capitol takes nothing else with it");
    assert!(!g.players[1].defeated && g.state == 0);
    assert_eq!(g.home_capitol(1), Some(second), "the campfire moves to the other");
    // The last one falls: out.
    g.ents[second].hp = 0.0;
    run(&mut g, 0.2);
    assert!(g.players[1].defeated);
}

#[test]
fn an_unfinished_capitol_does_not_keep_you_in_the_game() {
    let mut g = town(5, 1, 2);
    g.players[1].era = 1;
    g.players[1].supply_pct = 1000;
    build(&mut g, Kind::Brickworks);
    let (x, y) = spot_away(&g, Kind::Capitol, 18);
    g.apply(1, Command::Place { ids: vec![], kind: Kind::Capitol, tx: x, ty: y }).unwrap();
    let first = g.find_first(1, Kind::Capitol).unwrap();
    g.ents[first].hp = 0.0;
    run(&mut g, 0.2);
    assert!(g.players[1].defeated);
}

#[test]
fn an_air_defense_shoots_down_a_nuke_falling_near_it() {
    let mut g = town(5, 1, 2);
    g.set_ai(2, false);
    let cap = g.find_first(2, Kind::Capitol).unwrap();
    let (cx, cy) = (g.ents[cap].x, g.ents[cap].y);
    // Player 2 has an air defense next to their Capitol.
    let (tx, ty) = (g.ents[cap].tx, g.ents[cap].ty);
    let mut def = None;
    'find: for r in 4..12 {
        for y in ty - r..=ty + r {
            for x in tx - r..=tx + r {
                if g.can_place(Kind::AirDefense, x, y, 2, 0) {
                    def = Some(g.spawn_building(Kind::AirDefense, 2, x, y, 1.0));
                    break 'find;
                }
            }
        }
    }
    let def = def.unwrap();
    let silo = g.spawn_building(Kind::MissileSilo, 1, 2, 2, 1.0);
    g.ents[silo as usize].nuke = 2;
    g.apply(1, Command::Launch { id: silo, x: cx, y: cy }).unwrap();
    run(&mut g, NUKE_FLIGHT + 0.5);
    assert!(g.alive(cap as u32) && g.craters.is_empty(), "shot down: no blast");
    assert!(g.ents[def as usize].progress > 0.0, "and it's reloading");
    // A second one while it reloads gets through.
    g.ents[silo as usize].nuke = 2;
    g.apply(1, Command::Launch { id: silo, x: cx, y: cy }).unwrap();
    run(&mut g, NUKE_FLIGHT + 0.5);
    assert_eq!(g.craters.len(), 1);
    assert!(!g.alive(cap as u32));
}

#[test]
fn shells_hurt_what_stands_around_their_target() {
    let mut g = town(5, 1, 2);
    g.set_ai(2, false);
    let a = g.spawn_unit(Kind::Spearman, 2, 40.0, 40.0);
    let b = g.spawn_unit(Kind::Spearman, 2, 40.8, 40.0);
    let far = g.spawn_unit(Kind::Spearman, 2, 44.0, 40.0);
    let gun = g.spawn_unit(Kind::Cannon, 1, 32.0, 40.0);
    g.players[1].supply_pct = 1000;
    g.players[2].supply_pct = 1000;
    g.apply(1, Command::Smart { ids: vec![gun], x: 40.0, y: 40.0 }).unwrap();
    let hp = Kind::Spearman.stats().hp;
    for _ in 0..20 * 8 {
        g.tick();
        if g.ents[a as usize].hp < hp {
            break;
        }
    }
    run(&mut g, 0.1);
    assert!(g.ents[a as usize].hp < hp, "the target is hit");
    assert!(g.ents[b as usize].hp < hp, "and the one next to it");
    assert_eq!(g.ents[far as usize].hp, hp, "but not one further off");
}

#[test]
fn your_own_units_can_be_disbanded() {
    let mut g = town(5, 1, 2);
    let w = g.ents.iter().find(|e| e.alive && e.owner == 1 && e.kind == Kind::Worker).unwrap().id;
    let theirs = g.ents.iter().find(|e| e.alive && e.owner == 2 && e.kind == Kind::Worker).unwrap().id;
    let people = g.players[1].people;
    g.apply(1, Command::Demolish { ids: vec![w, theirs] }).unwrap();
    g.tick();
    assert!(!g.alive(w), "mine are gone");
    assert!(g.alive(theirs), "theirs aren't mine to disband");
    g.tick();
    assert_eq!(g.players[1].people, people - 1);
}

#[test]
fn beds_grow_faster_with_more_goods() {
    assert_eq!(beds_for(3), 6);
    assert_eq!(beds_for(5), 12);
    assert_eq!(beds_for(13), 36);
}

#[test]
fn an_air_defense_missile_brings_down_any_aircraft() {
    let mut g = town(5, 1, 2);
    g.set_ai(2, false);
    g.players[2].supply_pct = 1000;
    let (x, y) = spot(&g, Kind::AirDefense);
    g.spawn_building(Kind::AirDefense, 1, x, y, 1.0);
    let planes: Vec<u32> = [Kind::Bomber, Kind::Jet].iter().map(|&k| g.spawn_unit(k, 2, x as f32 + 6.0, y as f32 + 1.0)).collect();
    let ground = g.spawn_unit(Kind::Spearman, 2, x as f32 + 3.0, y as f32);
    run(&mut g, 2.0);
    assert_eq!(planes.iter().filter(|&&p| !g.alive(p)).count(), 1, "one missile, one aircraft down");
    run(&mut g, 6.0);
    assert!(planes.iter().all(|&p| !g.alive(p)), "and the next");
    let _ = ground;
    assert!(!Kind::AirDefense.can_hit(Kind::Spearman), "it can't hit the ground");
}

#[test]
fn cheat_mode_lets_people_build_anything_free() {
    let mut g = town(5, 1, 2);
    // Player 2 is the computer: no cheats for it.
    g.set_cheats(true);
    assert!(g.cheat(1) && !g.cheat(2));
    g.tick();
    assert_eq!(free(&g, Res::Wood), g.players[1].supply[Res::Wood.idx()] as i32, "nothing holds slots");
    let (x, y) = spot(&g, Kind::Airfield);
    let wood = free(&g, Res::Wood);
    g.apply(1, Command::Place { ids: vec![], kind: Kind::Airfield, tx: x, ty: y }).expect("any era, nothing needed first, free");
    g.tick();
    assert_eq!(free(&g, Res::Wood), wood);
    let id = g.ents.len() as u32 - 1;
    g.ents[id as usize].built = 1.0;
    g.apply(1, Command::Train { ids: vec![id], kind: Kind::Jet }).expect("and train anything");
    // Off again: back to the rules.
    g.set_cheats(false);
    let (x, y) = spot(&g, Kind::TankWorks);
    assert!(g.apply(1, Command::Place { ids: vec![], kind: Kind::TankWorks, tx: x, ty: y }).is_err());
}

#[test]
fn the_lowest_houses_fill_first_so_they_can_grow() {
    let mut g = town(5, 1, 2);
    g.players[1].supply_pct = 300;
    build(&mut g, Kind::HuntingLodge);
    // The nearer hut becomes a cottage; the further one stays a hut.
    let hs = houses(&g, 1);
    let (near, far) = (hs[0], hs[1]);
    g.ents[near].kind = Kind::Cottage;
    g.resolve();
    g.tick();
    let (hut, cottage) = (&g.ents[far], &g.ents[near]);
    assert!(g.players[1].people < hut.beds() as u32 + cottage.beds() as u32, "not enough people for both");
    assert_eq!(hut.residents, hut.beds(), "the hut is full first, though it's further away");
    assert!(cottage.residents < cottage.beds());
}

/// Playtest: ten seconds of standing around before the first worker was too long.
#[test]
fn the_first_worker_comes_within_two_seconds() {
    let mut g = Game::new(9, 1, 2);
    for p in 1..=2 {
        g.set_ai(p, false);
    }
    run(&mut g, 1.8);
    assert_eq!(g.players[1].people, 0, "not yet");
    run(&mut g, 0.4);
    assert_eq!(g.players[1].people, 1, "one worker after about two seconds");
}

/// Playtest: workers stood inside the Capitol, where the ring of spots in the
/// town square reached into its front wall, and couldn't walk out.
#[test]
fn nobody_stands_inside_the_capitol() {
    for players in 2..=4 {
        let g = Game::new(9, 1, players);
        for p in 1..=players {
            let c = g.find_first(p, Kind::Capitol).unwrap();
            let (tx, ty, size) = (g.ents[c].tx as f32, g.ents[c].ty as f32, g.ents[c].kind.stats().size as f32);
            for id in 0..300u32 {
                let (x, y) = g.campfire_spot(p, id).unwrap();
                let inside = x >= tx && x < tx + size && y >= ty && y < ty + size;
                assert!(!inside, "player {p}, worker {id}: spot ({x}, {y}) is inside the Capitol at ({tx}, {ty})");
                let (cx, cy) = g.campfire(p).unwrap();
                assert!((x - cx).powi(2) + (y - cy).powi(2) <= crate::people::CAMPFIRE_AREA * crate::people::CAMPFIRE_AREA, "player {p}, worker {id}: spot is outside the square");
            }
        }
    }
}

/// And in a real game a newcomer walks out to a spot and waits there, free.
#[test]
fn a_newcomer_waits_in_the_square() {
    let mut g = Game::new(9, 1, 2);
    for p in 1..=2 {
        g.set_ai(p, false);
    }
    run(&mut g, 4.0);
    let w = g.ents.iter().position(|e| e.alive && e.owner == 1 && e.kind == Kind::Worker).expect("a worker came");
    let c = g.find_first(1, Kind::Capitol).unwrap();
    let (tx, ty) = (g.ents[c].tx as f32, g.ents[c].ty as f32);
    let (x, y) = (g.ents[w].x, g.ents[w].y);
    assert!(!(x >= tx && x < tx + 3.0 && y >= ty && y < ty + 3.0), "({x}, {y}) is inside the Capitol");
    assert!(g.is_free_worker(&g.ents[w]), "and waits in the town square");
}

#[test]
#[ignore]
fn diag_timeline() {
    let env = |k: &str, d: u32| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
    let mut g = Game::new(env("VC_SEED", 4), 1, 2);
    g.set_ai(1, true);
    if env("VC_PEACE", 1) == 1 {
        for a in g.ais.iter_mut() { a.next_attack = 1.0e9; }
    }
    let me = env("VC_P", 1) as u8;
    for m in 1..=env("VC_MINUTES", 60) {
        run(&mut g, 60.0);
        if m % env("VC_EVERY", 3) != 0 { continue; }
        let p = &g.players[me as usize];
        let mut by: std::collections::BTreeMap<String, u32> = Default::default();
        for e in g.ents.iter().filter(|e| e.alive && e.owner == me && e.built >= 1.0 && e.kind.house_tier().is_some()) {
            *by.entry(format!("{:?}", e.kind)).or_default() += 1;
        }
        println!("{m:2}m era {} people {} soldiers {} state {} houses {by:?} short {:?} free w{} s{} b{}", p.era, p.people, p.soldiers, g.state, g.upgrade_short(me), p.free(Res::Wood), p.free(Res::Stone), p.free(Res::Brick));
    }
    println!("{}", census(&g, me));
}

/// How far the computer's economy gets when nobody attacks it: the era of
/// every player after VC_MINUTES (40), over 12 maps. For comparing changes
/// to the AI: `cargo test --release ai_peace -- --ignored --nocapture`.
#[test]
#[ignore]
fn ai_peace() {
    let minutes: f32 = std::env::var("VC_MINUTES").ok().and_then(|v| v.parse().ok()).unwrap_or(40.0);
    let mut eras = [0u32; 8];
    let mut people = 0;
    for seed in 1..=12 {
        let mut g = Game::new(seed, std::env::var("VC_DIFF").ok().and_then(|v| v.parse().ok()).unwrap_or(1), 2);
        g.set_ai(1, true);
        for a in g.ais.iter_mut() {
            a.next_attack = 1.0e9;
        }
        run(&mut g, minutes * 60.0);
        let (a, b) = (&g.players[1], &g.players[2]);
        eras[a.era as usize] += 1;
        eras[b.era as usize] += 1;
        people += a.people + b.people;
        println!("seed {seed:2}: eras {} {} people {} {}", a.era, b.era, a.people, b.people);
    }
    println!("players per era {eras:?}, {} people on average, era sum {}", people / 24, eras.iter().enumerate().map(|(e, n)| e as u32 * n).sum::<u32>());
}

/// How fast the computer climbs the eras when nobody attacks it: when each
/// player reaches each era, over 12 maps (two at a time, one per core).
/// `cargo test --release ai_pace -- --ignored --nocapture`; VC_MINUTES (50),
/// VC_DIFF (1), VC_SEEDS (12). The score is minutes to each era summed over
/// eras and players, an era not reached counting as the whole run: lower is
/// better.
#[test]
#[ignore]
fn ai_pace() {
    let env = |k: &str, d: u32| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
    let (minutes, diff, seeds) = (env("VC_MINUTES", 50), env("VC_DIFF", 1), env("VC_SEEDS", 12));
    let one = |seed: u32| {
        let mut g = Game::new(seed, diff, 2);
        g.set_ai(1, true);
        g.set_difficulty(1, diff);
        for a in g.ais.iter_mut() {
            a.next_attack = 1.0e9;
        }
        let mut at = [[f32::NAN; 6]; 3];
        for s in 0..minutes * 6 {
            run(&mut g, 10.0);
            for p in 1..=2usize {
                let e = g.players[p].era as usize;
                for k in 1..=e {
                    if at[p][k].is_nan() {
                        at[p][k] = (s + 1) as f32 / 6.0;
                    }
                }
            }
        }
        (seed, at, [g.players[1].people, g.players[2].people])
    };
    let mut results = Vec::new();
    let all: Vec<u32> = (1..=seeds).collect();
    for pair in all.chunks(2) {
        let got: Vec<_> = std::thread::scope(|sc| pair.iter().map(|&s| sc.spawn(move || one(s))).collect::<Vec<_>>().into_iter().map(|h| h.join().unwrap()).collect());
        results.extend(got);
    }
    let mut score = 0.0;
    let mut times: Vec<Vec<f32>> = vec![Vec::new(); 6];
    for (seed, at, people) in &results {
        let f = |p: usize| (1..=5).map(|e| if at[p][e].is_nan() { "  -  ".to_string() } else { format!("{:5.1}", at[p][e]) }).collect::<Vec<_>>().join(" ");
        println!("seed {seed:2}: P1 {} ({} people) | P2 {} ({} people)", f(1), people[0], f(2), people[1]);
        for p in 1..=2 {
            for e in 1..=5 {
                let t = at[p][e];
                score += if t.is_nan() { minutes as f32 } else { t };
                if !t.is_nan() {
                    times[e].push(t);
                }
            }
        }
    }
    let n = results.len() * 2;
    for e in 1..=5 {
        let mut v = times[e].clone();
        v.sort_by(f32::total_cmp);
        let med = if v.is_empty() { f32::NAN } else { v[v.len() / 2] };
        println!("era {e}: {:2} of {n} reached it, median {med:.1} min", v.len());
    }
    println!("score {score:.0} (lower is better)");
}

/// Why one computer player is where it is: its town after VC_MINUTES (20) on
/// VC_SEED (9), nobody attacking, and its reasons over its next few turns.
/// `cargo test --release diag_ai -- --ignored --nocapture`.
#[test]
#[ignore]
fn diag_ai() {
    let env = |k: &str, d: u32| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
    let (seed, me, minutes, turns) = (env("VC_SEED", 9), env("VC_P", 1) as u8, env("VC_MINUTES", 20), env("VC_TURNS", 6));
    let mut g = Game::new(seed, env("VC_DIFF", 1), 2);
    g.set_ai(1, true);
    for a in g.ais.iter_mut() {
        a.next_attack = 1.0e9;
    }
    for m in 1..=minutes {
        run(&mut g, 60.0);
        if m % env("VC_EVERY", 5) == 0 {
            let p = &g.players[me as usize];
            let mut by: std::collections::BTreeMap<String, u32> = Default::default();
            for e in g.ents.iter().filter(|e| e.alive && e.owner == me && e.built >= 1.0 && e.kind.house_tier().is_some()) {
                *by.entry(format!("{:?}", e.kind)).or_default() += 1;
            }
            println!("{m:2}m era {} people {}/{} soldiers {} houses {by:?}", p.era, p.people, p.beds, p.soldiers);
        }
    }
    println!("{}", census(&g, me));
    for _ in 0..turns {
        crate::ai::ai_log_start();
        g.ai_think(me);
        for l in crate::ai::ai_log_take() {
            println!("  {l}");
        }
        run(&mut g, 0.5);
    }
}

#[test]
#[ignore]
fn diag_sites() {
    let env = |k: &str, d: u32| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
    let (seed, me, minutes) = (env("VC_SEED", 2), env("VC_P", 1) as u8, env("VC_MINUTES", 40));
    let mut g = Game::new(seed, 1, 2);
    g.set_ai(1, true);
    for a in g.ais.iter_mut() {
        a.next_attack = 1.0e9;
    }
    run(&mut g, minutes as f32 * 60.0);
    let cap = g.home_capitol(me).unwrap();
    println!("home {:.0},{:.0} campfire {:?}", g.ents[cap].x, g.ents[cap].y, g.campfire(me));
    crate::ai::ai_log_start();
    run(&mut g, 60.0);
    for l in crate::ai::ai_log_take().iter().filter(|l| l.contains("tear down") || l.contains("placed")) {
        println!("  {l}");
    }
    for round in 0..3 {
        for e in g.ents.iter().filter(|e| e.alive && e.owner == me && e.is_building() && e.built < 1.0) {
            let coming: Vec<String> = g.ents.iter().filter(|w| w.alive && w.order == Order::Build(e.id)).map(|w| format!("({:.0},{:.0} {:?})", w.x, w.y, w.goal.is_some())).collect();
            println!("r{round} site {:?} #{} at {},{} built {:.2} builders_in {} coming {:?}", e.kind, e.id, e.tx, e.ty, e.built, e.builders_in, coming);
        }
        run(&mut g, 20.0);
    }
}

#[test]
#[ignore]
fn diag_losses() {
    let env = |k: &str, d: u32| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
    let mut g = Game::new(env("VC_SEED", 9), 1, 2);
    g.set_ai(1, true);
    for a in g.ais.iter_mut() {
        a.next_attack = 1.0e9;
    }
    for m in 1..=env("VC_MINUTES", 25) {
        run(&mut g, 60.0);
        let lost: Vec<u32> = (1..=2).map(|p| g.players[p].lost).collect();
        let cap: Vec<bool> = (1..=2u8).map(|p| g.home_capitol(p).is_some()).collect();
        let away: Vec<usize> = (1..=2u8).map(|p| {
            let o = 3 - p;
            let Some(c) = g.home_capitol(o) else { return 0 };
            let (cx, cy) = (g.ents[c].x, g.ents[c].y);
            g.ents.iter().filter(|e| e.alive && e.owner == p && e.kind.is_military() && (e.x - cx).hypot(e.y - cy) < 30.0).count()
        }).collect();
        println!("{m:2}m lost {lost:?} capitols {cap:?} soldiers in the other's town {away:?}");
    }
}

#[test]
#[ignore]
fn diag_capitol() {
    let env = |k: &str, d: u32| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
    let me = env("VC_P", 1) as u8;
    let mut g = Game::new(env("VC_SEED", 9), 1, 2);
    g.set_ai(1, true);
    for a in g.ais.iter_mut() {
        a.next_attack = 1.0e9;
    }
    run(&mut g, env("VC_FROM", 23) as f32 * 60.0);
    let caps: Vec<usize> = g.ents.iter().enumerate().filter(|(_, e)| e.alive && e.owner == me && e.kind == Kind::Capitol).map(|(i, _)| i).collect();
    println!("capitols of P{me}: {:?}", caps.iter().map(|&i| (g.ents[i].tx, g.ents[i].ty, g.ents[i].starting, g.ents[i].hp)).collect::<Vec<_>>());
    crate::ai::ai_log_start();
    for t in 0..(4 * 60 * 2) {
        run(&mut g, 0.5);
        let gone: Vec<usize> = caps.iter().copied().filter(|&i| !g.ents[i].alive || g.ents[i].owner != me).collect();
        if !gone.is_empty() || t % 60 == 0 {
            println!("t {:.0}: capitols alive {:?} home {:?}", g.time, caps.iter().map(|&i| (g.ents[i].alive, g.ents[i].hp as i32)).collect::<Vec<_>>(), g.home_capitol(me));
            if !gone.is_empty() {
                for l in crate::ai::ai_log_take().iter().rev().take(30).rev() {
                    println!("  {l}");
                }
                break;
            }
            crate::ai::ai_log_take();
            crate::ai::ai_log_start();
        }
    }
}

#[test]
#[ignore]
fn diag_scout() {
    let env = |k: &str, d: u32| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
    let me = env("VC_P", 1) as u8;
    let mut g = Game::new(env("VC_SEED", 13), 1, 2);
    g.set_ai(1, true);
    for a in g.ais.iter_mut() {
        a.next_attack = 1.0e9;
    }
    run(&mut g, env("VC_MINUTES", 15) as f32 * 60.0);
    for _ in 0..6 {
        if let Some(id) = g.ais[me as usize].scout {
            let e = &g.ents[id as usize];
            let goal = match e.order { Order::Move { x, y } => Some((x, y)), _ => None };
            let pass = goal.map(|(x, y)| (g.map.passable(x as i32, y as i32), g.map.terrain[g.map.idx(x as i32, y as i32)], g.explored_by(me, x as i32, y as i32)));
            println!("t {:.0} scout #{id} {:?} at {:.1},{:.1} order {:?} goal passable/terrain/explored {:?} path {} stuck {:.1}", g.time, e.kind, e.x, e.y, e.order, pass, e.path.len(), e.stuck);
        }
        run(&mut g, 10.0);
    }
}

/// Why the computer players that didn't reach the Atomic era stopped: the
/// main reasons from one turn of each, after VC_MINUTES (50), peaceful.
#[test]
#[ignore]
fn ai_stalls() {
    let env = |k: &str, d: u32| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
    let (minutes, seeds) = (env("VC_MINUTES", 50), env("VC_SEEDS", 24));
    let one = |seed: u32| {
        let mut g = Game::new(seed, 1, 2);
        g.set_ai(1, true);
        for a in g.ais.iter_mut() {
            a.next_attack = 1.0e9;
        }
        run(&mut g, minutes as f32 * 60.0);
        let mut out = Vec::new();
        for p in 1..=2u8 {
            if g.players[p as usize].era >= 5 {
                continue;
            }
            let mut h = g.clone();
            crate::ai::ai_log_start();
            h.ai_think(p);
            let log = crate::ai::ai_log_take();
            let keep: Vec<String> = log.iter().filter(|l| l.contains("upgrade waits") || l.contains("nowhere") || l.contains("tiles explored") || l.contains("short of") || l.contains("nothing to spare") || l.contains("waits for workers")).take(6).cloned().collect();
            let pl = &g.players[p as usize];
            let raw: Vec<String> = [Res::Wood, Res::Stone, Res::Brick, Res::Iron, Res::Coal, Res::Steel, Res::Aluminum].iter().filter(|r| pl.supply[r.idx()] > 0).map(|r| format!("{r:?} {}/{}", pl.used[r.idx()], pl.supply[r.idx()])).collect();
            out.push(format!("seed {seed} P{p} era {} people {}/{} past {} | {}\n      {}", pl.era, pl.people, pl.beds, g.houses_past_era(p), raw.join(" "), keep.join("\n      ")));
        }
        out
    };
    let all: Vec<u32> = (1..=seeds).collect();
    for pair in all.chunks(2) {
        let got: Vec<Vec<String>> = std::thread::scope(|sc| pair.iter().map(|&s| sc.spawn(move || one(s))).collect::<Vec<_>>().into_iter().map(|h| h.join().unwrap()).collect());
        for v in got {
            for l in v {
                println!("{l}");
            }
        }
    }
}

#[test]
#[ignore]
fn diag_kind() {
    let env = |k: &str, d: u32| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
    let me = env("VC_P", 1) as u8;
    let kind = Kind::from_u32(env("VC_KIND", Kind::Sawmill as u32)).unwrap();
    let mut g = Game::new(env("VC_SEED", 4), 1, 2);
    g.set_ai(1, true);
    for a in g.ais.iter_mut() {
        a.next_attack = 1.0e9;
    }
    run(&mut g, env("VC_MINUTES", 20) as f32 * 60.0);
    for e in g.ents.iter().filter(|e| e.alive && e.owner == me && e.kind == kind) {
        let workers = g.ents.iter().filter(|w| w.alive && (w.order == Order::Work(e.id) || w.order == Order::Build(e.id))).count();
        println!("{kind:?} #{} at {},{} built {:.2} crewed {} hired {} hiring {} fed {} builders_in {} workers/builders ordered {}", e.id, e.tx, e.ty, e.built, e.crewed, e.hired, e.hiring, e.fed, e.builders_in, workers);
    }
    let p = &g.players[me as usize];
    println!("free workers {} people {} beds {}", p.free, p.people, p.beds);
    let (cx, cy) = g.campfire(me).unwrap();
    let reach = g.reach_for_tests(cx, cy);
    println!("tiles reachable from the campfire: {} of {}", reach.iter().filter(|&&b| b).count(), reach.len());
}

#[test]
#[ignore]
fn diag_army() {
    let env = |k: &str, d: u32| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
    let me = env("VC_P", 1) as u8;
    let mut g = Game::new(env("VC_SEED", 16), 1, 2);
    g.set_ai(1, true);
    for a in g.ais.iter_mut() {
        a.next_attack = 1.0e9;
    }
    run(&mut g, env("VC_MINUTES", 50) as f32 * 60.0);
    let home = g.campfire(me).unwrap();
    let mut by: std::collections::BTreeMap<String, (u32, u32)> = Default::default();
    for e in g.ents.iter().filter(|e| e.alive && e.owner == me && !e.is_building() && e.kind.is_military()) {
        let t = by.entry(format!("{:?}", e.kind)).or_default();
        t.0 += 1;
        t.1 += ((e.x - home.0).hypot(e.y - home.1) < 30.0) as u32;
    }
    println!("soldiers {} (kind: total, near home) {by:?}", g.players[me as usize].soldiers);
    let iron_users: Vec<String> = g.ents.iter().filter(|e| e.alive && e.owner == me && e.kind.stats().cost.iter().any(|&(r, _)| r == Res::Iron)).map(|e| format!("{:?}", e.kind)).collect();
    let mut cnt: std::collections::BTreeMap<String, u32> = Default::default();
    for k in iron_users { *cnt.entry(k).or_default() += 1; }
    println!("holding iron: {cnt:?}");
}
