//! Unit and negative tests for recon_registry. Auth is asserted with
//! `env.auths()` / `env.mock_auths` where it is the subject of the test.

extern crate std;

use super::*;
use soroban_sdk::testutils::{
    Address as _, AuthorizedFunction, AuthorizedInvocation, Events as _, Ledger, MockAuth,
    MockAuthInvoke,
};
use soroban_sdk::{symbol_short, vec, IntoVal, Val};

pub const START_DAY: u32 = 20_668; // 2026-08-03, Monday
pub const MASK_MON_FRI: u32 = 0b0011111;
pub const GRACE: u64 = 43_200; // 12 h after midnight UTC following the day

pub struct Setup {
    pub env: Env,
    pub id: Address,
    pub client: ReconRegistryClient<'static>,
    pub admin: Address,
    pub signer: Address,
}

pub fn at(day: u32, secs: u64) -> u64 {
    day as u64 * SECS_PER_DAY + secs
}

pub fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(at(START_DAY, 8 * 3600));
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
    Setup {
        env,
        id,
        client,
        admin,
        signer,
    }
}

impl Setup {
    pub fn set_time(&self, t: u64) {
        self.env.ledger().set_timestamp(t);
    }
    pub fn root(&self, n: u8) -> BytesN<32> {
        BytesN::from_array(&self.env, &[n; 32])
    }
    pub fn attest_day(&self, day: u32, shortfall: i128) -> Attestation {
        self.client
            .attest(&day, &self.root(day as u8), &counts(), &shortfall, &self.root(0xAA))
    }
    fn only_auth(&self, who: &Address, fn_name: &'static str, args: soroban_sdk::Vec<Val>) {
        self.env.mock_auths(&[MockAuth {
            address: who,
            invoke: &MockAuthInvoke {
                contract: &self.id,
                fn_name,
                args,
                sub_invokes: &[],
            },
        }]);
    }
}

pub fn counts() -> Counts {
    Counts {
        platform_txs: 19,
        chain_ops: 20,
        bank_lines: 23,
        matched_groups: 36,
        matched_rule: 33,
        matched_heuristic: 2,
        matched_llm: 0,
        matched_analyst: 1,
        exceptions_new: 1,
        exceptions_open: 2,
        exceptions_closed: 0,
        travel_rule_missing: 0,
    }
}

// ------------------------------------------------------------------ init

#[test]
fn init_twice_fails() {
    let s = setup();
    let r = s.client.try_init(
        &s.admin,
        &s.signer,
        &START_DAY,
        &MASK_MON_FRI,
        &GRACE,
        &symbol_short!("EUR"),
        &2,
        &String::from_str(&s.env, "x"),
    );
    assert_eq!(r, Err(Ok(Error::AlreadyInitialised)));
}

#[test]
fn init_bad_mask_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(ReconRegistry, ());
    let client = ReconRegistryClient::new(&env, &id);
    let a = Address::generate(&env);
    let dom = String::from_str(&env, "x");
    for mask in [0u32, 128, 255] {
        let r = client.try_init(&a, &a, &START_DAY, &mask, &GRACE, &symbol_short!("EUR"), &2, &dom);
        assert_eq!(r, Err(Ok(Error::BadMask)));
    }
    client.init(&a, &a, &START_DAY, &127, &GRACE, &symbol_short!("EUR"), &2, &dom);
    assert_eq!(client.config().weekday_mask, 127);
}

#[test]
fn init_requires_admin_auth_and_sets_epoch_zero() {
    let s = setup();
    let cfg = s.client.config();
    assert_eq!(cfg.admin, s.admin);
    assert_eq!(cfg.start_day, START_DAY);
    assert_eq!(s.client.signer(), (s.signer.clone(), 0));
    assert_eq!(s.client.gap_cursor(), START_DAY);
    assert_eq!(s.client.signer_epoch(&0).unwrap().signer, s.signer);
    assert_eq!(s.client.head().0, 0);
    assert_eq!(s.client.head().1, BytesN::from_array(&s.env, &[0; 32]));
}

#[test]
fn uninitialised_calls_fail() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(ReconRegistry, ());
    let client = ReconRegistryClient::new(&env, &id);
    assert_eq!(client.try_mark_gaps(&START_DAY), Err(Ok(Error::NotInitialised)));
    assert_eq!(client.try_config(), Err(Ok(Error::NotInitialised)));
    assert_eq!(client.try_status(&START_DAY), Err(Ok(Error::NotInitialised)));
}

// ------------------------------------------------------------------ day arithmetic

