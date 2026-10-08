//! Property test without extra crates: a seeded xorshift drives 300 random
//! sequences of attest / restate / declare / mark_gaps / rotate / countersign /
//! advance_time. Invariants are checked after every step.

extern crate std;

use super::test::{at, counts, GRACE, MASK_MON_FRI, START_DAY};
use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::symbol_short;
use std::collections::{BTreeMap, BTreeSet};
use std::vec::Vec as StdVec;

struct XorShift(u64);
impl XorShift {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

struct Model {
    written: BTreeMap<(u32, u32), Attestation>,
    declared: BTreeSet<u32>,
    epoch: u32,
    /// (epoch, from, to) intervals of each epoch's activity
    epoch_from: StdVec<u64>,
}

fn check_invariants(env: &Env, client: &ReconRegistryClient, m: &Model) {
    // 1. no (day, version) changes once written
    for ((d, v), a) in m.written.iter() {
        assert_eq!(client.get(d, v).as_ref(), Some(a), "entry {d}/{v} changed");
    }
    // 2. Head.seq equals the total number of versions
    let (seq, hash) = client.head();
    assert_eq!(seq as usize, m.written.len());
    // 3. recomputing the chain from stored entries yields Head.hash
    let mut by_seq: StdVec<&Attestation> = m.written.values().collect();
    by_seq.sort_by_key(|a| a.seq);
    let mut prev = BytesN::from_array(env, &[0u8; 32]);
    for (i, a) in by_seq.iter().enumerate() {
        assert_eq!(a.seq as usize, i + 1);
        let h = entry_hash(
            env,
            &prev,
            a.day,
            a.version,
            &a.root,
            &a.counts,
            a.shortfall,
            &a.report_hash,
            a.signer_epoch,
            a.attested_at,
            a.late,
            a.reason,
        );
        assert_eq!(h, a.entry_hash);
        prev = h;
    }
    assert_eq!(prev, hash);
    // 5. every entry's signer_epoch was the active epoch at attested_at
    for a in m.written.values() {
        let e = a.signer_epoch as usize;
        assert!(m.epoch_from[e] <= a.attested_at);
        if e + 1 < m.epoch_from.len() {
            assert!(a.attested_at <= m.epoch_from[e + 1]);
        }
    }
}

fn run_sequence(seed: u64, steps: usize) {
    let mut rng = XorShift(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    // 300 sequences: no snapshot per Env (they would add ~40 MB of JSON).
    let env = Env::new_with_config(soroban_sdk::testutils::EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.mock_all_auths();
    let t0 = at(START_DAY, 8 * 3600);
    env.ledger().set_timestamp(t0);
    let id = env.register(ReconRegistry, ());
    let client = ReconRegistryClient::new(&env, &id);
    let admin = Address::generate(&env);
    let signer = Address::generate(&env);
    client.init(
        &admin,
        &signer,
        &START_DAY,
        &MASK_MON_FRI,
        &GRACE,
        &symbol_short!("EUR"),
        &2,
        &String::from_str(&env, "sim-anchor.example"),
    );
    let mut m = Model {
        written: BTreeMap::new(),
        declared: BTreeSet::new(),
        epoch: 0,
        epoch_from: std::vec![t0],
    };
    let mut auditors: StdVec<Address> = StdVec::new();

    for _ in 0..steps {
        let now = env.ledger().timestamp();
        let today = (now / SECS_PER_DAY) as u32;
        let span = today - START_DAY + 2;
        match rng.below(8) {
            0 | 1 => {
                let day = START_DAY + rng.below(span as u64) as u32;
                let sf = if rng.below(5) == 0 { rng.below(1_000_000) as i128 } else { 0 };
                let root = BytesN::from_array(&env, &[rng.below(256) as u8; 32]);
                let r = client.try_attest(&day, &root, &counts(), &sf, &root);
                let expect_ok = day <= today && !m.written.contains_key(&(day, 0));
                assert_eq!(r.is_ok(), expect_ok, "attest {day}");
                if let Ok(Ok(a)) = r {
                    assert_eq!(a.signer_epoch, m.epoch);
                    assert_eq!(a.late, now > deadline(day, GRACE));
                    m.written.insert((day, 0), a);
                }
            }
            2 => {
                let attested: StdVec<u32> = m.written.keys().filter(|k| k.1 == 0).map(|k| k.0).collect();
                if attested.is_empty() {
                    continue;
                }
                let day = attested[rng.below(attested.len() as u64) as usize];
                let reason = 1 + rng.below(4) as u32;
                let root = BytesN::from_array(&env, &[7u8; 32]);
                let n = client.versions(&day);
                let r = client.try_restate(&day, &root, &counts(), &0, &root, &reason);
                if n >= MAX_VERSIONS {
                    assert_eq!(r, Err(Ok(Error::TooManyVersions)));
                } else {
                    let v = r.unwrap().unwrap();
                    assert_eq!(v, n);
                    m.written.insert((day, v), client.get(&day, &v).unwrap());
                }
            }
            3 => {
                let day = START_DAY + rng.below(span as u64 + 3) as u32;
                let r = client.try_declare_non_recon_day(&day, &NONRECON_OTHER);
                if r.is_ok() {
                    assert!(is_expected(MASK_MON_FRI, day));
                    assert!(now < deadline(day, GRACE));
                    assert!(!m.written.contains_key(&(day, 0)));
                    m.declared.insert(day);
                }
            }
            4 => {
                let before: BTreeSet<u32> = client
                    .gaps(&START_DAY, &(START_DAY + MAX_SCAN - 1))
                    .iter()
                    .collect();
                let up_to = START_DAY + rng.below(span as u64 + 5) as u32;
                let n = client.mark_gaps(&up_to);
                let after: BTreeSet<u32> = client
                    .gaps(&START_DAY, &(START_DAY + MAX_SCAN - 1))
                    .iter()
                    .collect();
                let new: StdVec<&u32> = after.difference(&before).collect();
                assert_eq!(new.len() as u32, n);
                // 4. a gap only on an expected, non-declared day past its deadline with no attestation
                for d in new {
                    assert!(is_expected(MASK_MON_FRI, *d));
                    assert!(!m.declared.contains(d));
                    assert!(now > deadline(*d, GRACE));
                    assert!(!m.written.contains_key(&(*d, 0)));
                }
                // a second call at the same time is a no-op
                assert_eq!(client.mark_gaps(&up_to), 0);
            }
            5 => {
                if rng.below(3) != 0 {
                    continue;
                }
                let new = Address::generate(&env);
                let reason = if rng.below(2) == 0 { ROTATE_SCHEDULED } else { ROTATE_COMPROMISE };
                let e = client.rotate_signer(&new, &reason, &now.saturating_sub(rng.below(86_400 * 3)));
                m.epoch = e;
                m.epoch_from.push(now);
            }
            6 => {
                if m.written.is_empty() {
                    continue;
                }
                let keys: StdVec<(u32, u32)> = m.written.keys().cloned().collect();
                let (d, v) = keys[rng.below(keys.len() as u64) as usize];
                if auditors.is_empty() || rng.below(3) == 0 {
                    let a = Address::generate(&env);
                    client.set_auditor(&a, &true);
                    auditors.push(a);
                }
                let a = &auditors[rng.below(auditors.len() as u64) as usize];
                let before = client.countersigs(&d, &v).len();
                let r = client.try_countersign(a, &d, &v, &(1 + rng.below(3) as u32), &BytesN::from_array(&env, &[1; 32]));
                let after = client.countersigs(&d, &v).len();
                assert_eq!(after, before + r.is_ok() as u32);
                assert!(after <= MAX_COSIGS);
            }
            _ => {
                let dt = 3600 + rng.below(3 * SECS_PER_DAY);
                env.ledger().set_timestamp(now + dt);
            }
        }
        check_invariants(&env, &client, &m);
    }
}

#[test]
fn property_random_sequences_preserve_invariants() {
    for seed in 1..=300u64 {
        run_sequence(seed, 40);
    }
}
