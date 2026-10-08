//! scenario_month_of_reconciliation: the seed's registry plan
//! (data/seed/registry-plan.json) mirrored as constants.
//!
//! 2026-08-03 (day 20668) .. 2026-09-01 (day 20697), Monday-Friday expected,
//! 2026-08-31 declared a bank holiday, 2026-08-12 restated on 08-13
//! (LATE_BANK_ITEM), scheduled signer rotation on 08-14, 2026-08-20 missed and
//! flagged as a gap on 08-21 then attested late, 08-18 shortfall 341250 cents,
//! auditor countersigns 08-28 on 09-01.

extern crate std;

use super::test::{at, counts, GRACE, MASK_MON_FRI};
use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{symbol_short, vec};

const D_0803: u32 = 20_668;
const D_0812: u32 = 20_677;
const D_0814: u32 = 20_679;
const D_0818: u32 = 20_683;
const D_0819: u32 = 20_684;
const D_0820: u32 = 20_685;
const D_0821: u32 = 20_686;
const D_0828: u32 = 20_693;
const D_0831: u32 = 20_696;
const D_0901: u32 = 20_697;
const SHORTFALL_0818: i128 = 341_250;

fn root_for(env: &Env, day: u32, version: u8) -> BytesN<32> {
    let mut a = [0u8; 32];
    a[0..4].copy_from_slice(&day.to_be_bytes());
    a[4] = version;
    BytesN::from_array(env, &a)
}

#[test]
fn scenario_month_of_reconciliation() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(at(D_0803, 7 * 3600));
    let id = env.register(ReconRegistry, ());
    let client = ReconRegistryClient::new(&env, &id);
    let admin = Address::generate(&env);
    let signer0 = Address::generate(&env);
    let signer1 = Address::generate(&env);
    let auditor = Address::generate(&env);
    client.init(
        &admin,
        &signer0,
        &D_0803,
        &MASK_MON_FRI,
        &GRACE,
        &symbol_short!("EUR"),
        &2,
        &String::from_str(&env, "sim-anchor.example"),
    );
    let report = BytesN::from_array(&env, &[0xAB; 32]);
    let mut attested = 0u32;

    for day in D_0803..=D_0901 {
        // 1. declare 2026-08-31 on Friday 08-28 before attesting 08-28
        if day == D_0828 {
            env.ledger().set_timestamp(at(D_0828, 17 * 3600));
            client.declare_non_recon_day(&D_0831, &NONRECON_BANK_HOLIDAY);
        }
        // 2. restate 08-12 on the morning of 08-13 (late Bank B line)
        if day == D_0812 + 1 {
            env.ledger().set_timestamp(at(day, 10 * 3600));
            let v = client.restate(
                &D_0812,
                &root_for(&env, D_0812, 1),
                &counts(),
                &0,
                &report,
                &REASON_LATE_BANK_ITEM,
            );
            assert_eq!(v, 1);
        }
        // 2. scheduled rotation on the morning of 08-14
        if day == D_0814 {
            env.ledger().set_timestamp(at(day, 8 * 3600));
            assert_eq!(client.rotate_signer(&signer1, &ROTATE_SCHEDULED, &0), 1);
        }
        // 3. 08-21: anyone runs mark_gaps at 13:00, then 08-20 is attested late
        if day == D_0821 {
            env.ledger().set_timestamp(at(day, 13 * 3600));
            assert_eq!(client.mark_gaps(&D_0821), 1);
            assert_eq!(client.status(&D_0820), DayStatus::Gap);
            env.ledger().set_timestamp(at(day, 16 * 3600));
            let late = client.attest(&D_0820, &root_for(&env, D_0820, 0), &counts(), &0, &report);
            assert!(late.late);
            assert_eq!(client.status(&D_0820), DayStatus::GapThenAttested);
            attested += 1;
        }
        // 5. auditor registered and countersigns 08-28 on 09-01
        if day == D_0901 {
            env.ledger().set_timestamp(at(day, 10 * 3600));
            client.set_auditor(&auditor, &true);
            client.countersign(&auditor, &D_0828, &0, &OPINION_AGREED, &BytesN::from_array(&env, &[0xCD; 32]));
        }
        let expected = is_expected(MASK_MON_FRI, day);
        if !expected || day == D_0820 || day == D_0831 {
            continue;
        }
        env.ledger().set_timestamp(at(day, 18 * 3600));
        // 4. shortfall on 08-18, cleared by the top-up on 08-19
        let sf = if day == D_0818 { SHORTFALL_0818 } else { 0 };
        let a = client.attest(&day, &root_for(&env, day, 0), &counts(), &sf, &report);
        assert!(!a.late);
        assert_eq!(a.signer_epoch, if day >= D_0814 { 1 } else { 0 });
        attested += 1;
    }

    // 6. final checks
    env.ledger().set_timestamp(at(D_0901, 20 * 3600));
    assert_eq!(client.mark_gaps(&D_0901), 0);
    assert_eq!(attested, 21);
    let (seq, head_hash) = client.head();
    assert_eq!(seq, 22); // 21 originals + 1 restatement
    assert_eq!(client.gaps(&D_0803, &D_0901), vec![&env, D_0820]);
    assert_eq!(client.latest(&D_0901).unwrap().entry_hash, head_hash);
    assert_eq!(client.get(&D_0818, &0).unwrap().shortfall, SHORTFALL_0818);
    assert_eq!(client.get(&D_0819, &0).unwrap().shortfall, 0);
    assert_eq!(client.versions(&D_0812), 2);
    assert_eq!(client.get(&D_0812, &1).unwrap().reason, REASON_LATE_BANK_ITEM);
    let cs = client.countersigs(&D_0828, &0);
    assert_eq!(cs.len(), 1);
    assert_eq!(cs.get(0).unwrap().auditor, auditor);
    assert_eq!(cs.get(0).unwrap().opinion, OPINION_AGREED);
    assert_eq!(client.signer(), (signer1, 1));
    assert_eq!(client.signer_epoch(&0).unwrap().rotated_reason, ROTATE_SCHEDULED);
    for day in D_0803..=D_0901 {
        let st = client.status(&day);
        let want = if day == D_0820 {
            DayStatus::GapThenAttested
        } else if day == D_0831 {
            DayStatus::NonReconDay
        } else if !is_expected(MASK_MON_FRI, day) {
            DayStatus::NotExpected
        } else {
            DayStatus::Attested
        };
        assert_eq!(st, want, "day {day}");
        assert!(!client.is_suspect(&day, &0));
    }
}