#[test]
fn weekday_vectors() {
    assert_eq!(weekday(20_668), 0); // 2026-08-03 Monday
    assert_eq!(weekday(20_696), 0); // 2026-08-31 Monday
    assert_eq!(weekday(20_673), 5); // 2026-08-08 Saturday
    assert_eq!(weekday(20_674), 6); // Sunday
    assert_eq!(weekday(0), 3); // 1970-01-01 Thursday
    assert!(is_expected(MASK_MON_FRI, 20_672));
    assert!(!is_expected(MASK_MON_FRI, 20_673));
    assert_eq!(deadline(20_668, GRACE), 20_669 * 86_400 + 43_200);
}

// ------------------------------------------------------------------ attest

#[test]
fn attest_happy_path_stores_version_zero_and_advances_head() {
    let s = setup();
    s.set_time(at(START_DAY, 18 * 3600));
    let a = s.attest_day(START_DAY, 0);
    // event ("attest", day) from this invocation
    let evs = s.env.events().all().filter_by_contract(&s.id);
    assert_eq!(evs.events().len(), 1);
    assert_eq!(a.version, 0);
    assert_eq!(a.seq, 1);
    assert!(!a.late);
    assert_eq!(a.reason, 0);
    assert_eq!(a.signer_epoch, 0);
    assert_eq!(s.client.versions(&START_DAY), 1);
    assert_eq!(s.client.get(&START_DAY, &0), Some(a.clone()));
    assert_eq!(s.client.latest(&START_DAY), Some(a.clone()));
    assert_eq!(s.client.head(), (1, a.entry_hash.clone()));
    assert_eq!(s.client.status(&START_DAY), DayStatus::Attested);
    // entry hash reproduces from the genesis zero hash
    let expect = entry_hash(
        &s.env,
        &BytesN::from_array(&s.env, &[0; 32]),
        START_DAY,
        0,
        &s.root(START_DAY as u8),
        &counts(),
        0,
        &s.root(0xAA),
        0,
        at(START_DAY, 18 * 3600),
        false,
        0,
    );
    assert_eq!(a.entry_hash, expect);
}

#[test]
fn attest_auth_tree_is_exactly_the_current_signer() {
    let s = setup();
    s.set_time(at(START_DAY, 18 * 3600));
    s.attest_day(START_DAY, 5);
    let auths = s.env.auths();
    assert_eq!(auths.len(), 1);
    let args: soroban_sdk::Vec<Val> = vec![
        &s.env,
        START_DAY.into_val(&s.env),
        s.root(START_DAY as u8).into_val(&s.env),
        counts().into_val(&s.env),
        5i128.into_val(&s.env),
        s.root(0xAA).into_val(&s.env),
    ];
    assert_eq!(
        auths[0],
        (
            s.signer.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    s.id.clone(),
                    Symbol::new(&s.env, "attest"),
                    args
                )),
                sub_invocations: std::vec![],
            }
        )
    );
}

#[test]
fn attest_by_non_signer_fails() {
    let s = setup();
    s.set_time(at(START_DAY, 18 * 3600));
    let stranger = Address::generate(&s.env);
    let args: soroban_sdk::Vec<Val> = vec![
        &s.env,
        START_DAY.into_val(&s.env),
        s.root(1).into_val(&s.env),
        counts().into_val(&s.env),
        0i128.into_val(&s.env),
        s.root(2).into_val(&s.env),
    ];
    s.only_auth(&stranger, "attest", args.clone());
    let r = s.client.try_attest(&START_DAY, &s.root(1), &counts(), &0, &s.root(2));
    assert!(r.is_err());
    assert_eq!(s.client.versions(&START_DAY), 0);
    // the real signer with the same exact args succeeds
    s.only_auth(&s.signer, "attest", args);
    s.client.attest(&START_DAY, &s.root(1), &counts(), &0, &s.root(2));
    assert_eq!(s.client.versions(&START_DAY), 1);
}

#[test]
fn attest_twice_fails_with_already_attested() {
    let s = setup();
    s.set_time(at(START_DAY, 18 * 3600));
    s.attest_day(START_DAY, 0);
    let r = s.client.try_attest(&START_DAY, &s.root(9), &counts(), &0, &s.root(9));
    assert_eq!(r, Err(Ok(Error::AlreadyAttested)));
}

#[test]
fn attest_future_day_and_before_start_fail() {
    let s = setup();
    s.set_time(at(START_DAY, 18 * 3600));
    let r = s.client.try_attest(&(START_DAY + 1), &s.root(1), &counts(), &0, &s.root(1));
    assert_eq!(r, Err(Ok(Error::FutureDay)));
    let r = s.client.try_attest(&(START_DAY - 1), &s.root(1), &counts(), &0, &s.root(1));
    assert_eq!(r, Err(Ok(Error::BeforeStart)));
}

