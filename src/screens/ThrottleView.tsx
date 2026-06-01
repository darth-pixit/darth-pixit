import React, { useEffect, useRef, useMemo, useState } from 'react';
import {
  View,
  Text,
  Animated,
  Easing,
  StyleSheet,
  Dimensions,
  TouchableOpacity,
  StatusBar,
  SafeAreaView,
  Alert,
  Modal,
  FlatList,
  ActivityIndicator,
} from 'react-native';
import { useOBDStore } from '../obd/OBDStore';
import { OBDStatusBanner } from '../obd/OBDStatusBanner';
import { VehicleCfg } from '../obd/OBDManager';
import { useAuth } from '../auth/AuthContext';
import { useAutoConnect } from '../obd/useAutoConnect';
import { useTripStore } from '../trips/TripStore';
import { Trip } from '../trips/TripDetector';
import { VitalsScreen } from './VitalsScreen';
import { DriverScoreScreen } from './DriverScoreScreen';

const { width: SW } = Dimensions.get('window');
const PAD = 24;
const TRACK_W = SW - PAD * 2;
const TRACK_H = 72;
const THUMB_W = 6;
const CORNER = 14;

const ECO_LIMIT = 0.40;
const MOD_LIMIT = 0.70;

// Reversed-orientation gradient anchors (t=0 is left edge, t=1 is right edge).
// Left = push (red), middle = moderate (amber), right = eco (green).
// Amber anchor sits at t=0.45 — the midpoint of the moderate band in screen space
// (push occupies left 30%, eco occupies right 40%, moderate is the middle 30%).
const GRADIENT_STRIPS = 36;
const BG_RED = '#3d0000';
const BG_AMBER = '#3d1f00';
const BG_GREEN = '#052e16';
const AMBER_ANCHOR = 0.45;

function lerpHex(a: string, b: string, t: number): string {
  const ar = parseInt(a.slice(1, 3), 16);
  const ag = parseInt(a.slice(3, 5), 16);
  const ab = parseInt(a.slice(5, 7), 16);
  const br = parseInt(b.slice(1, 3), 16);
  const bg = parseInt(b.slice(3, 5), 16);
  const bb = parseInt(b.slice(5, 7), 16);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const c = Math.round(ab + (bb - ab) * t);
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(c)}`;
}

const BG_STRIP_COLORS: string[] = Array.from({ length: GRADIENT_STRIPS }, (_, i) => {
  const t = i / (GRADIENT_STRIPS - 1);
  return t < AMBER_ANCHOR
    ? lerpHex(BG_RED, BG_AMBER, t / AMBER_ANCHOR)
    : lerpHex(BG_AMBER, BG_GREEN, (t - AMBER_ANCHOR) / (1 - AMBER_ANCHOR));
});

const BIN_COUNT = 4;
function binIndex(throttle: number): number {
  const i = Math.floor(throttle * BIN_COUNT);
  return i < 0 ? 0 : i >= BIN_COUNT ? BIN_COUNT - 1 : i;
}

const BADGE_W = 78;
const BADGE_H = 28;

interface Zone {
  id: 'eco' | 'moderate' | 'push';
  color: string;
  label: string;
  nudge: string;
  coaching: string;
}

const ZONES: Zone[] = [
  {
    id: 'eco',
    color: '#22C55E',
    label: 'Eco Zone',
    nudge: 'Smooth & efficient — great job!',
    coaching: 'Perfect — keep this pace.',
  },
  {
    id: 'moderate',
    color: '#F59E0B',
    label: 'Moderate',
    nudge: 'Ease up a bit for better mileage.',
    coaching: 'Ease off a little to save fuel.',
  },
  {
    id: 'push',
    color: '#EF4444',
    label: 'Push Zone',
    nudge: 'Ease off — heavy throttle burns fuel!',
    coaching: 'Back off — you\'re burning extra fuel.',
  },
];

function getZone(v: number): Zone {
  if (v <= ECO_LIMIT) return ZONES[0];
  if (v <= MOD_LIMIT) return ZONES[1];
  return ZONES[2];
}

const DEFAULT_VEHICLE: VehicleCfg = {
  stoichAFR: 14.7,
  fuelDensityGPerL: 740,
  displacementL: 1.0,
  volEfficiency: 0.82,
  redlineRPM: 6500,
};

// ─── Trip detection helpers ───────────────────────────────────────────────────

function fmtElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m > 0 ? m : 1}m`;
}

