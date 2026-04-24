/**
 * Motorcycle safety types and configuration.
 *
 * ================================================================
 *  CRITICAL ANALYSIS: WHY 4-WHEELER THRESHOLDS FAIL ON 2-WHEELERS
 * ================================================================
 *
 *  1. CORNERING — THE MOST FUNDAMENTAL DIFFERENCE
 *  -----------------------------------------------
 *  A car corners by generating lateral tire force while remaining
 *  upright. The centripetal acceleration felt by the occupants (and
 *  the phone) is purely horizontal. 4.2 m/s² ≈ 0.43g is already
 *  aggressive.
 *
 *  A motorcycle MUST lean to corner. At lean angle θ the vehicle is
 *  in equilibrium when:
 *      tan(θ) = a_centripetal / g
 *  At our car threshold 4.2 m/s²: θ = atan(4.2/9.81) = 23°.
 *  23° lean is COMPLETELY NORMAL, comfortable motorcycle cornering.
 *  Apply the car threshold to a motorcycle and you will fire an event
 *  on almost every bend on a B-road. The system becomes useless.
 *
 *  Correct motorcycle hard-corner threshold: ≥40° lean, which
 *  corresponds to a_centripetal = 9.81 × tan(40°) ≈ 8.23 m/s².
 *  At 40° the rider is in the "spirited" regime but not yet dangerous
 *  on dry pavement. 50° (11.7 m/s²) is the extreme-lean threshold.
 *
 *  Extreme criticism of our own approach: the centripetal formula
 *  a = v·dθ/dt uses GPS heading at 1 Hz. This misses sub-second
 *  lean events (e.g., flick at corner entry). We supplement with
 *  accelerometer tilt estimation where possible.
 *
 *  2. HARD ACCELERATION
 *  ---------------------
 *  Even a modest 300cc motorcycle can accelerate at 5–6 m/s². A 600cc
 *  supersport: 7–9 m/s². The car threshold of 3.0 m/s² fires on every
 *  confident motorway merge. Motorcycle-specific threshold: 5.5 m/s².
 *
 *  But the REAL risk on a motorcycle is not forward acceleration per
 *  se — it is accelerating WHILE LEANING. At 30° lean with 4 m/s²
 *  forward acceleration, the combined resultant pushes the contact
 *  patch toward its friction limit. We add "in-corner acceleration"
 *  as a separate event (accel > 2.5 m/s² while lean > 25°) because
 *  that combination is what crashes riders in corners.
 *
 *  3. HARD BRAKING
 *  ----------------
 *  Motorcycles can brake harder than cars (up to 9 m/s² with ABS) but
 *  the risk profile is inverted:
 *    - Car hard brake: risk to following traffic, skid into an object.
 *    - Moto front-lock: instant high-side or front wash-out crash.
 *    - Moto rear-lock: fishtail, low-side, manageable at low speed.
 *
 *  Without knowing if the bike has ABS, we set the threshold at
 *  4.5 m/s² (vs 3.2 for cars). On ABS-equipped bikes this is
 *  conservative. On non-ABS bikes we set it lower: 3.5 m/s².
 *
 *  We also detect FRONT-ONLY vs REAR-ONLY braking patterns via the
 *  pitch-rate gyroscope: front-heavy braking produces strong forward
 *  pitch; rear-only produces almost no pitch.
 *
 *  4. CRASH DETECTION
 *  -------------------
 *  Car crash: the dominant signal is LINEAR acceleration spike (>2.5g).
 *  The car stays upright.
 *
 *  Motorcycle crash types:
 *  a) LOW-SIDE: front or rear slides to the inside. The bike tips over
 *     laterally — ROLL RATE spikes before linear accel gets very high.
 *  b) HIGH-SIDE: rear slips then snaps back. The rider is catapulted
 *     upward. Linear accel spikes VERY high + extreme roll/pitch rate.
 *  c) FRONT-WASH: front tucks in. PITCH RATE spikes forward.
 *
 *  Consequence: gyroscope (specifically roll + pitch rate magnitude) is
 *  the PRIMARY crash sensor for motorcycles, not the linear accelerometer.
 *  We trigger on gyro magnitude > 6 rad/s (~344 °/s) OR linear > 2.5g,
 *  whichever fires first.
 *
 *  5. ENGINE VIBRATION
 *  --------------------
 *  V-twin engines (e.g., Harley, Ducati) at 2000–4000 RPM produce
 *  vibration at 33–133 Hz. Single-cylinders at 3000–7000 RPM: 25–117 Hz.
 *  The phone's accelerometer samples at 60–100 Hz. This means engine
 *  vibration ALIASES into our signal as low-frequency noise — especially
 *  problematic for linear accel threshold detectors.
 *
 *  Mitigation: use a stricter low-pass gravity filter (α = 0.98 →
 *  α = 0.99 for motorcycles) and require sustained-duration events
 *  (minimum 0.8s vs 0.6s for cars) to filter vibration artifacts.
 *
 *  6. WEATHER EFFECTS (DRAMATICALLY WORSE FOR MOTORCYCLES)
 *  ---------------------------------------------------------
 *  Dry asphalt friction coefficient µ ≈ 0.7–0.9 for motorcycle tires.
 *  Wet asphalt: µ ≈ 0.4–0.5. Rain threshold factor = 0.70 (vs 0.88
 *  for cars) because the same lean angle is proportionally more risky.
 *  Snow: motorcycles simply should not be ridden; we set factor 0.55
 *  and flag any cornering event at all.
 *
 *  7. OBD AVAILABILITY
 *  --------------------
 *  The OBD-II standard was designed for 4-wheelers. Motorcycles use:
 *  - ISO 11898 CAN bus (newer bikes, 2008+) — accessible via some OBD
 *    Bluetooth adapters with bike-specific firmware
 *  - Manufacturer proprietary: Yamaha D-connector, Honda HDS, KTM,
 *    Ducati DDA, BMW K-line
 *  - No diagnostic port at all (cheap commuter bikes, old bikes)
 *
 *  We treat OBD as OPTIONAL for motorcycles. GPS speed is the primary
 *  speed source. If OBD is available, it adds RPM (useful for the
 *  wear monitor) and a more reliable speed.
 *
 *  8. SCORING WEIGHT CHANGES (vs 4-Wheeler)
 *  -----------------------------------------
 *  NHTSA/MAIDS (Motorcycle Accident In-Depth Study) data:
 *    - ~30% of fatal moto crashes involve speed (↑ from 29% for cars)
 *    - ~42% involve rider error in curves (cornering >> braking)
 *    - Inattention/distraction: similar (~15%)
 *
 *  New weights:
 *    speeding 30% (was 25%), cornering 25% (was 20%),
 *    braking 20% (was 25%), distracted 15%, acceleration 10% (was 15%)
 */