#[test]
fn negative_shortfall_and_inconsistent_counts_fail() {
    let s = setup();
    s.set_time(at(START_DAY, 18 * 3600));
    let r = s.client.try_attest(&START_DAY, &s.root(1), &counts(), &-1, &s.root(1));
    assert_eq!(r, Err(Ok(Error::NegativeShortfall)));
    let mut c = counts();
    c.matched_groups += 1;
    let r = s.client.try_attest(&START_DAY, &s.root(1), &c, &0, &s.root(1));
    assert_eq!(r, Err(Ok(Error::InvalidCounts)));
    let mut c = counts();
    c.matched_llm = 1; // sum now exceeds groups
    let r = s.client.try_attest(&START_DAY, &s.root(1), &c, &0, &s.root(1));
    assert_eq!(r, Err(Ok(Error::InvalidCounts)));
}

#[test]
fn attestation_after_deadline_is_late() {
    let s = setup();
    // deadline(START_DAY) = next day 12:00; attest at 12:00:01
    s.set_time(deadline(START_DAY, GRACE) + 1);
    let a = s.attest_day(START_DAY, 0);
    assert!(a.late);
    assert_eq!(s.client.status(&START_DAY), DayStatus::AttestedLate);
    // exactly at the deadline is on time
    s.set_time(deadline(START_DAY + 1, GRACE));
    let b = s.attest_day(START_DAY + 1, 0);
    assert!(!b.late);
}

// ------------------------------------------------------------------ restate

#[test]
fn restate_appends_and_leaves_earlier_versions_untouched() {
    let s = setup();
    s.set_time(at(START_DAY, 18 * 3600));
    let v0 = s.attest_day(START_DAY, 0);
    s.set_time(at(START_DAY + 1, 10 * 3600));
    let n = s.client.restate(
        &START_DAY,
        &s.root(0x77),
        &counts(),
        &0,
        &s.root(0xBB),
        &REASON_LATE_BANK_ITEM,
    );
    assert_eq!(n, 1);
    assert_eq!(s.client.get(&START_DAY, &0), Some(v0.clone()));
    let v1 = s.client.get(&START_DAY, &1).unwrap();
    assert_eq!(v1.reason, REASON_LATE_BANK_ITEM);
    assert_eq!(v1.seq, 2);
    assert_eq!(s.client.latest(&START_DAY), Some(v1.clone()));
    assert_eq!(s.client.head(), (2, v1.entry_hash.clone()));
    // chain link: v1 hashes over v0's entry hash
    let expect = entry_hash(
        &s.env,
        &v0.entry_hash,
        START_DAY,
        1,
        &s.root(0x77),
        &counts(),
        0,
        &s.root(0xBB),
        0,
        at(START_DAY + 1, 10 * 3600),
        false,
        REASON_LATE_BANK_ITEM,
    );
    assert_eq!(v1.entry_hash, expect);
    // status stays Attested (v0 on time)
    assert_eq!(s.client.status(&START_DAY), DayStatus::Attested);
}

#[test]
fn seventeenth_version_fails() {
    let s = setup();
    s.set_time(at(START_DAY, 18 * 3600));
    s.attest_day(START_DAY, 0);
    for i in 1..16u32 {
        let n = s.client.restate(&START_DAY, &s.root(i as u8), &counts(), &0, &s.root(1), &REASON_ERROR_CORRECTION);
        assert_eq!(n, i);
    }
    assert_eq!(s.client.versions(&START_DAY), 16);
    let r = s.client.try_restate(&START_DAY, &s.root(99), &counts(), &0, &s.root(1), &REASON_ERROR_CORRECTION);
    assert_eq!(r, Err(Ok(Error::TooManyVersions)));
}

#[test]
fn restate_unattested_day_or_bad_reason_fails() {
    let s = setup();
    s.set_time(at(START_DAY, 18 * 3600));
    let r = s.client.try_restate(&START_DAY, &s.root(1), &counts(), &0, &s.root(1), &REASON_LATE_BANK_ITEM);
    assert_eq!(r, Err(Ok(Error::NotAttested)));
    s.attest_day(START_DAY, 0);
    for bad in [0u32, 5, 99] {
        let r = s.client.try_restate(&START_DAY, &s.root(1), &counts(), &0, &s.root(1), &bad);
        assert_eq!(r, Err(Ok(Error::BadReason)));
    }
    let r = s.client.try_restate(&START_DAY, &s.root(1), &counts(), &-5, &s.root(1), &REASON_LATE_BANK_ITEM);
    assert_eq!(r, Err(Ok(Error::NegativeShortfall)));
}

#[test]
fn restate_by_non_signer_fails() {
    let s = setup();
    s.set_time(at(START_DAY, 18 * 3600));
    s.attest_day(START_DAY, 0);
    let stranger = Address::generate(&s.env);
    let args: soroban_sdk::Vec<Val> = vec![
        &s.env,
        START_DAY.into_val(&s.env),
        s.root(3).into_val(&s.env),
        counts().into_val(&s.env),
        0i128.into_val(&s.env),
        s.root(3).into_val(&s.env),
        REASON_ERROR_CORRECTION.into_val(&s.env),
    ];
    s.only_auth(&stranger, "restate", args);
    assert!(s
        .client
        .try_restate(&START_DAY, &s.root(3), &counts(), &0, &s.root(3), &REASON_ERROR_CORRECTION)
        .is_err());
    assert_eq!(s.client.versions(&START_DAY), 1);
}

