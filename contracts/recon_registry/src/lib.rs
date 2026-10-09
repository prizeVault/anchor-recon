//! # recon_registry
//!
//! Append-only registry of an anchor's daily reconciliation attestations,
//! one instance per anchor and safeguarding currency.
//!
//! What it records per reconciliation day: a Merkle root over the salted,
//! canonical matched-and-exception set, public counts, the safeguarding
//! shortfall, the hash of the approved daily report, the signer epoch and the
//! ledger time. Corrections are new versions (`restate`), never overwrites.
//! Anyone can flag a missed day after its deadline (`mark_gaps`). An auditor
//! can countersign a version. Signer rotation history lives next to the
//! attestations, and a compromise rotation marks later entries as suspect.
//!
//! What it deliberately does not do: hold tokens or funds, delete anything,
//! let the admin override an attestation, or check that a root is "correct".
//! Only the holder of the day's pack can check the root.
//!
//! Honest scope note: the same guarantees are mostly available from a signed
//! file on the anchor's website plus an RFC 3161 timestamp or a transparency
//! log. This contract adds a ledger timestamp the anchor cannot backdate,
//! visible restatements, a permissionless missed-day flag and one place for
//! countersignatures and signer history.
//!
//! Day arithmetic: `day` = whole days since 1970-01-01 UTC;
//! `weekday(day) = (day + 3) % 7` with Monday = 0; bit `1 << weekday` of
//! `weekday_mask` marks an expected reconciliation day; the deadline for day
//! `d` is `(d + 1) * 86400 + grace_secs`.

#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Bytes, BytesN,
    Env, String, Symbol, Vec,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

pub const SECS_PER_DAY: u64 = 86_400; // seconds in a day: u64 = 86_400;
/// Maximum days scanned by one `mark_gaps` call and maximum `gaps` range.
pub const MAX_SCAN: u32 = 62;
/// Maximum versions (original + restatements) per day.
pub const MAX_VERSIONS: u32 = 16;
/// Maximum countersignatures per (day, version).
pub const MAX_COSIGS: u32 = 8;

pub const REASON_LATE_BANK_ITEM: u32 = 1;
pub const REASON_ERROR_CORRECTION: u32 = 2;
pub const REASON_SIGNER_COMPROMISE: u32 = 3;
pub const REASON_AUDITOR_ADJUSTMENT: u32 = 4;

pub const NONRECON_BANK_HOLIDAY: u32 = 1;
pub const NONRECON_OTHER: u32 = 2;

pub const ROTATE_SCHEDULED: u32 = 1;
pub const ROTATE_COMPROMISE: u32 = 2;

pub const OPINION_AGREED: u32 = 1;
pub const OPINION_AGREED_WITH_EXCEPTIONS: u32 = 2;
pub const OPINION_DISAGREED: u32 = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub start_day: u32,
    pub weekday_mask: u32,
    pub grace_secs: u64,
    pub currency: Symbol,
    pub decimals: u32,
    pub home_domain: String,
}