import { SafetyConfig, DEFAULT_SAFETY_CONFIG } from '../types';

export type MotoSubtype = 'motorcycle' | 'scooter';

/**
 * Fuel/powertrain profile. Matters because electric 2Ws accelerate harder
 * than ICE for the same rider input — we raise the acceleration thresholds
 * accordingly to match the delivery-rider safety spec.
 */
export type PowertrainType = 'ice' | 'electric';

/** Events that only exist for 2-wheelers. */
export type MotoEventType =
  | 'extreme_lean'         // centripetal > ~50° lean equivalent
  | 'corner_acceleration'  // throttle input while leaning > 25°
  | 'speed_wobble'         // tank-slapper: yaw oscillation 2–8 Hz at speed
  | 'highside_risk';       // rapid yaw reversal pattern (rear-slip recovery)

/** All event types available for a motorcycle trip. */
export type MotoSafetyEventType =
  | 'hard_acceleration'
  | 'hard_braking'
  | 'hard_cornering'
  | 'extreme_lean'
  | 'corner_acceleration'
  | 'speed_wobble'
  | 'highside_risk'
  | 'overspeeding'
  | 'distracted_driving'
  | 'drowsy_driving'
  | 'crash'
  | 'swerving'
  | 'phone_use'
  | 'panic_brake'          // severe brake with sub-second stop from > 20 km/h
  | 'brake_during_lean';   // trail-braking: decel > 0.3 g while lean > 20°

