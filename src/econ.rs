//! An economy calculator: the fewest buildings a player needs for a goal,
//! worked out from the tables in defs.rs. Nothing in the game runs this;
//! the tests use it to check the numbers (no building type should be
//! needed more than `MAX_SAME` times), and the AI could plan with it.
//!
//! The goal is a missile silo with a nuke armed: the Atomic era, which
//! takes `HOUSES_FOR_ERA` houses full at the Modern tier (apartments, with
//! their 11 goods each) grown into tower blocks, a uranium mine (the silo
//! needs one), the silo and its nuke.
//!
//! How: everything that stands holds slots, producers make them, and
//! producers hold slots too. Starting from the goal's own needs, keep
//! adding the producers that are short until nothing is (a fixed point).
//! Which goods the houses take is a choice, so every choice is tried.

#![allow(dead_code)]

use crate::defs::*;

/// What a plan needs, kind by kind, and the people to run it.
#[derive(Clone, Debug)]
pub struct Plan {
    /// (kind, how many), in `Kind::ALL` order.
    pub counts: Vec<(Kind, u32)>,
    /// Workers at producers (and the silo's builders, who stay on as nobody).
    pub workers: u32,
    /// Beds the houses give with the chosen goods.
    pub beds: u32,
    /// The goods the houses take.
    pub goods: Vec<Res>,
}

impl Plan {
    pub fn count(&self, k: Kind) -> u32 {
        self.counts.iter().find(|&&(q, _)| q == k).map_or(0, |&(_, n)| n)
    }
    pub fn buildings(&self) -> u32 {
        self.counts.iter().map(|&(_, n)| n).sum()
    }
    /// The most of any one kind, not counting fields (farms) and houses.
    pub fn most_of_one(&self) -> (Kind, u32) {
        self.counts.iter().copied().filter(|&(k, _)| capped(k)).max_by_key(|&(_, n)| n).unwrap_or((Kind::Farm, 0))
    }
}

/// Kinds that count toward the "no more than seven of one" rule.
pub fn capped(k: Kind) -> bool {
    k.is_building() && k != Kind::Farm && k.house_tier().is_none() && k != Kind::Capitol
}

/// The producer used for each resource: the one that makes the most of it
/// among those of `era` or earlier. Where two are worth comparing
/// (electricity, nitrate), `alt` picks the later one instead.
fn producer(r: Res, alt: bool, era: u8) -> Option<Kind> {
    let makes = |k: Kind| k.stats().produces.iter().find(|&&(q, _)| q == r).map_or(0, |&(_, a)| a);
    let found: Vec<Kind> = Kind::ALL.iter().copied().filter(|&k| k.is_building() && makes(k) > 0 && k.house_tier().is_none() && k != Kind::Capitol && k.era() <= era).collect();
    if matches!(r, Res::Electricity | Res::Nitrate) && found.len() > 1 {
        return Some(if alt { found[1] } else { found[0] });
    }
    found.into_iter().max_by_key(|&k| (makes(k), std::cmp::Reverse(k.era())))
}

/// The fewest buildings for the goal, trying every set of house goods.
/// `houses` houses of `tier` (full, with as many goods as that tier uses),
/// which then grow into `house` (whose materials they hold), plus `extra`.
pub fn plan(houses: u32, tier: u8, house: Kind, extra: &[Kind], extra_slots: Slots, era: u8) -> Plan {
    let n_goods = house_max_goods(tier) as usize;
    let goods: Vec<Res> = Res::ALL.iter().copied().filter(|r| r.is_house_good() && r.era() <= tier).collect();
    let mut best: Option<Plan> = None;
    // Every subset of `goods` with `n_goods` members (bit masks).
    for mask in 0u32..(1 << goods.len()) {
        if mask.count_ones() as usize != n_goods.min(goods.len()) {
            continue;
        }
        let chosen: Vec<Res> = goods.iter().enumerate().filter(|(i, _)| mask >> i & 1 == 1).map(|(_, &r)| r).collect();
        for alts in 0..4u32 {
            if let Some(p) = solve(houses, house, &chosen, extra, extra_slots, alts, era) {
                let better = match &best {
                    None => true,
                    Some(b) => (p.most_of_one().1, p.buildings()) < (b.most_of_one().1, b.buildings()),
                };
                if better {
                    best = Some(p);
                }
            }
        }
    }
    best.expect("some plan works")
}