function fmtDate(ts: number): string {
  const d = new Date(ts);
  return (
    d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
    ' · ' +
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  );
}

function ecoLabel(pct: number): string {
  if (pct >= 70) return 'Excellent drive';
  if (pct >= 50) return 'Good drive';
  if (pct >= 30) return 'Room to improve';
  return 'High fuel usage';
}

// ─── Trip summary modal ───────────────────────────────────────────────────────

function TripSummaryModal({ trip, onDismiss }: { trip: Trip; onDismiss: () => void }) {
  const ecoColor = trip.ecoTimePct >= 70 ? '#22C55E' : trip.ecoTimePct >= 40 ? '#F59E0B' : '#EF4444';
  return (
    <Modal transparent animationType="slide" onRequestClose={onDismiss}>
      <View style={modal.overlay}>
        <View style={modal.card}>
          <Text style={modal.header}>Trip Complete</Text>
          <Text style={[modal.score, { color: ecoColor }]}>{ecoLabel(trip.ecoTimePct)}</Text>
          <View style={modal.statsGrid}>
            <StatCell label="Distance"  value={`${trip.distanceKm} km`} />
            <StatCell label="Duration"  value={fmtDuration(trip.durationSec)} />
            <StatCell label="Avg speed" value={`${trip.avgSpeedKmH} km/h`} />
            <StatCell label="Max speed" value={`${trip.maxSpeedKmH} km/h`} />
            {trip.totalFuelL > 0 && <StatCell label="Fuel used" value={`${trip.totalFuelL} L`} />}
          </View>
          <View style={modal.barRow}>
            <View style={[modal.barSeg, { flex: trip.ecoTimePct, backgroundColor: '#22C55E' }]} />
            <View style={[modal.barSeg, { flex: trip.modTimePct, backgroundColor: '#F59E0B' }]} />
            <View style={[modal.barSeg, { flex: trip.pushTimePct, backgroundColor: '#EF4444' }]} />
          </View>
          <View style={modal.barLabels}>
            <Text style={[modal.barLbl, { color: '#22C55E' }]}>{trip.ecoTimePct}% eco</Text>
            <Text style={[modal.barLbl, { color: '#F59E0B' }]}>{trip.modTimePct}% mod</Text>
            <Text style={[modal.barLbl, { color: '#EF4444' }]}>{trip.pushTimePct}% push</Text>
          </View>
          <TouchableOpacity style={modal.btn} onPress={onDismiss}>
            <Text style={modal.btnText}>Done</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <View style={modal.statCell}>
      <Text style={modal.statVal}>{value}</Text>
      <Text style={modal.statLbl}>{label}</Text>
    </View>
  );
}

// ─── Trip history modal ───────────────────────────────────────────────────────