/**
 * Phone position states classified by the phone-position classifier.
 * Downstream detectors gate on this — events from low-confidence
 * "held" classifications are suppressed to reduce false positives.
 */
export type PhonePositionState = 'mounted' | 'held' | 'pocket' | 'bag' | 'unknown';

/**
 * Overspeed risk band. Calculated from ratio of current speed to the
 * reference speed (ambient 2W traffic flow + legal limit fallback).
 *
 * The bands exist because a linear "excess km/h" penalty systematically
 * underweights the regime where real crash energy scales as v². We bucket
 * the band and then apply a quadratic (ratio - 1)² term inside the scorer.
 */
export type OverspeedBand = 'ok' | 'caution' | 'event' | 'severe';

/** Time-of-day bucket. Drives the severity multiplier applied to events. */
export type TimeOfDayBucket = 'day' | 'dusk' | 'night';

/**
 * Generic Indian road-class default table, used when live map lookup
 * (OSM / Mappls) is unavailable. A proper production deployment will
 * replace this with a reverse-geocoded value for every ~100 m segment.
 */
export type RoadClass =
  | 'residential'
  | 'service'
  | 'tertiary'
  | 'secondary'
  | 'primary'
  | 'trunk_urban'
  | 'trunk_rural'
  | 'motorway';

export interface MotoConfig extends SafetyConfig {
  subtype: MotoSubtype;

  /**
   * Does the bike have ABS?
   * ABS changes the hard-brake threshold: non-ABS bikes lock up earlier
   * so we use a lower (more sensitive) threshold.
   */
  hasABS: boolean;

  /**
   * Does the rider have a pillion passenger?
   * Affects braking distance (heavier) and crash severity (two people).
   * Hard-brake penalty is multiplied by 1.2 when true.
   */
  hasPassenger: boolean;

  /**
   * m/s² forward acceleration while lean > cornerAccelLeanThresholdDeg.
   * Threshold below car accel (2.5) because the risk is asymmetric:
   * any throttle at lean reduces the lateral grip budget.
   */
  cornerAccelThreshold: number;           // default 2.5

  /** Degrees. Below this lean angle, corner-acceleration is not flagged. */
  cornerAccelLeanThresholdDeg: number;    // default 25

  /**
   * rad/s (total gyro magnitude). Primary crash trigger for motorcycles.
   * 6 rad/s ≈ 344 °/s. A normal aggressive swerve is < 2 rad/s.
   * A crashing motorcycle generates 5–15 rad/s. We set conservatively
   * at 6 to avoid false positives from sharp U-turns (which can reach 4).
   *
   * WHY lower than angular velocity of a U-turn?
   *   A U-turn at 10 km/h with 5m radius: ω = v/r = 2.78/5 = 0.56 rad/s.
   *   Even an emergency 180° at 30 km/h: ω ≈ 8.33/3 ≈ 2.8 rad/s.
   *   A crashing bike: 5–15 rad/s. 6 rad/s is safely above normal manoeuvres.
   */
  crashGyroThresholdRadS: number;         // default 6.0

  /**
   * rad/s (yaw axis specifically). Below this, yaw oscillations are
   * not considered wobble. Normal riding has < 0.3 rad/s yaw at speed.
   */
  wobbleAmplitudeThresholdRadS: number;   // default 0.6

  /**
   * km/h. Below this, speed wobble is not physically meaningful —
   * the oscillation won't build into a tank slapper.
   */
  wobbleMinSpeedKmH: number;              // default 60

  /**
   * Seconds of sustained high-amplitude yaw oscillation to confirm a wobble.
   * 0.5s at 2 Hz = ~1 full oscillation cycle — enough to confirm the pattern.
   */
  wobbleMinDurationS: number;             // default 0.5

  /** Degrees. Above this lean angle a SafetyEvent fires. */
  extremeLeanThresholdDeg: number;        // default 50