/// The fixed point for one choice of goods. `alts` bit 0: the reactor for
/// electricity; bit 1: Haber–Bosch for nitrate.
/// `era` is the player's: which producers they can build.
fn solve(houses: u32, house: Kind, goods: &[Res], extra: &[Kind], extra_slots: Slots, alts: u32, era: u8) -> Option<Plan> {
    let mut count = [0u32; 128];
    let need_kind = |count: &mut [u32; 128], k: Kind| {
        let i = k as usize;
        count[i] = count[i].max(1);
    };
    count[house as usize] = houses;
    for &k in extra {
        count[k as usize] += 1;
    }
    let mut fixed_need = [0u32; N_RES];
    for &(r, n) in extra_slots {
        fixed_need[r.idx()] += n as u32;
    }
    for &g in goods {
        fixed_need[g.idx()] += houses;
    }
    let alt = |r: Res| match r {
        Res::Electricity => alts & 1 != 0,
        Res::Nitrate => alts & 2 != 0,
        _ => false,
    };
    for _ in 0..200 {
        // Everything required by what's in the plan is in it too.
        for k in Kind::ALL {
            if count[k as usize] > 0 {
                for &q in k.requires() {
                    need_kind(&mut count, q);
                }
            }
        }
        let mut need = fixed_need;
        let mut have = [0u32; N_RES];
        for &(r, n) in Kind::Capitol.stats().produces {
            have[r.idx()] += n as u32;
        }
        for k in Kind::ALL {
            let n = count[k as usize];
            let st = k.stats();
            for &(r, a) in st.cost.iter().chain(st.consumes) {
                need[r.idx()] += a as u32 * n;
            }
            for &(r, a) in st.produces {
                if k != Kind::Capitol && k.house_tier().is_none() {
                    have[r.idx()] += a as u32 * n;
                }
            }
        }
        let mut changed = false;
        for r in Res::ALL {
            if need[r.idx()] > have[r.idx()] {
                let k = producer(r, alt(r), era)?;
                let per = k.stats().produces.iter().find(|&&(q, _)| q == r).map_or(1, |&(_, a)| a as u32);
                count[k as usize] += (need[r.idx()] - have[r.idx()]).div_ceil(per);
                changed = true;
            }
        }
        if !changed {
            let counts: Vec<(Kind, u32)> = Kind::ALL.iter().map(|&k| (k, count[k as usize])).filter(|&(_, n)| n > 0).collect();
            let workers = counts.iter().map(|&(k, n)| k.stats().workers as u32 * n).sum();
            let beds = houses * beds_for(goods.len() as u32) as u32;
            return Some(Plan { counts, workers, beds, goods: goods.to_vec() });
        }
    }
    None
}

/// The goal the tests check: the Atomic era, a uranium mine, a silo and
/// an armed nuke.
pub fn silo_plan() -> Plan {
    plan(HOUSES_FOR_ERA, 4, Kind::TowerBlock, &[Kind::UraniumMine, Kind::MissileSilo], NUKE_COST, 5)
}

/// The house goal for each era: `HOUSES_FOR_ERA` full houses of the tier
/// before it, grown into the next, with what the era before can build.
pub fn era_plan(era: u8) -> Plan {
    let tiers = [Kind::Hut, Kind::Cottage, Kind::Townhouse, Kind::Tenement, Kind::Apartment, Kind::TowerBlock];
    plan(HOUSES_FOR_ERA, era - 1, tiers[era as usize], &[], &[], era - 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn show(name: &str, p: &Plan) {
        println!("{name}: {} buildings, {} workers, {} beds, goods {:?}", p.buildings(), p.workers, p.beds, p.goods);
        for &(k, n) in &p.counts {
            println!("  {k:?} {n}");
        }
    }

    /// `cargo test --release econ -- --nocapture` prints the plans.
    #[test]
    fn a_silo_needs_at_most_seven_of_any_building() {
        for era in 1..=5 {
            let p = era_plan(era);
            show(&format!("era {era}"), &p);
            let (k, n) = p.most_of_one();
            assert!(n <= MAX_SAME as u32, "era {era} takes {n} {k:?}");
            assert!(p.workers <= p.beds, "era {era} takes {} workers but there are {} beds", p.workers, p.beds);
        }
        let p = silo_plan();
        show("silo", &p);
        let (k, n) = p.most_of_one();
        assert!(n <= MAX_SAME as u32, "a silo takes {n} {k:?}");
        assert!(p.workers <= p.beds, "a silo takes {} workers but there are {} beds", p.workers, p.beds);
    }
}