function TripHistoryModal({ trips, onClose }: { trips: Trip[]; onClose: () => void }) {
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <View style={hist.overlay}>
        <View style={hist.sheet}>
          <View style={hist.titleRow}>
            <Text style={hist.title}>Trip History</Text>
            <TouchableOpacity onPress={onClose}>
              <Text style={hist.close}>✕</Text>
            </TouchableOpacity>
          </View>
          {trips.length === 0 ? (
            <Text style={hist.empty}>No trips recorded yet.</Text>
          ) : (
            <FlatList
              data={trips}
              keyExtractor={(t) => t.id}
              renderItem={({ item }) => <TripRow trip={item} />}
              ItemSeparatorComponent={() => <View style={hist.sep} />}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

function TripRow({ trip }: { trip: Trip }) {
  const ecoColor = trip.ecoTimePct >= 70 ? '#22C55E' : trip.ecoTimePct >= 40 ? '#F59E0B' : '#EF4444';
  return (
    <View style={hist.row}>
      <View style={{ flex: 1 }}>
        <Text style={hist.rowDate}>{fmtDate(trip.startTime)}</Text>
        <Text style={hist.rowSub}>
          {trip.distanceKm} km · {fmtDuration(trip.durationSec)}
          {trip.totalFuelL > 0 ? ` · ${trip.totalFuelL} L` : ''}
        </Text>
      </View>
      <Text style={[hist.rowEco, { color: ecoColor }]}>{trip.ecoTimePct}%{'\n'}eco</Text>
    </View>
  );
}

// ─── Main screen ─────────────────────────────────────────────────────────────

export function ThrottleView() {
  const { engineLoadPct, rpm, state, fuelRateLPerH, speedKmH, start, stop } = useOBDStore();
  const { signOut } = useAuth();
  const { autoConnectState, completeSetup } = useAutoConnect(DEFAULT_VEHICLE);
  // ── trip detection ──
  const { currentTripStart, recentTrip, dismissRecentTrip, trips, loadTrips } = useTripStore();
  const [elapsed, setElapsed] = useState(0);
  const [showHistory, setShowHistory] = useState(false);
  // ───────────────────
  const [isDemoMode, setIsDemoMode] = useState(false);
  const [demoThrottle, setDemoThrottle] = useState(0);
  const [tripAvgKmL, setTripAvgKmL] = useState<number | null>(null);
  const [setupBlocked, setSetupBlocked] = useState(false);
  const [showVitals, setShowVitals] = useState(false);
  const [showDriverScore, setShowDriverScore] = useState(false);

  // Refs so the accumulation interval always reads fresh values without
  // needing engineLoadPct/rpm/fuelRate/speed in its dependency array.
  const demoThrottleRef = useRef(demoThrottle);
  const fuelRateRef = useRef(fuelRateLPerH);
  const speedRef = useRef(speedKmH);
  const obdThrottleRef = useRef(0);
  useEffect(() => { demoThrottleRef.current = demoThrottle; }, [demoThrottle]);
  useEffect(() => { fuelRateRef.current = fuelRateLPerH; }, [fuelRateLPerH]);
  useEffect(() => { speedRef.current = speedKmH; }, [speedKmH]);
  useEffect(() => {
    obdThrottleRef.current = engineLoadPct != null
      ? Math.max(0, Math.min(1, engineLoadPct / 100))
      : rpm != null
      ? Math.max(0, Math.min(1, rpm / 6000))
      : 0;
  }, [engineLoadPct, rpm]);

  const tripFuelRef = useRef(0);
  const tripDistRef = useRef(0);

  const binFuelRef = useRef<number[]>(Array(BIN_COUNT).fill(0));
  const binDistRef = useRef<number[]>(Array(BIN_COUNT).fill(0));
  const [binAvgs, setBinAvgs] = useState<(number | null)[]>(Array(BIN_COUNT).fill(null));

  // Load persisted trips once on mount
  useEffect(() => { loadTrips(); }, []);

  // Demo mode: animated sine-wave throttle simulation
  useEffect(() => {
    if (!isDemoMode) return;
    let frame = 0;
    const id = setInterval(() => {
      frame++;
      const base = Math.sin(frame * 0.07) * 0.38 + 0.38;
      const jitter = (Math.random() - 0.5) * 0.06;
      setDemoThrottle(Math.max(0, Math.min(1, base + jitter)));
    }, 100);
    return () => clearInterval(id);
  }, [isDemoMode]);

  const hasLiveData = isDemoMode || state === 'ready';

  // Live instantaneous km/L derived directly from store values.
  const liveKmL = useMemo(() => {
    if (!hasLiveData) return null;
    if (isDemoMode) {
      const fr = 0.8 + demoThrottle * 9;
      const sp = 20 + demoThrottle * 60;
      return fr > 0.1 && sp > 0.5 ? sp / fr : null;
    }
    if (fuelRateLPerH != null && speedKmH != null && fuelRateLPerH > 0.1 && speedKmH > 0.5) {
      return speedKmH / fuelRateLPerH;
    }
    return null;
  }, [hasLiveData, isDemoMode, demoThrottle, fuelRateLPerH, speedKmH]);

  // Reset accumulators when the OBD session truly ends (idle or error) or when
  // demo mode toggles. Transient states (reconnecting, scanning, connecting) are
  // NOT terminal — the 90s TripDetector drain keeps the trip alive through brief
  // signal drops, so we must not wipe the running averages here.
  useEffect(() => {
    const shouldReset = isDemoMode
      ? false  // demo toggle handled by the effect below
      : state === 'idle' || state === 'error';
    if (shouldReset) {
      tripFuelRef.current = 0;
      tripDistRef.current = 0;
      binFuelRef.current = Array(BIN_COUNT).fill(0);
      binDistRef.current = Array(BIN_COUNT).fill(0);
      setTripAvgKmL(null);
      setBinAvgs(Array(BIN_COUNT).fill(null));
    }
  }, [isDemoMode, state]);

  useEffect(() => {
    tripFuelRef.current = 0;
    tripDistRef.current = 0;
    binFuelRef.current = Array(BIN_COUNT).fill(0);
    binDistRef.current = Array(BIN_COUNT).fill(0);
    setTripAvgKmL(null);
    setBinAvgs(Array(BIN_COUNT).fill(null));
  }, [isDemoMode]);

  // Accumulate fuel & distance every 500ms — trip average + per-bin averages.
  useEffect(() => {
    if (!hasLiveData) return;
    const id = setInterval(() => {
      const dt = 0.5 / 3600;
      let fr: number;
      let sp: number;
      let t: number;
      if (isDemoMode) {
        t = demoThrottleRef.current;
        fr = 0.8 + t * 9;
        sp = 20 + t * 60;
      } else {
        t = obdThrottleRef.current;
        fr = fuelRateRef.current ?? 0;
        sp = speedRef.current ?? 0;
        if (!Number.isFinite(fr)) fr = 0;
        if (!Number.isFinite(sp)) sp = 0;
      }
      if (fr > 0.1 && sp > 0.5) {
        tripFuelRef.current += fr * dt;
        tripDistRef.current += sp * dt;
        if (tripFuelRef.current > 0.005) {
          setTripAvgKmL(tripDistRef.current / tripFuelRef.current);
        }
        const bi = binIndex(t);
        binFuelRef.current[bi] += fr * dt;
        binDistRef.current[bi] += sp * dt;
        setBinAvgs(
          binFuelRef.current.map((f, i) =>
            f > 0.01 ? binDistRef.current[i] / f : null,
          ),
        );
      }
    }, 500);
    return () => clearInterval(id);
  }, [hasLiveData, isDemoMode]);

  // Live elapsed-time counter for active trip
  useEffect(() => {
    if (!currentTripStart) { setElapsed(0); return; }
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - currentTripStart) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [currentTripStart]);

  const throttle = useMemo(() => {
    if (isDemoMode) return demoThrottle;
    if (engineLoadPct != null) return Math.max(0, Math.min(1, engineLoadPct / 100));
    if (rpm != null) return Math.max(0, Math.min(1, rpm / 6000));
    return 0;
  }, [isDemoMode, demoThrottle, engineLoadPct, rpm]);

  const zone = getZone(throttle);

  // Low-pass filter to kill high-frequency jitter from OBD polling.
  const [smoothedThrottle, setSmoothedThrottle] = useState(0);
  const throttleRef = useRef(throttle);
  useEffect(() => { throttleRef.current = throttle; }, [throttle]);
  useEffect(() => {
    const id = setInterval(() => {
      setSmoothedThrottle((prev) => prev * 0.65 + throttleRef.current * 0.35);
    }, 60);
    return () => clearInterval(id);
  }, []);

  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: smoothedThrottle,
      duration: 150,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [smoothedThrottle]);

  // Reversed orientation: throttle=0 → thumb at right (eco); throttle=1 → thumb at left (push).
  const fillWidth = anim.interpolate({ inputRange: [0, 1], outputRange: [0, TRACK_W], extrapolate: 'clamp' });
  const thumbLeft = anim.interpolate({ inputRange: [0, 1], outputRange: [TRACK_W - THUMB_W, 0], extrapolate: 'clamp' });
  const fillColor = anim.interpolate({
    inputRange: [0, ECO_LIMIT, MOD_LIMIT, 1],
    outputRange: ['#22C55E', '#F59E0B', '#EF4444', '#EF4444'],
    extrapolate: 'clamp',
  });
  const badgeLeft = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [TRACK_W - BADGE_W, 0],
    extrapolate: 'clamp',
  });

  const obdActive = state === 'ready' || state === 'reconnecting' || state === 'connecting' || state === 'scanning';

  function idleNudge(): string {
    if (state === 'error') return 'OBD connection failed. Tap Retry or try Demo mode.';
    if (state === 'idle') return 'OBD adapter disconnected. Tap Reconnect or try Demo mode.';
    return 'Tap "Try Demo" to preview while the adapter connects.';
  }

  // Onboarding overlay (first launch only — skipped if already in demo mode)
  if (!isDemoMode && autoConnectState.phase === 'needs_setup') {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="light-content" backgroundColor="#0D0D0D" />
        <View style={styles.onboardingBody}>
          <Text style={styles.onboardingTitle}>Auto-Connect OBD</Text>
          <Text style={styles.onboardingBody2}>
            Darth-Pixit will scan for your OBD Bluetooth adapter every time you open the app and
            start streaming data automatically — no tapping required after this.
          </Text>
          <Text style={styles.onboardingBody2}>
            Bluetooth access is required to communicate with the adapter.
          </Text>
          {setupBlocked && (
            <Text style={styles.onboardingError}>
              Bluetooth permission denied. Enable it in Settings and try again.
            </Text>
          )}
          <TouchableOpacity
            style={[styles.btn, styles.btnPrimary, styles.onboardingCta]}
            onPress={async () => {
              setSetupBlocked(false);
              const ok = await completeSetup();
              if (!ok) setSetupBlocked(true);
            }}
          >
            <Text style={styles.btnText}>Enable Auto-Connect</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btn, styles.btnOutline]}
            onPress={() => setIsDemoMode(true)}
          >
            <Text style={[styles.btnText, styles.btnTextMuted]}>Try Demo first</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (autoConnectState.phase === 'loading') {
    return (
      <SafeAreaView style={styles.safe}>
        <ActivityIndicator size="large" color="#22C55E" style={styles.loadingSpinner} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor="#0D0D0D" />
      <OBDStatusBanner />

      {/* Trip active indicator */}
      {currentTripStart !== null && (
        <View style={styles.tripChip}>
          <View style={styles.tripDot} />
          <Text style={styles.tripChipText}>TRIP  {fmtElapsed(elapsed)}</Text>
        </View>
      )}

      <View style={styles.body}>

        {/* Nudge message box */}
        <View style={[styles.nudgeBox, { borderColor: hasLiveData ? zone.color + '55' : '#2a2a2a' }]}>
          <Text style={[styles.nudgeText, { color: hasLiveData ? zone.color : '#555' }]}>
            {hasLiveData ? zone.nudge : idleNudge()}
          </Text>
        </View>

        {/* Zone label */}
        <Text style={[styles.zoneLabel, { color: hasLiveData ? zone.color + 'AA' : '#333' }]}>
          {hasLiveData ? zone.label.toUpperCase() : '— —'}
        </Text>

        {/* Coaching copy */}
        {hasLiveData ? (
          <Text style={[styles.coaching, { color: zone.color }]}>
            {zone.coaching}
          </Text>
        ) : null}

        {/* Live km/L badge — floats above the thumb */}
        <View style={styles.badgeRow}>
          {hasLiveData && liveKmL != null && Number.isFinite(liveKmL) ? (
            <Animated.View style={[styles.liveBadge, { left: badgeLeft, borderColor: zone.color }]}>
              <Text style={styles.liveBadgeVal}>{liveKmL.toFixed(1)}</Text>
              <Text style={styles.liveBadgeUnit}>km/L</Text>
            </Animated.View>
          ) : null}
        </View>

        {/* Horizontal gauge — reversed: red on left, green on right */}
        <View style={styles.gaugeOuter}>
          <View style={[StyleSheet.absoluteFill, styles.stripRow]} pointerEvents="none">
            {BG_STRIP_COLORS.map((c, i) => (
              <View key={i} style={{ flex: 1, backgroundColor: c }} />
            ))}
          </View>
          <Animated.View
            style={[styles.fill, { width: fillWidth, backgroundColor: fillColor }]}
            pointerEvents="none"
          />
          <Animated.View style={[styles.thumb, { left: thumbLeft }]} />
        </View>

        {/* Zone marker labels — mirrored: PUSH | MOD | ECO */}
        <View style={styles.markerRow}>
          <View style={{ flex: 30, alignItems: 'center' }}>
            <Text style={[styles.markerLabel, { color: '#EF4444' }]}>PUSH</Text>
          </View>
          <View style={{ flex: 30, alignItems: 'center' }}>
            <Text style={[styles.markerLabel, { color: '#F59E0B' }]}>MOD</Text>
          </View>
          <View style={{ flex: 40, alignItems: 'center' }}>
            <Text style={[styles.markerLabel, { color: '#22C55E' }]}>ECO</Text>
          </View>
        </View>

        {/* Per-bin km/L row */}
        <View style={styles.binRow}>
          {[3, 2, 1, 0].map((i) => {
            const v = binAvgs[i];
            return (
              <View key={i} style={styles.binCell}>
                <Text style={styles.binVal}>
                  {v != null && Number.isFinite(v) ? v.toFixed(1) : '—'}
                </Text>
                <Text style={styles.binUnit}>km/L</Text>
              </View>
            );
          })}
        </View>

        {/* Trip average mileage */}
        {tripAvgKmL != null ? (
          <View style={styles.tripRow}>
            <Text style={styles.tripLabel}>TRIP AVG</Text>
            <Text style={styles.tripVal}>{tripAvgKmL.toFixed(1)}</Text>
            <Text style={styles.tripUnit}>km/L</Text>
          </View>
        ) : null}

        {/* Live stats row */}
        <View style={styles.statsRow}>
          {rpm != null ? (
            <View style={styles.statBlock}>
              <Text style={styles.statVal}>{Math.round(rpm).toLocaleString()}</Text>
              <Text style={styles.statLbl}>RPM</Text>
            </View>
          ) : null}
          {speedKmH != null ? (
            <View style={styles.statBlock}>
              <Text style={styles.statVal}>{Math.round(speedKmH)}</Text>
              <Text style={styles.statLbl}>km/h</Text>
            </View>
          ) : null}
          {fuelRateLPerH != null && state === 'ready' ? (
            <View style={styles.statBlock}>
              <Text style={styles.statVal}>{fuelRateLPerH.toFixed(1)}</Text>
              <Text style={styles.statLbl}>L/h</Text>
            </View>
          ) : null}
          {!hasLiveData ? (
            <Text style={styles.noDataHint}>Live RPM, speed & fuel rate appear here</Text>
          ) : null}
        </View>

        {/* Action buttons */}
        <View style={styles.actions}>
          {obdActive ? (
            <TouchableOpacity style={[styles.btn, styles.btnDanger]} onPress={() => stop()}>
              <Text style={styles.btnText}>Disconnect OBD</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={[styles.btn, styles.btnPrimary]} onPress={() => start(DEFAULT_VEHICLE)}>
              <Text style={styles.btnText}>{state === 'error' ? 'Retry' : 'Reconnect'}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.btn, isDemoMode ? styles.btnAccent : styles.btnOutline]}
            onPress={() => setIsDemoMode((d) => !d)}
          >
            <Text style={[styles.btnText, !isDemoMode && styles.btnTextMuted]}>
              {isDemoMode ? 'Stop Demo' : 'Try Demo'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* My Driving Score */}
        <TouchableOpacity style={styles.vitalsBtn} onPress={() => setShowDriverScore(true)}>
          <Text style={styles.vitalsText}>My Driving Score</Text>
          <Text style={styles.vitalsChevron}></Text>
        </TouchableOpacity>

        {/* All Vitals */}
        <TouchableOpacity style={styles.vitalsBtn} onPress={() => setShowVitals(true)}>
          <Text style={styles.vitalsText}>View All Vitals</Text>
          <Text style={styles.vitalsChevron}></Text>
        </TouchableOpacity>

        {/* Footer: trips history link + sign out */}
        <View style={styles.footer}>
          {trips.length > 0 && (
            <TouchableOpacity onPress={() => setShowHistory(true)}>
              <Text style={styles.tripsLink}>
                {trips.length} trip{trips.length !== 1 ? 's' : ''} recorded
              </Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.signOutBtn}
            onPress={() => {
              Alert.alert('Sign out', 'Are you sure you want to sign out?', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Sign out', style: 'destructive', onPress: signOut },
              ]);
            }}
          >
            <Text style={styles.signOutText}>Sign out</Text>
          </TouchableOpacity>
        </View>

      </View>

      {/* Post-trip summary — slides up automatically after a trip ends */}
      {recentTrip && (
        <TripSummaryModal trip={recentTrip} onDismiss={dismissRecentTrip} />
      )}

      {/* Trip history sheet */}
      {showHistory && (
        <TripHistoryModal trips={trips} onClose={() => setShowHistory(false)} />
      )}

      <VitalsScreen visible={showVitals} onClose={() => setShowVitals(false)} />
      <DriverScoreScreen visible={showDriverScore} onClose={() => setShowDriverScore(false)} />
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#0D0D0D',
  },
  loadingSpinner: {
    flex: 1,
  },
  body: {
    flex: 1,
    paddingHorizontal: PAD,
    paddingTop: 28,
    paddingBottom: 16,
    gap: 16,
  },
  nudgeBox: {
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: 20,
    alignItems: 'center',
    backgroundColor: '#111',
    minHeight: 72,
    justifyContent: 'center',
  },
  nudgeText: {
    fontSize: 17,
    fontWeight: '600',
    textAlign: 'center',
    lineHeight: 24,
  },
  zoneLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 2.5,
    textAlign: 'center',
  },
  coaching: {
    fontSize: 15,
    fontWeight: '500',
    textAlign: 'center',
    opacity: 0.85,
  },
  gaugeOuter: {
    width: TRACK_W,
    height: TRACK_H,
    borderRadius: CORNER,
    overflow: 'hidden',
    position: 'relative',
    backgroundColor: '#1a1a1a',
  },
  fill: {
    position: 'absolute',
    top: 0,
    left: 0,
    height: TRACK_H,
    opacity: 0.42,
  },
  stripRow: {
    flexDirection: 'row',
  },
  thumb: {
    position: 'absolute',
    top: 0,
    width: THUMB_W,
    height: TRACK_H,
    backgroundColor: '#FFFFFF',
    borderRadius: THUMB_W / 2,
    shadowColor: '#FFFFFF',
    shadowOpacity: 0.7,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
  },
  markerRow: {
    flexDirection: 'row',
    width: TRACK_W,
  },
  markerLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  badgeRow: {
    width: TRACK_W,
    height: BADGE_H + 4,
    position: 'relative',
  },
  liveBadge: {
    position: 'absolute',
    top: 0,
    width: BADGE_W,
    height: BADGE_H,
    borderRadius: BADGE_H / 2,
    borderWidth: 1,
    backgroundColor: 'rgba(17,17,17,0.92)',
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
    gap: 4,
  },
  liveBadgeVal: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  liveBadgeUnit: {
    color: '#888',
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 0.8,
  },
  binRow: {
    flexDirection: 'row',
    width: TRACK_W,
    marginTop: 2,
  },
  binCell: {
    flex: 1,
    alignItems: 'center',
  },
  binVal: {
    color: '#888',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  binUnit: {
    color: '#333',
    fontSize: 8,
    fontWeight: '600',
    letterSpacing: 0.8,
    marginTop: 1,
  },
  tripRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
    gap: 6,
  },
  tripLabel: {
    color: '#444',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  tripVal: {
    color: '#FFFFFF',
    fontSize: 26,
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  tripUnit: {
    color: '#555',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 1,
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 40,
    flex: 1,
    alignItems: 'center',
  },
  statBlock: {
    alignItems: 'center',
  },
  statVal: {
    color: '#FFFFFF',
    fontSize: 30,
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  statLbl: {
    color: '#555',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1.5,
    marginTop: 2,
  },
  noDataHint: {
    color: '#333',
    fontSize: 13,
    textAlign: 'center',
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'center',
  },
  btn: {
    paddingVertical: 13,
    paddingHorizontal: 22,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 140,
  },
  btnPrimary: { backgroundColor: '#22C55E' },
  btnDanger: { backgroundColor: '#EF4444' },
  btnAccent: { backgroundColor: '#3B82F6' },
  btnOutline: { borderWidth: 1, borderColor: '#2a2a2a' },
  btnText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
  btnTextMuted: { color: '#555' },
  vitalsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1F1F1F',
    backgroundColor: '#111',
  },
  vitalsText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  vitalsChevron: {
    color: '#555',
    fontSize: 18,
    lineHeight: 18,
  },

  // Trip active chip
  tripChip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 6,
    backgroundColor: '#052e16',
  },
  tripDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#22C55E' },
  tripChipText: { color: '#22C55E', fontSize: 13, fontWeight: '700', letterSpacing: 1.5 },

  // Footer
  footer: {
    alignItems: 'center',
    gap: 6,
  },
  tripsLink: {
    color: '#3B82F6',
    fontSize: 13,
    fontWeight: '500',
  },
  signOutBtn: {
    alignItems: 'center',
    paddingVertical: 6,
  },
  signOutText: {
    color: '#333',
    fontSize: 13,
    fontWeight: '500',
  },

  // Onboarding screen
  onboardingBody: {
    flex: 1,
    paddingHorizontal: PAD,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 20,
  },
  onboardingTitle: {
    color: '#FFFFFF',
    fontSize: 26,
    fontWeight: '700',
    letterSpacing: -0.5,
    textAlign: 'center',
  },
  onboardingBody2: {
    color: '#888',
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
  onboardingError: {
    color: '#EF4444',
    fontSize: 13,
    textAlign: 'center',
  },
  onboardingCta: {
    width: '100%',
    marginTop: 8,
  },
});