  /**
   * Weather threshold factor in rain for motorcycles (vs 0.88 for cars).
   * Motorcycles lose lateral grip faster on wet roads due to the lean
   * angle dependency. 0.70 means a 30% threshold reduction in rain.
   */
  rainThresholdFactor: number;            // default 0.70
  snowThresholdFactor: number;            // default 0.55

  // ================================================================
  //  Delivery-rider extensions (from 2W safety analytics spec)
  // ================================================================

  /**
   * Powertrain profile. Used to choose between ICE and electric accel
   * thresholds. Electric 2Ws produce peak torque from zero RPM and can
   * sustain 0.5 g forward accel from a standstill — calling that a
   * "hard_acceleration" event on every traffic-light green is false-
   * positive suicide. Electric threshold is raised to match.
   */
  powertrain: PowertrainType;             // default 'ice'

  /**
   * Forward-accel thresholds in m/s² (not g). These replace
   * hardAccelThreshold when delivery scoring is enabled.
   *
   * ICE (default): caution 0.40 g, event 0.55 g, severe 0.70 g
   * Electric:       caution 0.50 g, event 0.65 g, severe 0.80 g
   */
  accelCautionMs2: number;                // ICE 3.92, EV 4.90
  accelEventMs2: number;                  // ICE 5.39, EV 6.38
  accelSevereMs2: number;                 // ICE 6.87, EV 7.85

  /** Min duration (s) for an accel event in caution/event band. */
  accelMinDurationS: number;              // default 1.0
  /** Min duration (s) for an accel event in the severe band. */
  accelSevereMinDurationS: number;        // default 0.5

  /**
   * Jerk spike threshold (g/s). The spec logs jerk-spike counts at |jerk|
   * > 2.0 g/s; this threshold multiplied by 9.81 gives the m/s³ value.
   */
  jerkSpikeThresholdMs3: number;          // default 19.62 (≈ 2.0 g/s)

  /**
   * Minimum acceleration-reversal rate (per minute) considered normal
   * urban riding. Above this, we contribute to the trip's aggressive-
   * pattern score. 3/min is normal; 6/min is "twist and brake" impatient.
   */
  accelReversalsPerMinBase: number;       // default 3

  /**
   * Braking thresholds in m/s² (POSITIVE values — we compare against
   * |decel|). ICE and electric use the same braking thresholds.
   *   caution 0.40 g, event 0.55 g, severe 0.70 g
   */
  brakeCautionMs2: number;                // default 3.92
  brakeEventMs2: number;                  // default 5.39
  brakeSevereMs2: number;                 // default 6.87

  /** Min duration (s) for a caution/event brake; severe uses half. */
  brakeMinDurationS: number;              // default 0.5
  brakeSevereMinDurationS: number;        // default 0.3

  /**
   * Panic brake detection — a severe brake with the signature of
   * near-emergency stop from city speed.
   */
  panicPreBrakeSpeedKmH: number;          // default 20
  panicMaxTime20To0S: number;             // default 1.2
  panicMinOnsetJerkMs3: number;           // default 19.62 (2.0 g/s)

  // ---- False-positive filters (speed breaker / pothole / normal stop) ----

  /**
   * Vertical-accel peak magnitude (m/s²) above which we consider a
   * speed-breaker signature. 0.5 g = 4.9 m/s². A gentle Indian hump
   * produces 0.4–0.6 g; a sharp one can exceed 1.0 g.
   */
  speedBreakerVertPeakMs2: number;        // default 4.9

  /** Max forward-decel duration (s) still consistent with a speed breaker. */
  speedBreakerMaxDecelDurationS: number;  // default 0.5
  /** Max forward-decel peak (m/s²) for a crossing to be classified as breaker. */
  speedBreakerMaxDecelMs2: number;        // default 3.92

  /** Pothole: large vertical spike + lateral swerve + very short decel. */
  potholeVertPeakMs2: number;             // default 5.88 (0.6 g)
  potholeLatPeakMs2: number;              // default 2.94 (0.3 g)
  potholeMaxDecelDurationS: number;       // default 0.4