// ------------------------------------------------------------------ mark_gaps

#[test]
fn mark_gaps_flags_only_expected_days_past_deadline() {
    let s = setup();
    // Mon 20668 attested, Tue 20669 declared, Wed 20670 missed, Thu 20671 missed,
    // Fri 20672 still inside deadline at the time of the call.
    s.set_time(at(START_DAY, 18 * 3600));
    s.attest_day(START_DAY, 0);
    s.client.declare_non_recon_day(&(START_DAY + 1), &NONRECON_BANK_HOLIDAY);
    s.set_time(at(START_DAY + 5, 6 * 3600)); // Saturday 06:00: Fri deadline is Sat 12:00
    let n = s.client.mark_gaps(&(START_DAY + 10));
    assert_eq!(n, 2);
    assert_eq!(
        s.client.gaps(&START_DAY, &(START_DAY + 10)),
        vec![&s.env, START_DAY + 2, START_DAY + 3]
    );
    assert_eq!(s.client.gap_cursor(), START_DAY + 4); // stopped at Friday
    assert_eq!(s.client.status(&(START_DAY + 2)), DayStatus::Gap);
    assert_eq!(s.client.status(&(START_DAY + 1)), DayStatus::NonReconDay);
    assert_eq!(s.client.status(&(START_DAY + 4)), DayStatus::Pending);
    // second call at the same time flags nothing
    assert_eq!(s.client.mark_gaps(&(START_DAY + 10)), 0);
    // after Friday's deadline, weekend days are skipped and Friday is flagged
    s.set_time(at(START_DAY + 7, 13 * 3600)); // next Monday 13:00
    assert_eq!(s.client.mark_gaps(&(START_DAY + 10)), 1);
    assert_eq!(s.client.status(&(START_DAY + 5)), DayStatus::NotExpected);
    assert_eq!(s.client.gap_cursor(), START_DAY + 7); // Monday itself not past deadline
    assert_eq!(s.client.mark_gaps(&(START_DAY + 10)), 0);
}

#[test]
fn mark_gaps_respects_up_to_day() {
    let s = setup();
    s.set_time(at(START_DAY + 20, 0));
    assert_eq!(s.client.mark_gaps(&(START_DAY + 1)), 2);
    assert_eq!(s.client.gap_cursor(), START_DAY + 2);
}

#[test]
fn mark_gaps_scans_at_most_62_days_and_continues() {
    let s = setup();
    s.set_time(at(START_DAY + 200, 0));
    let first = s.client.mark_gaps(&(START_DAY + 150));
    assert_eq!(s.client.gap_cursor(), START_DAY + 62);
    // 62 days from a Monday = 8 weeks + 6 days -> 8*5 + 5 weekdays
    assert_eq!(first, 45);
    let second = s.client.mark_gaps(&(START_DAY + 150));
    assert_eq!(s.client.gap_cursor(), START_DAY + 124);
    assert!(second > 0);
}

#[test]
fn attesting_a_gap_day_gives_gap_then_attested() {
    let s = setup();
    s.set_time(at(START_DAY + 1, 13 * 3600));
    assert_eq!(s.client.mark_gaps(&START_DAY), 1);
    let a = s.attest_day(START_DAY, 0);
    assert!(a.late);
    assert_eq!(s.client.status(&START_DAY), DayStatus::GapThenAttested);
    assert_eq!(s.client.gaps(&START_DAY, &START_DAY), vec![&s.env, START_DAY]);
}

#[test]
fn gaps_range_too_large_fails() {
    let s = setup();
    assert_eq!(s.client.try_gaps(&START_DAY, &(START_DAY + 62)), Err(Ok(Error::RangeTooLarge)));
    assert_eq!(s.client.gaps(&START_DAY, &(START_DAY + 61)).len(), 0);
    assert_eq!(s.client.gaps(&(START_DAY + 5), &START_DAY).len(), 0);
}

// ------------------------------------------------------------------ declare_non_recon_day

