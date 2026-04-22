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
  | 'crash';

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