  /**
   * Normal-stop: gradual decel ramp that goes to zero. If the peak decel
   * stays below this and the vehicle ends up stopped, it's treated as a
   * controlled (red light) stop and not flagged.
   */
  normalStopPeakMs2: number;              // default 3.43 (0.35 g)
  normalStopEndSpeedKmH: number;          // default 1.0

  // ---- Swerve detection ----

  /**
   * A swerve is detected when the phone sees a lateral impulse but the
   * GPS heading barely changes — "the bike moved sideways but kept
   * pointing forward". Classic obstacle dodge / lane splitting pattern.
   */
  swerveLatImpulseMs2: number;            // default 3.43 (0.35 g)
  swerveMaxHeadingChangeDeg: number;      // default 20
  swerveWindowMs: number;                 // default 2000

  /**
   * Phone-position gate: downstream detectors drop events whose phone
   * position confidence is below this. 0.7 matches the spec default.
   */
  phonePositionMinConfidence: number;     // default 0.7

  // ---- Phone-use events ----

  /** Min speed (km/h) below which phone-use events are not flagged. */
  phoneUseMinSpeedKmH: number;            // default 15
  /** Min duration (s) of handheld / distraction before it becomes an event. */
  phoneUseMinDurationS: number;           // default 3
  /** Speed (km/h) above which an active voice call becomes an event. */
  phoneUseCallMinSpeedKmH: number;        // default 20
  /** Min duration (s) of an active voice call before flagging. */
  phoneUseCallMinDurationS: number;       // default 10
  /** Touches/s above which we infer a texting signature. */
  phoneUseTouchesPerSec: number;          // default 1.5

  // ---- Time-of-day weighting ----

  /**
   * Multiplicative weights applied to event *severity scores*. The spec
   * is explicit that we do NOT scale thresholds by time of day — we
   * scale the consequence. A hard brake at 22:00 carries more risk than
   * the same brake at 10:00 because ambient crash rate is ~2–3× higher.
   */
  todDayWeight: number;                   // default 1.0
  todDuskWeight: number;                  // default 1.2
  todNightWeight: number;                 // default 1.4

  // ---- GPS Kalman / noise gating ----

  /** GPS samples with reported accuracy > this are dropped for speed. */
  gpsMaxAccuracyM: number;                // default 20
  /** Number of seconds to discard at the start of a trip (GPS settling). */
  gpsSettlingSeconds: number;             // default 5
  /** Kalman process-noise proxy (m²/s³). Higher = trust measurements more. */
  gpsKalmanProcessNoise: number;          // default 1.5

  /**
   * Enable the full delivery-rider pipeline (context-aware overspeed,
   * banded scoring, FP filters, swerve detection, phone-position gate,
   * time-of-day weighting). When false the engine reverts to the
   * v1 motorcycle detectors.
   */
  deliveryRiderMode: boolean;             // default true

  // ---- Trip stitching (spec §2.4) ----

  /** Speed (km/h) below which the rider counts as paused. */
  tripIdleSpeedKmH: number;               // default 2
  /** Auto-end trip after this many continuous seconds below the idle speed. */
  tripIdleEndSeconds: number;             // default 300 (5 min)
  /** Flag trips below this distance (m) as non-scorable. */
  tripMinDistanceM: number;               // default 500
  /** Flag trips shorter than this (seconds) as non-scorable. */
  tripMinDurationS: number;               // default 120

  // ---- GPS-vs-IMU cross-check (spec §4.2) ----

  /**
   * Tolerated relative disagreement between IMU-derived forward accel and
   * GPS-derived accel. When the two disagree by more than this fraction
   * we mark the accel event with `gpsCrossCheckFailed=true`; the scorer
   * halves its penalty. We never suppress outright — an IMU-confirmed
   * event with GPS disagreement is still informative, just less trusted.
   */
  accelGpsCrossCheckTolerance: number;    // default 0.30

  // ---- Trail-braking / U-turn / phone-mount shift ----