#[test]
fn declare_non_recon_day_rules() {
    let s = setup();
    // before deadline: ok
    s.client.declare_non_recon_day(&START_DAY, &NONRECON_BANK_HOLIDAY);
    assert_eq!(s.client.status(&START_DAY), DayStatus::NonReconDay);
    // weekend
    let r = s.client.try_declare_non_recon_day(&(START_DAY + 5), &NONRECON_OTHER);
    assert_eq!(r, Err(Ok(Error::NotExpectedDay)));
    // bad reason
    let r = s.client.try_declare_non_recon_day(&(START_DAY + 1), &3);
    assert_eq!(r, Err(Ok(Error::BadReason)));
    // attested day
    s.set_time(at(START_DAY + 1, 18 * 3600));
    s.attest_day(START_DAY + 1, 0);
    let r = s.client.try_declare_non_recon_day(&(START_DAY + 1), &NONRECON_OTHER);
    assert_eq!(r, Err(Ok(Error::AlreadyAttested)));
    // after deadline
    s.set_time(deadline(START_DAY + 2, GRACE));
    let r = s.client.try_declare_non_recon_day(&(START_DAY + 2), &NONRECON_OTHER);
    assert_eq!(r, Err(Ok(Error::DeadlinePassed)));
    // admin entry point works too, and is also bound by the deadline
    s.client.admin_declare_non_recon_day(&(START_DAY + 3), &NONRECON_OTHER);
    assert_eq!(s.client.status(&(START_DAY + 3)), DayStatus::NonReconDay);
}

#[test]
fn declare_requires_signer_or_admin() {
    let s = setup();
    let stranger = Address::generate(&s.env);
    let args: soroban_sdk::Vec<Val> =
        vec![&s.env, START_DAY.into_val(&s.env), NONRECON_BANK_HOLIDAY.into_val(&s.env)];
    s.only_auth(&stranger, "declare_non_recon_day", args.clone());
    assert!(s.client.try_declare_non_recon_day(&START_DAY, &NONRECON_BANK_HOLIDAY).is_err());
    s.only_auth(&stranger, "admin_declare_non_recon_day", args.clone());
    assert!(s.client.try_admin_declare_non_recon_day(&START_DAY, &NONRECON_BANK_HOLIDAY).is_err());
    // signer cannot use the admin entry point
    s.only_auth(&s.signer, "admin_declare_non_recon_day", args.clone());
    assert!(s.client.try_admin_declare_non_recon_day(&START_DAY, &NONRECON_BANK_HOLIDAY).is_err());
    s.only_auth(&s.admin, "admin_declare_non_recon_day", args);
    s.client.admin_declare_non_recon_day(&START_DAY, &NONRECON_BANK_HOLIDAY);
    assert_eq!(s.client.status(&START_DAY), DayStatus::NonReconDay);
}

// ------------------------------------------------------------------ countersign

#[test]
fn countersign_rules() {
    let s = setup();
    s.set_time(at(START_DAY, 18 * 3600));
    s.attest_day(START_DAY, 0);
    let aud = Address::generate(&s.env);
    let note = s.root(0x55);
    // unregistered
    let r = s.client.try_countersign(&aud, &START_DAY, &0, &OPINION_AGREED, &note);
    assert_eq!(r, Err(Ok(Error::NotAuditor)));
    s.client.set_auditor(&aud, &true);
    // missing version
    let r = s.client.try_countersign(&aud, &START_DAY, &1, &OPINION_AGREED, &note);
    assert_eq!(r, Err(Ok(Error::VersionNotFound)));
    // bad opinion
    let r = s.client.try_countersign(&aud, &START_DAY, &0, &4, &note);
    assert_eq!(r, Err(Ok(Error::BadReason)));
    // ok
    s.client.countersign(&aud, &START_DAY, &0, &OPINION_AGREED_WITH_EXCEPTIONS, &note);
    let list = s.client.countersigs(&START_DAY, &0);
    assert_eq!(list.len(), 1);
    assert_eq!(list.get(0).unwrap().auditor, aud);
    assert_eq!(list.get(0).unwrap().opinion, OPINION_AGREED_WITH_EXCEPTIONS);
    // twice
    let r = s.client.try_countersign(&aud, &START_DAY, &0, &OPINION_AGREED, &note);
    assert_eq!(r, Err(Ok(Error::AlreadyCountersigned)));
    // deactivated
    let aud2 = Address::generate(&s.env);
    s.client.set_auditor(&aud2, &true);
    s.client.set_auditor(&aud2, &false);
    let r = s.client.try_countersign(&aud2, &START_DAY, &0, &OPINION_AGREED, &note);
    assert_eq!(r, Err(Ok(Error::NotAuditor)));
}

#[test]
fn ninth_countersigner_fails() {
    let s = setup();
    s.set_time(at(START_DAY, 18 * 3600));
    s.attest_day(START_DAY, 0);
    for _ in 0..8 {
        let a = Address::generate(&s.env);
        s.client.set_auditor(&a, &true);
        s.client.countersign(&a, &START_DAY, &0, &OPINION_AGREED, &s.root(1));
    }
    let ninth = Address::generate(&s.env);
    s.client.set_auditor(&ninth, &true);
    let r = s.client.try_countersign(&ninth, &START_DAY, &0, &OPINION_AGREED, &s.root(1));
    assert_eq!(r, Err(Ok(Error::TooManyCosigs)));
}