// ─── Trip summary modal styles ────────────────────────────────────────────────

const modal = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  card: { backgroundColor: '#141414', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 28, paddingBottom: 40, gap: 16 },
  header: { color: '#FFFFFF', fontSize: 22, fontWeight: '800', textAlign: 'center' },
  score: { fontSize: 16, fontWeight: '600', textAlign: 'center' },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, justifyContent: 'center' },
  statCell: { alignItems: 'center', minWidth: 90 },
  statVal: { color: '#FFFFFF', fontSize: 22, fontWeight: '700' },
  statLbl: { color: '#555', fontSize: 11, fontWeight: '600', letterSpacing: 1, marginTop: 2 },
  barRow: { flexDirection: 'row', height: 10, borderRadius: 5, overflow: 'hidden' },
  barSeg: { height: 10 },
  barLabels: { flexDirection: 'row', justifyContent: 'space-between' },
  barLbl: { fontSize: 11, fontWeight: '600' },
  btn: { backgroundColor: '#22C55E', paddingVertical: 14, borderRadius: 12, alignItems: 'center', marginTop: 4 },
  btnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
});

// ─── Trip history modal styles ────────────────────────────────────────────────

const hist = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#141414', borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '80%', paddingBottom: 40 },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 24, paddingBottom: 16 },
  title: { color: '#FFFFFF', fontSize: 20, fontWeight: '800' },
  close: { color: '#555', fontSize: 20, fontWeight: '600' },
  empty: { color: '#555', textAlign: 'center', padding: 40 },
  sep: { height: 1, backgroundColor: '#1f1f1f', marginHorizontal: 24 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 24, paddingVertical: 14 },
  rowDate: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
  rowSub: { color: '#555', fontSize: 12, marginTop: 3 },
  rowEco: { fontSize: 13, fontWeight: '700', textAlign: 'right', lineHeight: 18 },
});