  /** Lean angle (deg) above which simultaneous braking counts as trail-braking. */
  trailBrakingMinLeanDeg: number;         // default 20
  /** |decel| (m/s²) above which trail-braking fires when combined with lean. */
  trailBrakingMinDecelMs2: number;        // default 2.94 (0.3 g)

  /** Speed (km/h) below which a sharp heading change is treated as a U-turn. */
  uTurnMaxSpeedKmH: number;               // default 10
  /** Heading change (deg) over 3 s at low speed that counts as a U-turn. */
  uTurnMinHeadingChangeDeg: number;       // default 150

  /**
   * When IMU-derived lean disagrees with GPS-derived expected lean by more
   * than this (deg) for `mountShiftMinDurationS` seconds, phone-position
   * confidence is floored to 0.5 — the mount has probably shifted.
   */
  mountShiftMaxDiffDeg: number;           // default 15
  mountShiftMinDurationS: number;         // default 3

  // ---- Phone use / distraction ----

  /**
   * Whitelisted foreground app IDs for distraction detection. When the
   * foreground app is NOT in this set AND screen-on while moving fast,
   * we emit a phone_use event with subtype=distraction. Typically holds
   * the delivery app's own bundle/package ID so navigation + OTP + pickup
   * confirm don't penalise.
   */
  deliveryAppIds: string[];               // default []
}

export const DEFAULT_MOTO_CONFIG: MotoConfig = {
  ...DEFAULT_SAFETY_CONFIG,

  subtype: 'motorcycle',
  hasABS: false,
  hasPassenger: false,

  // Hard events: raised thresholds justified by higher power-to-weight
  hardAccelThreshold: 5.5,
  hardBrakeThreshold: 4.5,
  hardCornerThreshold: 8.23, // = 9.81 * tan(40°) — 40° lean, see above
  minEventDurationS: 0.8,    // wider than car (0.6) to reject vibration artifacts

  absoluteSpeedLimitKmH: 110, // lower than cars (130) — injury risk rises faster
  zoneSpeedLimitKmH: null,
  overspeedBufferKmH: 5,
  minOverspeedDurationS: 3,

  distractedMinSpeedKmH: 5,  // vs 10 for cars — phone use is dangerous even while filtering
  distractedMinDurationS: 3,

  crashPeakThreshold: 24.5,  // same linear threshold as car (2.5g)
  crashMinSpeedKmH: 15,
  crashSpeedDropKmH: 15,

  vehicleRedlineRPM: 10000,  // typical for 4-cyl motorcycle; scooter overrides to 8000
  highLoadThresholdPct: 85,  // bikes run hotter % more often — slightly raised
  highLoadMinDurationS: 20,  // bikes can sustain WOT for long periods on straights
  maxCoolantTempC: 110,      // bikes often run slightly hotter by design

  enableWeatherAPI: true,
  weatherThresholdMinSpeedKmH: 20, // lower than car (30) — lane filter speed

  routeTileSize: 0.005,
  routeFullFamiliarVisits: 5,

  recoveryWindowMinutes: 10,
  recoveryPenaltyFactor: 0.8,

  drowsyMinSpeedKmH: 80,
  drowsyCalibrationMinutes: 5,
  drowsyVarianceRatioThreshold: 2.0,
  drowsyMinElevatedDurationS: 30,

  minScorableDistanceM: 1000,

  // Moto-specific
  cornerAccelThreshold: 2.5,
  cornerAccelLeanThresholdDeg: 25,
  crashGyroThresholdRadS: 6.0,
  wobbleAmplitudeThresholdRadS: 0.6,
  wobbleMinSpeedKmH: 60,
  wobbleMinDurationS: 0.5,
  extremeLeanThresholdDeg: 50,
  rainThresholdFactor: 0.70,
  snowThresholdFactor: 0.55,

  // Delivery-rider defaults (ICE). Electric overrides in DEFAULT_ELECTRIC_MOTO_CONFIG.
  powertrain: 'ice',
  accelCautionMs2: 3.92,      // 0.40 g
  accelEventMs2: 5.39,        // 0.55 g
  accelSevereMs2: 6.87,       // 0.70 g
  accelMinDurationS: 1.0,
  accelSevereMinDurationS: 0.5,
  jerkSpikeThresholdMs3: 19.62, // 2.0 g/s
  accelReversalsPerMinBase: 3,

  brakeCautionMs2: 3.92,
  brakeEventMs2: 5.39,
  brakeSevereMs2: 6.87,
  brakeMinDurationS: 0.5,
  brakeSevereMinDurationS: 0.3,

  panicPreBrakeSpeedKmH: 20,
  panicMaxTime20To0S: 1.2,
  panicMinOnsetJerkMs3: 19.62,

  speedBreakerVertPeakMs2: 4.9,
  speedBreakerMaxDecelDurationS: 0.5,
  speedBreakerMaxDecelMs2: 3.92,
  potholeVertPeakMs2: 5.88,
  potholeLatPeakMs2: 2.94,
  potholeMaxDecelDurationS: 0.4,
  normalStopPeakMs2: 3.43,
  normalStopEndSpeedKmH: 1.0,

  swerveLatImpulseMs2: 3.43,
  swerveMaxHeadingChangeDeg: 20,
  swerveWindowMs: 2000,

  phonePositionMinConfidence: 0.7,

  phoneUseMinSpeedKmH: 15,
  phoneUseMinDurationS: 3,
  phoneUseCallMinSpeedKmH: 20,
  phoneUseCallMinDurationS: 10,
  phoneUseTouchesPerSec: 1.5,

  todDayWeight: 1.0,
  todDuskWeight: 1.2,
  todNightWeight: 1.4,

  gpsMaxAccuracyM: 20,
  gpsSettlingSeconds: 5,
  gpsKalmanProcessNoise: 1.5,

  deliveryRiderMode: true,

  tripIdleSpeedKmH: 2,
  tripIdleEndSeconds: 300,
  tripMinDistanceM: 500,
  tripMinDurationS: 120,

  accelGpsCrossCheckTolerance: 0.30,

  trailBrakingMinLeanDeg: 20,
  trailBrakingMinDecelMs2: 2.94,

  uTurnMaxSpeedKmH: 10,
  uTurnMinHeadingChangeDeg: 150,

  mountShiftMaxDiffDeg: 15,
  mountShiftMinDurationS: 3,

  deliveryAppIds: [],
};