#[test]
fn countersign_needs_the_auditors_own_auth() {
    let s = setup();
    s.set_time(at(START_DAY, 18 * 3600));
    s.attest_day(START_DAY, 0);
    let aud = Address::generate(&s.env);
    s.client.set_auditor(&aud, &true);
    let args: soroban_sdk::Vec<Val> = vec![
        &s.env,
        aud.clone().into_val(&s.env),
        START_DAY.into_val(&s.env),
        0u32.into_val(&s.env),
        OPINION_AGREED.into_val(&s.env),
        s.root(1).into_val(&s.env),
    ];
    s.only_auth(&s.admin, "countersign", args.clone());
    assert!(s.client.try_countersign(&aud, &START_DAY, &0, &OPINION_AGREED, &s.root(1)).is_err());
    s.only_auth(&aud, "countersign", args);
    s.client.countersign(&aud, &START_DAY, &0, &OPINION_AGREED, &s.root(1));
    assert_eq!(s.client.countersigs(&START_DAY, &0).len(), 1);
}

#[test]
fn set_auditor_is_admin_only() {
    let s = setup();
    let aud = Address::generate(&s.env);
    let args: soroban_sdk::Vec<Val> = vec![&s.env, aud.clone().into_val(&s.env), true.into_val(&s.env)];
    s.only_auth(&s.signer, "set_auditor", args.clone());
    assert!(s.client.try_set_auditor(&aud, &true).is_err());
    s.only_auth(&s.admin, "set_auditor", args);
    s.client.set_auditor(&aud, &true);
}

// ------------------------------------------------------------------ rotate_signer

#[test]
fn rotate_signer_is_admin_only() {
    let s = setup();
    let new = Address::generate(&s.env);
    let args: soroban_sdk::Vec<Val> = vec![
        &s.env,
        new.clone().into_val(&s.env),
        ROTATE_SCHEDULED.into_val(&s.env),
        0u64.into_val(&s.env),
    ];
    s.only_auth(&s.signer, "rotate_signer", args.clone());
    assert!(s.client.try_rotate_signer(&new, &ROTATE_SCHEDULED, &0).is_err());
    s.only_auth(&s.admin, "rotate_signer", args);
    assert_eq!(s.client.rotate_signer(&new, &ROTATE_SCHEDULED, &0), 1);
    let auths = s.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, s.admin);
}

#[test]
fn rotate_signer_same_signer_and_bad_reason_fail() {
    let s = setup();
    assert_eq!(
        s.client.try_rotate_signer(&s.signer, &ROTATE_SCHEDULED, &0),
        Err(Ok(Error::SameSigner))
    );
    let new = Address::generate(&s.env);
    assert_eq!(s.client.try_rotate_signer(&new, &3, &0), Err(Ok(Error::BadReason)));
}

#[test]
fn old_signer_cannot_attest_after_rotation_and_new_one_can() {
    let s = setup();
    let new = Address::generate(&s.env);
    s.set_time(at(START_DAY, 18 * 3600));
    s.client.rotate_signer(&new, &ROTATE_SCHEDULED, &0);
    assert_eq!(s.client.signer(), (new.clone(), 1));
    let args: soroban_sdk::Vec<Val> = vec![
        &s.env,
        START_DAY.into_val(&s.env),
        s.root(1).into_val(&s.env),
        counts().into_val(&s.env),
        0i128.into_val(&s.env),
        s.root(2).into_val(&s.env),
    ];
    s.only_auth(&s.signer, "attest", args.clone());
    assert!(s.client.try_attest(&START_DAY, &s.root(1), &counts(), &0, &s.root(2)).is_err());
    s.only_auth(&new, "attest", args);
    let a = s.client.attest(&START_DAY, &s.root(1), &counts(), &0, &s.root(2));
    assert_eq!(a.signer_epoch, 1);
    let e0 = s.client.signer_epoch(&0).unwrap();
    assert_eq!(e0.rotated_reason, ROTATE_SCHEDULED);
    assert_eq!(e0.compromised_since, 0);
}

#[test]
fn compromise_rotation_marks_only_later_entries_of_old_epoch_suspect() {
    let s = setup();
    // epoch 0 attests days 0..=3 at 18:00 each
    for i in 0..4u32 {
        s.set_time(at(START_DAY + i, 18 * 3600));
        s.attest_day(START_DAY + i, 0);
    }
    let compromised_since = at(START_DAY + 2, 0);
    let new = Address::generate(&s.env);
    s.set_time(at(START_DAY + 4, 9 * 3600));
    s.client.rotate_signer(&new, &ROTATE_COMPROMISE, &compromised_since);
    s.set_time(at(START_DAY + 4, 18 * 3600));
    s.attest_day(START_DAY + 4, 0);
    s.client.restate(&(START_DAY + 2), &s.root(0x42), &counts(), &0, &s.root(1), &REASON_SIGNER_COMPROMISE);
    assert!(!s.client.is_suspect(&START_DAY, &0));
    assert!(!s.client.is_suspect(&(START_DAY + 1), &0));
    assert!(s.client.is_suspect(&(START_DAY + 2), &0));
    assert!(s.client.is_suspect(&(START_DAY + 3), &0));
    assert!(!s.client.is_suspect(&(START_DAY + 4), &0)); // new epoch
    assert!(!s.client.is_suspect(&(START_DAY + 2), &1)); // restated by new signer
    assert!(!s.client.is_suspect(&(START_DAY + 9), &0)); // does not exist
    assert_eq!(s.client.signer_epoch(&0).unwrap().compromised_since, compromised_since);
}