/// Public counts for a reconciliation day. Field order is part of the entry
/// hash and must not change.
#[contracttype]
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Counts {
    pub platform_txs: u32,
    pub chain_ops: u32,
    pub bank_lines: u32,
    pub matched_groups: u32,
    pub matched_rule: u32,
    pub matched_heuristic: u32,
    pub matched_llm: u32,
    pub matched_analyst: u32,
    pub exceptions_new: u32,
    pub exceptions_open: u32,
    pub exceptions_closed: u32,
    pub travel_rule_missing: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Attestation {
    pub day: u32,
    pub version: u32,
    pub root: BytesN<32>,
    pub counts: Counts,
    pub shortfall: i128,
    pub report_hash: BytesN<32>,
    pub signer_epoch: u32,
    pub attested_at: u64,
    pub late: bool,
    /// 0 for an original, a restatement code otherwise.
    pub reason: u32,
    pub seq: u64,
    pub entry_hash: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Countersig {
    pub auditor: Address,
    pub opinion: u32,
    pub note_hash: BytesN<32>,
    pub at: u64,
}

/// One signer epoch. `rotated_reason` is 0 while the epoch is current.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignerEpoch {
    pub signer: Address,
    pub from: u64,
    pub rotated_reason: u32,
    pub compromised_since: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Head {
    pub seq: u64,
    pub hash: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DayStatus {
    NotExpected,
    NonReconDay,
    Pending,
    Attested,
    AttestedLate,
    Gap,
    GapThenAttested,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    // instance
    Config,
    Signer,
    Epoch,
    Head,
    GapCursor,
    // persistent
    Att(u32, u32),
    Versions(u32),
    Gap(u32),
    NonRecon(u32),
    Auditor(Address),
    Cosigs(u32, u32),
    SignerHist(u32),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialised = 1,
    NotInitialised = 2,
    BeforeStart = 3,
    FutureDay = 4,
    AlreadyAttested = 5,
    NotAttested = 6,
    TooManyVersions = 7,
    NegativeShortfall = 8,
    InvalidCounts = 9,
    NotAuditor = 10,
    AlreadyCountersigned = 11,
    TooManyCosigs = 12,
    DeadlinePassed = 13,
    NotExpectedDay = 14,
    BadReason = 15,
    SameSigner = 16,
    BadMask = 17,
    VersionNotFound = 18,
    RangeTooLarge = 19,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[contractevent(topics = ["attest"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttestEvent {
    #[topic]
    pub day: u32,
    pub version: u32,
    pub root: BytesN<32>,
    pub shortfall: i128,
    pub late: bool,
    pub seq: u64,
    pub entry_hash: BytesN<32>,
}

#[contractevent(topics = ["restate"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RestateEvent {
    #[topic]
    pub day: u32,
    pub version: u32,
    pub reason: u32,
    pub entry_hash: BytesN<32>,
}

#[contractevent(topics = ["cosign"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CosignEvent {
    #[topic]
    pub day: u32,
    pub version: u32,
    pub auditor: Address,
    pub opinion: u32,
}

#[contractevent(topics = ["gap"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GapEvent {
    #[topic]
    pub day: u32,
}

#[contractevent(topics = ["nonrecon"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NonReconEvent {
    #[topic]
    pub day: u32,
    pub reason: u32,
}

#[contractevent(topics = ["rotate"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RotateEvent {
    #[topic]
    pub epoch: u32,
    pub new_signer: Address,
    pub reason: u32,
}

#[contractevent(topics = ["auditor"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuditorEvent {
    #[topic]
    pub auditor: Address,
    pub active: bool,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Monday = 0 ... Sunday = 6. 1970-01-01 was a Thursday.
pub fn weekday(day: u32) -> u32 {
    (day + 3) % 7
}

pub fn is_expected(mask: u32, day: u32) -> bool {
    mask & (1 << weekday(day)) != 0
}

pub fn deadline(day: u32, grace_secs: u64) -> u64 {
    (day as u64 + 1) * SECS_PER_DAY + grace_secs
}

fn bump_instance(env: &Env) {
    let max = env.storage().max_ttl();
    env.storage().instance().extend_ttl(max / 2, max);
}

fn put<V: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(env: &Env, key: &DataKey, val: &V) {
    let max = env.storage().max_ttl();
    env.storage().persistent().set(key, val);
    env.storage().persistent().extend_ttl(key, max / 2, max);
}

fn config(env: &Env) -> Result<Config, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(Error::NotInitialised)
}

fn current_signer(env: &Env) -> Result<(Address, u32), Error> {
    let s: Address = env
        .storage()
        .instance()
        .get(&DataKey::Signer)
        .ok_or(Error::NotInitialised)?;
    let e: u32 = env.storage().instance().get(&DataKey::Epoch).unwrap_or(0);
    Ok((s, e))
}

fn head(env: &Env) -> Head {
    env.storage().instance().get(&DataKey::Head).unwrap_or(Head {
        seq: 0,
        hash: BytesN::from_array(env, &[0u8; 32]),
    })
}

fn versions_of(env: &Env, day: u32) -> u32 {
    env.storage()
        .persistent()
        .get(&DataKey::Versions(day))
        .unwrap_or(0)
}

fn validate(counts: &Counts, shortfall: i128) -> Result<(), Error> {
    if shortfall < 0 {
        return Err(Error::NegativeShortfall);
    }
    let sum = counts.matched_rule as u64
        + counts.matched_heuristic as u64
        + counts.matched_llm as u64
        + counts.matched_analyst as u64;
    if sum != counts.matched_groups as u64 {
        return Err(Error::InvalidCounts);
    }
    Ok(())
}

/// `sha256(prev ‖ day ‖ version ‖ root ‖ counts… ‖ shortfall ‖ report_hash ‖
/// signer_epoch ‖ attested_at ‖ late ‖ reason)`, all integers big-endian.
#[allow(clippy::too_many_arguments)]
pub fn entry_hash(
    env: &Env,
    prev: &BytesN<32>,
    day: u32,
    version: u32,
    root: &BytesN<32>,
    counts: &Counts,
    shortfall: i128,
    report_hash: &BytesN<32>,
    signer_epoch: u32,
    attested_at: u64,
    late: bool,
    reason: u32,
) -> BytesN<32> {
    let mut b = Bytes::new(env);
    b.extend_from_array(&prev.to_array());
    b.extend_from_array(&day.to_be_bytes());
    b.extend_from_array(&version.to_be_bytes());
    b.extend_from_array(&root.to_array());
    for v in [
        counts.platform_txs,
        counts.chain_ops,
        counts.bank_lines,
        counts.matched_groups,
        counts.matched_rule,
        counts.matched_heuristic,
        counts.matched_llm,
        counts.matched_analyst,
        counts.exceptions_new,
        counts.exceptions_open,
        counts.exceptions_closed,
        counts.travel_rule_missing,
    ] {
        b.extend_from_array(&v.to_be_bytes());
    }
    b.extend_from_array(&shortfall.to_be_bytes());
    b.extend_from_array(&report_hash.to_array());
    b.extend_from_array(&signer_epoch.to_be_bytes());
    b.extend_from_array(&attested_at.to_be_bytes());
    b.extend_from_array(&[late as u8]);
    b.extend_from_array(&reason.to_be_bytes());
    env.crypto().sha256(&b).to_bytes()
}

/// Appends one version for `day` and advances the hash chain.
#[allow(clippy::too_many_arguments)]
fn append(
    env: &Env,
    cfg: &Config,
    day: u32,
    version: u32,
    root: BytesN<32>,
    counts: Counts,
    shortfall: i128,
    report_hash: BytesN<32>,
    epoch: u32,
    reason: u32,
) -> Attestation {
    let now = env.ledger().timestamp();
    let late = now > deadline(day, cfg.grace_secs);
    let h = head(env);
    let hash = entry_hash(
        env,
        &h.hash,
        day,
        version,
        &root,
        &counts,
        shortfall,
        &report_hash,
        epoch,
        now,
        late,
        reason,
    );
    let seq = h.seq + 1;
    let att = Attestation {
        day,
        version,
        root,
        counts,
        shortfall,
        report_hash,
        signer_epoch: epoch,
        attested_at: now,
        late,
        reason,
        seq,
        entry_hash: hash.clone(),
    };
    put(env, &DataKey::Att(day, version), &att);
    put(env, &DataKey::Versions(day), &(version + 1));
    env.storage().instance().set(&DataKey::Head, &Head { seq, hash });
    bump_instance(env);
    att
}

fn check_mask(mask: u32) -> Result<(), Error> {
    if mask == 0 || mask >= 128 {
        return Err(Error::BadMask);
    }
    Ok(())
}

fn declare_inner(env: &Env, day: u32, reason: u32) -> Result<(), Error> {
    let cfg = config(env)?;
    if reason != NONRECON_BANK_HOLIDAY && reason != NONRECON_OTHER {
        return Err(Error::BadReason);
    }
    if day < cfg.start_day {
        return Err(Error::BeforeStart);
    }
    if !is_expected(cfg.weekday_mask, day) {
        return Err(Error::NotExpectedDay);
    }
    if env.ledger().timestamp() >= deadline(day, cfg.grace_secs) {
        return Err(Error::DeadlinePassed);
    }
    if versions_of(env, day) > 0 {
        return Err(Error::AlreadyAttested);
    }
    put(env, &DataKey::NonRecon(day), &reason);
    bump_instance(env);
    NonReconEvent { day, reason }.publish(env);
    Ok(())
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct ReconRegistry;

#[contractimpl]
impl ReconRegistry {
    /// One-time setup. Sets signer epoch 0 and the gap cursor to `start_day`.
    #[allow(clippy::too_many_arguments)]
    pub fn init(
        env: Env,
        admin: Address,
        signer: Address,
        start_day: u32,
        weekday_mask: u32,
        grace_secs: u64,
        currency: Symbol,
        decimals: u32,
        home_domain: String,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(Error::AlreadyInitialised);
        }
        admin.require_auth();
        check_mask(weekday_mask)?;
        let cfg = Config {
            admin,
            start_day,
            weekday_mask,
            grace_secs,
            currency,
            decimals,
            home_domain,
        };
        let now = env.ledger().timestamp();
        env.storage().instance().set(&DataKey::Config, &cfg);
        env.storage().instance().set(&DataKey::Signer, &signer);
        env.storage().instance().set(&DataKey::Epoch, &0u32);
        env.storage().instance().set(&DataKey::GapCursor, &start_day);
        put(
            &env,
            &DataKey::SignerHist(0),
            &SignerEpoch {
                signer,
                from: now,
                rotated_reason: 0,
                compromised_since: 0,
            },
        );
        bump_instance(&env);
        Ok(())
    }

    /// Original attestation of `day` (version 0) by the current signer.
    pub fn attest(
        env: Env,
        day: u32,
        root: BytesN<32>,
        counts: Counts,
        shortfall: i128,
        report_hash: BytesN<32>,
    ) -> Result<Attestation, Error> {
        let cfg = config(&env)?;
        let (signer, epoch) = current_signer(&env)?;
        signer.require_auth();
        if day < cfg.start_day {
            return Err(Error::BeforeStart);
        }
        if day as u64 > env.ledger().timestamp() / SECS_PER_DAY {
            return Err(Error::FutureDay);
        }
        if env.storage().persistent().has(&DataKey::Versions(day)) {
            return Err(Error::AlreadyAttested);
        }
        validate(&counts, shortfall)?;
        let att = append(
            &env, &cfg, day, 0, root, counts, shortfall, report_hash, epoch, 0,
        );
        AttestEvent {
            day,
            version: 0,
            root: att.root.clone(),
            shortfall,
            late: att.late,
            seq: att.seq,
            entry_hash: att.entry_hash.clone(),
        }
        .publish(&env);
        Ok(att)
    }

    /// Appends a restatement of an attested day. Earlier versions are never
    /// modified. Returns the new version number.
    #[allow(clippy::too_many_arguments)]
    pub fn restate(
        env: Env,
        day: u32,
        root: BytesN<32>,
        counts: Counts,
        shortfall: i128,
        report_hash: BytesN<32>,
        reason: u32,
    ) -> Result<u32, Error> {
        let cfg = config(&env)?;
        let (signer, epoch) = current_signer(&env)?;
        signer.require_auth();
        let n = versions_of(&env, day);
        if n == 0 {
            return Err(Error::NotAttested);
        }
        if !(REASON_LATE_BANK_ITEM..=REASON_AUDITOR_ADJUSTMENT).contains(&reason) {
            return Err(Error::BadReason);
        }
        validate(&counts, shortfall)?;
        if n >= MAX_VERSIONS {
            return Err(Error::TooManyVersions);
        }
        let att = append(
            &env, &cfg, day, n, root, counts, shortfall, report_hash, epoch, reason,
        );
        RestateEvent {
            day,
            version: n,
            reason,
            entry_hash: att.entry_hash,
        }
        .publish(&env);
        Ok(n)
    }

    /// Signer declares an expected day a non-reconciliation day (before its deadline).
    pub fn declare_non_recon_day(env: Env, day: u32, reason: u32) -> Result<(), Error> {
        let (signer, _) = current_signer(&env)?;
        signer.require_auth();
        declare_inner(&env, day, reason)
    }

    /// Admin variant of `declare_non_recon_day`.
    pub fn admin_declare_non_recon_day(env: Env, day: u32, reason: u32) -> Result<(), Error> {
        let cfg = config(&env)?;
        cfg.admin.require_auth();
        declare_inner(&env, day, reason)
    }

    /// Permissionless. Flags expected, undeclared, unattested days whose
    /// deadline has passed, scanning at most 62 days from the gap cursor.
    /// Stops (without advancing) at the first day still inside its deadline.
    pub fn mark_gaps(env: Env, up_to_day: u32) -> Result<u32, Error> {
        let cfg = config(&env)?;
        let now = env.ledger().timestamp();
        let mut d: u32 = env
            .storage()
            .instance()
            .get(&DataKey::GapCursor)
            .unwrap_or(cfg.start_day);
        let mut scanned = 0u32;
        let mut flagged = 0u32;
        while d <= up_to_day && scanned < MAX_SCAN {
            if now <= deadline(d, cfg.grace_secs) {
                break;
            }
            let skip = !is_expected(cfg.weekday_mask, d)
                || env.storage().persistent().has(&DataKey::NonRecon(d))
                || env.storage().persistent().has(&DataKey::Versions(d));
            if !skip {
                put(&env, &DataKey::Gap(d), &now);
                GapEvent { day: d }.publish(&env);
                flagged += 1;
            }
            d += 1;
            scanned += 1;
        }
        env.storage().instance().set(&DataKey::GapCursor, &d);
        bump_instance(&env);
        Ok(flagged)
    }

    pub fn set_auditor(env: Env, auditor: Address, active: bool) -> Result<(), Error> {
        let cfg = config(&env)?;
        cfg.admin.require_auth();
        put(&env, &DataKey::Auditor(auditor.clone()), &active);
        bump_instance(&env);
        AuditorEvent { auditor, active }.publish(&env);
        Ok(())
    }

    pub fn countersign(
        env: Env,
        auditor: Address,
        day: u32,
        version: u32,
        opinion: u32,
        note_hash: BytesN<32>,
    ) -> Result<(), Error> {
        config(&env)?;
        auditor.require_auth();
        let active: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Auditor(auditor.clone()))
            .unwrap_or(false);
        if !active {
            return Err(Error::NotAuditor);
        }
        if !env.storage().persistent().has(&DataKey::Att(day, version)) {
            return Err(Error::VersionNotFound);
        }
        if !(OPINION_AGREED..=OPINION_DISAGREED).contains(&opinion) {
            return Err(Error::BadReason);
        }
        let key = DataKey::Cosigs(day, version);
        let mut list: Vec<Countersig> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or(Vec::new(&env));
        for c in list.iter() {
            if c.auditor == auditor {
                return Err(Error::AlreadyCountersigned);
            }
        }
        if list.len() >= MAX_COSIGS {
            return Err(Error::TooManyCosigs);
        }
        list.push_back(Countersig {
            auditor: auditor.clone(),
            opinion,
            note_hash,
            at: env.ledger().timestamp(),
        });
        put(&env, &key, &list);
        bump_instance(&env);
        CosignEvent {
            day,
            version,
            auditor,
            opinion,
        }
        .publish(&env);
        Ok(())
    }

    /// Closes the current signer epoch and opens the next one.
    pub fn rotate_signer(
        env: Env,
        new_signer: Address,
        reason: u32,
        compromised_since: u64,
    ) -> Result<u32, Error> {
        let cfg = config(&env)?;
        cfg.admin.require_auth();
        if reason != ROTATE_SCHEDULED && reason != ROTATE_COMPROMISE {
            return Err(Error::BadReason);
        }
        let (old, epoch) = current_signer(&env)?;
        if old == new_signer {
            return Err(Error::SameSigner);
        }
        let now = env.ledger().timestamp();
        let mut closed: SignerEpoch = env
            .storage()
            .persistent()
            .get(&DataKey::SignerHist(epoch))
            .unwrap_or(SignerEpoch {
                signer: old,
                from: 0,
                rotated_reason: 0,
                compromised_since: 0,
            });
        closed.rotated_reason = reason;
        closed.compromised_since = if reason == ROTATE_COMPROMISE {
            compromised_since
        } else {
            0
        };
        put(&env, &DataKey::SignerHist(epoch), &closed);
        let next = epoch + 1;
        put(
            &env,
            &DataKey::SignerHist(next),
            &SignerEpoch {
                signer: new_signer.clone(),
                from: now,
                rotated_reason: 0,
                compromised_since: 0,
            },
        );
        env.storage().instance().set(&DataKey::Signer, &new_signer);
        env.storage().instance().set(&DataKey::Epoch, &next);
        bump_instance(&env);
        RotateEvent {
            epoch: next,
            new_signer,
            reason,
        }
        .publish(&env);
        Ok(next)
    }

    /// Changes the expected-day mask and grace. Days before the gap cursor
    /// have already been judged and are not re-evaluated.
    pub fn set_schedule(env: Env, weekday_mask: u32, grace_secs: u64) -> Result<(), Error> {
        let mut cfg = config(&env)?;
        cfg.admin.require_auth();
        check_mask(weekday_mask)?;
        cfg.weekday_mask = weekday_mask;
        cfg.grace_secs = grace_secs;
        env.storage().instance().set(&DataKey::Config, &cfg);
        bump_instance(&env);
        Ok(())
    }

    /// Needs auth from both the current and the new admin.
    pub fn transfer_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        let mut cfg = config(&env)?;
        cfg.admin.require_auth();
        new_admin.require_auth();
        cfg.admin = new_admin;
        env.storage().instance().set(&DataKey::Config, &cfg);
        bump_instance(&env);
        Ok(())
    }

    // ------------------------------------------------------------------ views

    pub fn config(env: Env) -> Result<Config, Error> {
        config(&env)
    }

    pub fn signer(env: Env) -> Result<(Address, u32), Error> {
        current_signer(&env)
    }

    pub fn head(env: Env) -> (u64, BytesN<32>) {
        let h = head(&env);
        (h.seq, h.hash)
    }

    pub fn get(env: Env, day: u32, version: u32) -> Option<Attestation> {
        env.storage().persistent().get(&DataKey::Att(day, version))
    }

    pub fn latest(env: Env, day: u32) -> Option<Attestation> {
        let n = versions_of(&env, day);
        if n == 0 {
            return None;
        }
        env.storage().persistent().get(&DataKey::Att(day, n - 1))
    }

    pub fn versions(env: Env, day: u32) -> u32 {
        versions_of(&env, day)
    }

    pub fn status(env: Env, day: u32) -> Result<DayStatus, Error> {
        let cfg = config(&env)?;
        let gap = env.storage().persistent().has(&DataKey::Gap(day));
        if versions_of(&env, day) > 0 {
            if gap {
                return Ok(DayStatus::GapThenAttested);
            }
            let v0: Attestation = env
                .storage()
                .persistent()
                .get(&DataKey::Att(day, 0))
                .ok_or(Error::VersionNotFound)?;
            return Ok(if v0.late {
                DayStatus::AttestedLate
            } else {
                DayStatus::Attested
            });
        }
        if env.storage().persistent().has(&DataKey::NonRecon(day)) {
            return Ok(DayStatus::NonReconDay);
        }
        if gap {
            return Ok(DayStatus::Gap);
        }
        if day < cfg.start_day || !is_expected(cfg.weekday_mask, day) {
            return Ok(DayStatus::NotExpected);
        }
        Ok(DayStatus::Pending)
    }

    /// Flagged gap days in `[from, to]`; the range may span at most 62 days.
    pub fn gaps(env: Env, from: u32, to: u32) -> Result<Vec<u32>, Error> {
        let mut out = Vec::new(&env);
        if to < from {
            return Ok(out);
        }
        if to - from >= MAX_SCAN {
            return Err(Error::RangeTooLarge);
        }
        for d in from..=to {
            if env.storage().persistent().has(&DataKey::Gap(d)) {
                out.push_back(d);
            }
        }
        Ok(out)
    }

    pub fn countersigs(env: Env, day: u32, version: u32) -> Vec<Countersig> {
        env.storage()
            .persistent()
            .get(&DataKey::Cosigs(day, version))
            .unwrap_or(Vec::new(&env))
    }

    /// True when the entry's epoch was closed as COMPROMISE and the entry was
    /// written at or after `compromised_since`.
    pub fn is_suspect(env: Env, day: u32, version: u32) -> bool {
        let att: Option<Attestation> = env.storage().persistent().get(&DataKey::Att(day, version));
        let Some(att) = att else { return false };
        let ep: Option<SignerEpoch> = env
            .storage()
            .persistent()
            .get(&DataKey::SignerHist(att.signer_epoch));
        match ep {
            Some(e) => e.rotated_reason == ROTATE_COMPROMISE && att.attested_at >= e.compromised_since,
            None => false,
        }
    }

    pub fn signer_epoch(env: Env, epoch: u32) -> Option<SignerEpoch> {
        env.storage().persistent().get(&DataKey::SignerHist(epoch))
    }

    pub fn gap_cursor(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::GapCursor)
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod test;
#[cfg(test)]
mod test_props;
#[cfg(test)]
mod test_scenario;