/**
 * Electric 2W profile — raises the acceleration thresholds so clean EV
 * launches don't count as hard-acceleration events. Braking thresholds
 * remain identical (physics is the same on the decel side).
 */
export const DEFAULT_ELECTRIC_MOTO_CONFIG: MotoConfig = {
  ...DEFAULT_MOTO_CONFIG,
  powertrain: 'electric',
  accelCautionMs2: 4.90, // 0.50 g
  accelEventMs2:   6.38, // 0.65 g
  accelSevereMs2:  7.85, // 0.80 g
};

export const DEFAULT_SCOOTER_CONFIG: MotoConfig = {
  ...DEFAULT_MOTO_CONFIG,
  subtype: 'scooter',
  hasABS: false,

  hardAccelThreshold: 3.5,
  hardBrakeThreshold: 3.5,
  // Scooters lean less aggressively — 31° lean = 6.0 m/s²
  hardCornerThreshold: 6.0,   // = 9.81 * tan(31.4°)
  extremeLeanThresholdDeg: 40, // lower extreme threshold
  absoluteSpeedLimitKmH: 80,  // most scooters governed or unsafe above 80

  crashGyroThresholdRadS: 5.0, // scooters tip over at lower angular rates
  crashPeakThreshold: 19.6,    // ~2.0g (less energy, still very dangerous)

  vehicleRedlineRPM: 8000,
  rainThresholdFactor: 0.75,
  snowThresholdFactor: 0.60,

  // Scooters are almost always electric in the last-mile delivery fleet;
  // we keep ICE as the explicit default but the accel thresholds here
  // assume moderate scooter capability.
  accelCautionMs2: 2.94,       // 0.30 g
  accelEventMs2:   4.41,       // 0.45 g
  accelSevereMs2:  5.88,       // 0.60 g
};