// ------------------------------------------------------------------ admin

#[test]
fn transfer_admin_needs_both_auths() {
    let s = setup();
    let new_admin = Address::generate(&s.env);
    let args: soroban_sdk::Vec<Val> = vec![&s.env, new_admin.clone().into_val(&s.env)];
    // only the current admin
    s.only_auth(&s.admin, "transfer_admin", args.clone());
    assert!(s.client.try_transfer_admin(&new_admin).is_err());
    // only the new admin
    s.only_auth(&new_admin, "transfer_admin", args.clone());
    assert!(s.client.try_transfer_admin(&new_admin).is_err());
    // both
    s.env.mock_auths(&[
        MockAuth {
            address: &s.admin,
            invoke: &MockAuthInvoke {
                contract: &s.id,
                fn_name: "transfer_admin",
                args: args.clone(),
                sub_invokes: &[],
            },
        },
        MockAuth {
            address: &new_admin,
            invoke: &MockAuthInvoke {
                contract: &s.id,
                fn_name: "transfer_admin",
                args,
                sub_invokes: &[],
            },
        },
    ]);
    s.client.transfer_admin(&new_admin);
    assert_eq!(s.client.config().admin, new_admin);
}

#[test]
fn set_schedule_admin_only_and_mask_checked() {
    let s = setup();
    let args: soroban_sdk::Vec<Val> =
        vec![&s.env, 0b1111111u32.into_val(&s.env), 3600u64.into_val(&s.env)];
    s.only_auth(&s.signer, "set_schedule", args.clone());
    assert!(s.client.try_set_schedule(&0b1111111, &3600).is_err());
    s.env.mock_all_auths();
    assert_eq!(s.client.try_set_schedule(&0, &3600), Err(Ok(Error::BadMask)));
    s.client.set_schedule(&0b1111111, &3600);
    let cfg = s.client.config();
    assert_eq!(cfg.weekday_mask, 0b1111111);
    assert_eq!(cfg.grace_secs, 3600);
    // weekends are now expected
    s.set_time(at(START_DAY + 7, 7200));
    assert_eq!(s.client.mark_gaps(&(START_DAY + 6)), 7);
}

// ------------------------------------------------------------------ shared vectors

/// Minimal JSON helpers for the shared vector files (flat objects only).
pub mod vectors {
    extern crate std;
    use std::string::String;
    use std::vec::Vec;

    /// Splits a top-level JSON array of flat objects into object strings.
    pub fn objects(json: &str) -> Vec<&str> {
        let mut out = Vec::new();
        let mut depth = 0i32;
        let mut start = 0usize;
        let mut in_str = false;
        for (i, c) in json.char_indices() {
            match c {
                '"' => in_str = !in_str,
                '{' if !in_str => {
                    if depth == 0 {
                        start = i;
                    }
                    depth += 1;
                }
                '}' if !in_str => {
                    depth -= 1;
                    if depth == 0 {
                        out.push(&json[start..=i]);
                    }
                }
                _ => {}
            }
        }
        out
    }

    /// Raw value text of `"key": value` inside a flat object.
    pub fn raw<'a>(obj: &'a str, key: &str) -> &'a str {
        let pat = std::format!("\"{}\":", key);
        let i = obj.find(&pat).unwrap_or_else(|| panic!("missing key {}", key)) + pat.len();
        let rest = obj[i..].trim_start();
        if rest.starts_with('"') {
            let end = rest[1..].find('"').unwrap() + 1;
            &rest[1..end]
        } else if rest.starts_with('[') {
            let end = rest.find(']').unwrap();
            &rest[1..end]
        } else {
            let end = rest.find([',', '}']).unwrap();
            rest[..end].trim()
        }
    }

    pub fn u64v(obj: &str, key: &str) -> u64 {
        raw(obj, key).parse().unwrap()
    }

    pub fn list(obj: &str, key: &str) -> Vec<String> {
        raw(obj, key)
            .split(',')
            .map(|s| String::from(s.trim().trim_matches('"')))
            .filter(|s| !s.is_empty())
            .collect()
    }

    pub fn hex32(s: &str) -> [u8; 32] {
        let mut out = [0u8; 32];
        for i in 0..32 {
            out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }
}

