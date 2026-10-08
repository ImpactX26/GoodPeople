/**
 * Every tunable number for the Smart Matching Agent, in one place for demo tuning.
 */
const env = process.env;
const MIN = 60_000;

export const config = {
  /** Ranking weights (Step 2). */
  weights: {
    urgency: 0.25,
    proximity: 0.25,
    fit: 0.15,
    /** Recipients with stricter diet rules win the food they can take (SRS example 3). */
    specialisation: 0.1,
    underserved: 0.15,
    priority: 0.1,
    /** Added when Grade A food goes to a vulnerable group. */
    vulnerableBonus: 0.15,
    /** Added for recipients in an area a donor pledged food to (gap closing). */
    pledgeBonus: 0.1,
  },
  /** Distance at which proximity scores 0. */
  proximityZeroKm: 15,
  /** Effective grade from safe time: at least this many minutes → that grade (SRS grade table). */
  gradeMinutes: { A: 360, B: 180, C: 1 },
  /** Below this confidence (0–100) the item is "unsure": the partner checks it at pickup. */
  unsureThreshold: 60,
  /** Grade C only goes where it is served within this many minutes of arrival. */
  gradeCServeWithinMin: 60,
  /** Offer countdown = remaining safe time / 6, clamped to these bounds. */
  countdownDivisor: 6,
  countdownMinMs: 2 * MIN,
  countdownMaxMs: 10 * MIN,
  /** A redirected drop must be accepted this fast. */
  redirectCountdownMs: 2 * MIN,
  /** How long each delivery partner gets to accept a pickup. */
  partnerAcceptMs: 3 * MIN,
  /** ...and for "serve now" (Grade C) food. */
  partnerAcceptServeNowMs: 90_000,
  /**
   * Accepted, but no partner has taken the pickup for this long (it sits on the open pickups board meanwhile):
   * it moves to the next NGO that has a partner free, without asking the first NGO, which is told why.
   */
  partnerWaitBeforeNextNgoMs: 10 * MIN,
  partnerWaitBeforeNextNgoServeNowMs: 5 * MIN,
  /** However the asking is going, an NGO holds accepted food at most this long without a partner taking it. */
  ngoHoldAfterAcceptMaxMs: 30 * MIN,
  /** Checkpoint slack: expected leg time × this. */
  checkpointSlack: 1.5,
  /** Each "Running late" tap adds this much to the partner's projected arrival. */
  lateStepMs: 15 * MIN,
  /** Defaults when the donor leaves the pickup window out. */
  defaultCollectWithinMs: 60 * MIN,
  /** Pickup leg assumed when no partner is online to estimate from. */
  fallbackPickupLegMs: 20 * MIN,
  /** Road distance ≈ straight line × this. */
  roadFactor: 1.4,
  /** km/h per travel mode. */
  speedKmh: { two_wheeler: 22, bicycle: 12, car: 18, foot: 4.5, transit: 14 },
  /** Wrong pickup or drop codes allowed before an admin is called. */
  codeTries: 3,
  /** Respectful messaging: gap requests per donor. */
  gapContactPerDay: 1,
  gapContactPerWeek: 3,
  gapDonorsPerArea: 3,
  gapNeighbourKm: 6,
  /** Look this far ahead for gap windows. */
  gapLookaheadFromMs: 3 * 60 * MIN,
  gapLookaheadToMs: 6 * 60 * MIN,
  gapRunEveryMs: 60 * MIN,
  /** Outbox retries. */
  outboxMaxAttempts: 5,
  outboxBaseBackoffMs: 5_000,
  tickMs: 5_000,
  /**
   * A share left unplaced only because no partner could collect it is looked at again this often, while
   * the food is still safe and inside the pickup window; it's re-offered once someone who can reach it is online.
   */
  replanEveryMs: 90_000,
  /** While the donor waits on an NGO or a partner, a short "still on it" goes out this often (spec §14.1). */
  heartbeatMs: 5 * 60_000,
  /** Lateness, judged against the arrival promised at assignment (Decision Agent). */
  lateness: {
    /** Up to this many minutes behind still counts as on time. */
    graceMin: 5,
    /** A new notice goes out only when the delay grows by at least this much (spec §14.1: ETA moves ≥ 5 min). */
    noticeStepMin: 5,
    /** Before pickup, this late and someone else could get there sooner by `reassignGainMin`: reassign. */
    reassignAfterMin: 15,
    reassignGainMin: 10,
    /** How often a live trip's estimated arrival is re-checked. */
    etaCheckMs: 60_000,
  },
  /** Reliability (0–5): recency-weighted trip marks over a neutral prior. */
  reliability: {
    prior: 4.5,
    priorWeight: 2,
    decay: 0.85,
    window: 12,
    /** Below this, a partner is asked after everyone else in the same tier. */
    lowScore: 3,
    /** Trips before a partner's score is shown as settled (until then: "new"). */
    newUntilTrips: 3,
  },
  /** While an accepted share waits for a partner, the Logistics Agent looks for one this often. */
  partnerRetryMs: 20_000,
  /**
   * Seeded sample NGOs and partners that no real phone has claimed answer automatically, so the local
   * demo keeps moving. Off by default with a database (Railway), so real food only ever goes to real
   * people; MATCHING_SIMULATE=1 / 0 forces it either way.
   */
  simulateUnclaimed: env.MATCHING_SIMULATE ? env.MATCHING_SIMULATE === "1" : !env.DATABASE_URL,
  simReplyMs: 5_000,
  /** Simulated partners travel this many times faster than real ones. */
  simTravelSpeedup: 10,
  /** SRS "human in control": a new donor's first listing waits for an admin. */
  reviewFirstListing: env.MATCHING_REVIEW_FIRST !== "0",
};

export type Config = typeof config;