/** Scooter running on electric powertrain — e-scooter delivery fleet default. */
export const DEFAULT_ELECTRIC_SCOOTER_CONFIG: MotoConfig = {
  ...DEFAULT_SCOOTER_CONFIG,
  powertrain: 'electric',
  accelCautionMs2: 3.92,       // 0.40 g
  accelEventMs2:   5.39,       // 0.55 g
  accelSevereMs2:  6.87,       // 0.70 g
};

/** A safety event with the extended moto event type union. */
export interface MotoSafetyEvent {
  id: string;
  type: MotoSafetyEventType;
  startedAt: number;
  endedAt: number;
  peak: number;
  severity: 1 | 2 | 3 | 4 | 5;
  location: { lat: number; lng: number } | null;
  meta?: Record<string, number | string | boolean>;
}

/** Live lean state snapshot. */
export interface LeanState {
  angleDeg: number;       // positive = right, negative = left
  centripetal: number;    // m/s² — what produced this lean estimate
  source: 'gps' | 'imu'; // which estimator is active
}

/**
 * Live phone-position snapshot. Emitted at ~1 Hz by the classifier.
 * Downstream event detectors read this to gate what they flag.
 */
export interface PhonePositionSnapshot {
  state: PhonePositionState;
  /** Confidence in [0, 1]. */
  confidence: number;
  /** ms since epoch of the last successful classification. */
  updatedAt: number;
}

/**
 * Live rider context snapshot. Populated from GPS position + time. In
 * production the ambient_2w_speed is a Mappls API lookup; in v1 we only
 * have the static fallback from the road-class heuristic.
 */
export interface RiderContext {
  /** Estimated reference 2W flow speed in km/h for the current segment. */
  ambient2wSpeedKmH: number;
  /** Effective legal speed limit for the current segment, km/h. */
  speedLimitKmH: number;
  /** Heuristic-inferred road class. */
  roadClass: RoadClass;
  /** Current time-of-day bucket. */
  timeOfDay: TimeOfDayBucket;
  /** Multiplier applied to event severity scores. */
  timeOfDayWeight: number;
  /** True if the context is a best-effort static fallback rather than live. */
  isFallback: boolean;
}

/**
 * Per-trip aggregate features emitted by the new detectors. These are
 * surfaced in MotoTripSnapshot so the UI and the backend data contract
 * can display them directly without recomputing from the event stream.
 */
export interface RiderTripFeatures {
  jerkSpikeCount: number;
  accelReversalsPerMinute: number;
  coastRatio: number;
  phoneUsageRatio: number;
  mountedPct: number;
  heldPct: number;
  pocketPct: number;
  bagPct: number;
  unknownPct: number;
  speedBreakersDetected: number;
  potholesDetected: number;
  normalStopsDetected: number;
  panicStopCount: number;
  swerveCount: number;
  /** Maximum Kalman-smoothed speed seen during the trip, km/h. */
  peakSpeedKmH: number;

  // ---- Spec §4.2 acceleration features ----

  /** Best 0→30 km/h time observed during the trip (seconds). Null if not reached. */
  zeroTo30TimeS: number | null;
  /**
   * Peak "energy gain rate" proxy during an accel event: speed_kmh × a_fwd_ms2.
   * The spec expresses this as mass × speed × a_fwd; we omit mass so the
   * metric is comparable across riders.
   */
  energyGainRate: number;
  /**
   * Aggressive-pattern score (trip-level, spec §4.2):
   *   max(0, reversals_per_min - base) × (1 - coast_ratio) × duration_min.
   */
  aggressivePatternScore: number;

  // ---- Spec §4.3 brake features ----

  /** Mean pre-brake speed across all flagged brake events, km/h. */
  preBrakeSpeedMeanKmH: number;
  /** p95 of pre-brake speeds (km/h). */
  preBrakeSpeedP95KmH: number;
  /** Count of trail-braking events: decel + lean simultaneously. */
  brakeDuringLeanCount: number;

  /** Total moving seconds — denominator for per-shift exposure-normalised stats. */
  movingSeconds: number;
}