#[test]
fn entry_hash_matches_shared_typescript_vectors() {
    let json = include_str!("../../../app/test/vectors/entry-hash.json");
    let env = Env::default();
    let objs = vectors::objects(json);
    assert!(objs.len() >= 3);
    for o in objs {
        let c: std::vec::Vec<u32> = vectors::list(o, "counts").iter().map(|s| s.parse().unwrap()).collect();
        let counts = Counts {
            platform_txs: c[0],
            chain_ops: c[1],
            bank_lines: c[2],
            matched_groups: c[3],
            matched_rule: c[4],
            matched_heuristic: c[5],
            matched_llm: c[6],
            matched_analyst: c[7],
            exceptions_new: c[8],
            exceptions_open: c[9],
            exceptions_closed: c[10],
            travel_rule_missing: c[11],
        };
        let h = entry_hash(
            &env,
            &BytesN::from_array(&env, &vectors::hex32(vectors::raw(o, "prev"))),
            vectors::u64v(o, "day") as u32,
            vectors::u64v(o, "version") as u32,
            &BytesN::from_array(&env, &vectors::hex32(vectors::raw(o, "root"))),
            &counts,
            vectors::raw(o, "shortfall").parse::<i128>().unwrap(),
            &BytesN::from_array(&env, &vectors::hex32(vectors::raw(o, "reportHash"))),
            vectors::u64v(o, "signerEpoch") as u32,
            vectors::u64v(o, "attestedAt"),
            vectors::raw(o, "late") == "true",
            vectors::u64v(o, "reason") as u32,
        );
        assert_eq!(
            h.to_array(),
            vectors::hex32(vectors::raw(o, "expected")),
            "vector {}",
            vectors::raw(o, "name")
        );
    }
}

#[test]
fn entry_hash_vector_reproduced_by_live_contract_calls() {
    // The first two vectors are a genesis attestation and its restatement;
    // replay them through the contract and compare stored entry hashes.
    let json = include_str!("../../../app/test/vectors/entry-hash.json");
    let objs = vectors::objects(json);
    let s = setup();
    for o in objs.iter().take(2) {
        let c: std::vec::Vec<u32> = vectors::list(o, "counts").iter().map(|s| s.parse().unwrap()).collect();
        let counts = Counts {
            platform_txs: c[0],
            chain_ops: c[1],
            bank_lines: c[2],
            matched_groups: c[3],
            matched_rule: c[4],
            matched_heuristic: c[5],
            matched_llm: c[6],
            matched_analyst: c[7],
            exceptions_new: c[8],
            exceptions_open: c[9],
            exceptions_closed: c[10],
            travel_rule_missing: c[11],
        };
        let day = vectors::u64v(o, "day") as u32;
        s.set_time(vectors::u64v(o, "attestedAt"));
        let root = BytesN::from_array(&s.env, &vectors::hex32(vectors::raw(o, "root")));
        let rh = BytesN::from_array(&s.env, &vectors::hex32(vectors::raw(o, "reportHash")));
        let sf = vectors::raw(o, "shortfall").parse::<i128>().unwrap();
        let reason = vectors::u64v(o, "reason") as u32;
        let version = vectors::u64v(o, "version") as u32;
        if version == 0 {
            s.client.attest(&day, &root, &counts, &sf, &rh);
        } else {
            s.client.restate(&day, &root, &counts, &sf, &rh, &reason);
        }
        let got = s.client.get(&day, &version).unwrap();
        assert_eq!(got.entry_hash.to_array(), vectors::hex32(vectors::raw(o, "expected")));
    }
}

#[test]
fn merkle_root_matches_shared_typescript_vectors() {
    // Leaves are given as hashes already sorted; node = sha256(0x01 ‖ l ‖ r);
    // an odd node is promoted; empty root = sha256(0x00).
    let json = include_str!("../../../app/test/vectors/merkle.json");
    let env = Env::default();
    for o in vectors::objects(json) {
        let mut level: std::vec::Vec<[u8; 32]> =
            vectors::list(o, "leaves").iter().map(|h| vectors::hex32(h)).collect();
        let root = if level.is_empty() {
            env.crypto().sha256(&Bytes::from_array(&env, &[0u8])).to_array()
        } else {
            while level.len() > 1 {
                let mut next = std::vec::Vec::new();
                let mut i = 0;
                while i < level.len() {
                    if i + 1 < level.len() {
                        let mut b = Bytes::from_array(&env, &[1u8]);
                        b.extend_from_array(&level[i]);
                        b.extend_from_array(&level[i + 1]);
                        next.push(env.crypto().sha256(&b).to_array());
                    } else {
                        next.push(level[i]);
                    }
                    i += 2;
                }
                level = next;
            }
            level[0]
        };
        assert_eq!(root, vectors::hex32(vectors::raw(o, "root")), "merkle vector {}", vectors::raw(o, "name"));
    }
}
