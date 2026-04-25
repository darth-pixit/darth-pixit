import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
} from 'react-native';
import { useSafetyStore } from '../safety/SafetyStore';
import {
  VehicleFamily,
  metricsForFamily,
  scoreColor,
  scoreLabel,
} from '../safety/metrics';
import { TripRecord, SafetyScore, SafetyEvent } from '../safety/types';

type Period = 'today' | 'week' | 'month';

const { width: SCREEN_W } = Dimensions.get('window');
const PAD = 20;
const RING_SIZE = 148;

// ---------- helpers ----------

function periodStartMs(period: Period): number {
  const now = Date.now();
  if (period === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (period === 'week') return now - 7 * 24 * 3600 * 1000;
  return now - 30 * 24 * 3600 * 1000;
}

function filterTrips(trips: TripRecord[], period: Period): TripRecord[] {
  const start = periodStartMs(period);
  return trips.filter(t => t.startedAt >= start);
}

function averageComposite(trips: TripRecord[]): number | null {
  const scored = trips.filter(t => t.score !== null);
  if (scored.length === 0) return null;
  return scored.reduce((sum, t) => sum + t.score!.composite, 0) / scored.length;
}

function metricScoreFromSafetyScore(score: SafetyScore | null, key: string): number | null {
  if (!score) return null;
  switch (key) {
    case 'speeding': return score.speeding.score;
    case 'braking':  return score.braking.score;
    case 'cornering': return score.cornering.score;
    case 'accel':    return score.acceleration.score;
    case 'phone':    return score.distracted.score;
    default:         return null;
  }
}

function avgMetricAcrossTrips(trips: TripRecord[], key: string): number | null {
  const values: number[] = [];
  for (const trip of trips) {
    const v = metricScoreFromSafetyScore(trip.score, key);
    if (v !== null) values.push(v);
  }
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function eventCountForType(events: SafetyEvent[], type: string): number {
  return events.filter(e => e.type === type).length;
}

function seatbeltScoreFromTrips(trips: TripRecord[]): number | null {
  const relevant = trips.filter(t => t.events.length > 0 || t.score !== null);
  if (relevant.length === 0) return null;
  const seatbeltEvents = relevant.reduce(
    (sum, t) => sum + eventCountForType(t.events, 'seatbelt_off'), 0,
  );
  // Each seatbelt_off event costs 5 points, cap at 0
  return Math.max(0, 100 - seatbeltEvents * 5);
}

function laneChangeScoreFromTrips(trips: TripRecord[]): number | null {
  const relevant = trips.filter(t => t.score !== null || t.events.length > 0);
  if (relevant.length === 0) return null;
  const total = relevant.reduce(
    (sum, t) => sum + eventCountForType(t.events, 'lane_change'), 0,
  );
  return Math.max(0, 100 - total * 2);
}

function engineAbuseScoreFromTrips(trips: TripRecord[]): number | null {
  const relevant = trips.filter(t => t.score !== null || t.events.length > 0);
  if (relevant.length === 0) return null;
  const total = relevant.reduce(
    (sum, t) => sum + eventCountForType(t.events, 'engine_abuse'), 0,
  );
  return Math.max(0, 100 - total * 4);
}

function idlingScoreFromTrips(trips: TripRecord[]): number | null {
  const relevant = trips.filter(t => t.score !== null || t.events.length > 0);
  if (relevant.length === 0) return null;
  const total = relevant.reduce(
    (sum, t) => sum + eventCountForType(t.events, 'idling'), 0,
  );
  return Math.max(0, 100 - total * 3);
}

function drowsyScoreFromTrips(trips: TripRecord[]): number | null {
  const relevant = trips.filter(t => t.drowsinessEvents.length > 0 || t.score !== null);
  if (relevant.length === 0) return null;
  const total = relevant.reduce((sum, t) => sum + t.drowsinessEvents.length, 0);
  return Math.max(0, 100 - total * 8);
}

function getMetricScore(trips: TripRecord[], key: string): number | null {
  switch (key) {
    case 'seatbelt':     return seatbeltScoreFromTrips(trips);
    case 'lane_change':  return laneChangeScoreFromTrips(trips);
    case 'engine_abuse': return engineAbuseScoreFromTrips(trips);
    case 'idling':       return idlingScoreFromTrips(trips);
    case 'drowsy':       return drowsyScoreFromTrips(trips);
    default:             return avgMetricAcrossTrips(trips, key);
  }
}

function formatDistance(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m)} m`;
}

function formatDuration(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// ---------- sub-components ----------

function VehicleClassToggle({
  family,
  onChange,
}: {
  family: VehicleFamily;
  onChange: (f: VehicleFamily) => void;
}) {
  return (
    <View style={toggle.row}>
      {(['2w', '4w'] as VehicleFamily[]).map(f => (
        <TouchableOpacity
          key={f}
          style={[toggle.pill, family === f && toggle.pillActive]}
          onPress={() => onChange(f)}
          activeOpacity={0.7}
        >
          <Text style={[toggle.label, family === f && toggle.labelActive]}>
            {f === '2w' ? '2-Wheeler' : '4-Wheeler'}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function PeriodToggle({
  period,
  onChange,
}: {
  period: Period;
  onChange: (p: Period) => void;
}) {
  const options: { key: Period; label: string }[] = [
    { key: 'today', label: 'Today' },
    { key: 'week',  label: '7 Days' },
    { key: 'month', label: '30 Days' },
  ];
  return (
    <View style={toggle.row}>
      {options.map(o => (
        <TouchableOpacity
          key={o.key}
          style={[toggle.pill, period === o.key && toggle.pillActive]}
          onPress={() => onChange(o.key)}
          activeOpacity={0.7}
        >
          <Text style={[toggle.label, period === o.key && toggle.labelActive]}>
            {o.label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function ScoreHero({
  score,
  isLive,
  tripCount,
}: {
  score: number | null;
  isLive: boolean;
  tripCount: number;
}) {
  const color = scoreColor(score);
  const label = scoreLabel(score);
  return (
    <View style={hero.card}>
      {isLive && (
        <View style={hero.liveBadge}>
          <Text style={hero.liveText}>LIVE</Text>
        </View>
      )}
      <View style={[hero.ring, { borderColor: color }]}>
        <Text style={[hero.scoreNum, { color }]}>
          {score !== null ? Math.round(score) : '—'}
        </Text>
        <Text style={hero.scoreUnit}>/ 100</Text>
      </View>
      <Text style={[hero.label, { color }]}>{label}</Text>
      <Text style={hero.sub}>
        {tripCount === 0
          ? 'No trips in this period'
          : `${tripCount} trip${tripCount !== 1 ? 's' : ''} averaged`}
      </Text>
    </View>
  );
}

function MetricBar({ score }: { score: number | null }) {
  const filled = score !== null ? score / 100 : 0;
  const color = scoreColor(score);
  return (
    <View style={bar.track}>
      <View style={[bar.fill, { width: `${filled * 100}%` as any, backgroundColor: color }]} />
    </View>
  );
}

function MetricRow({ label, score }: { label: string; score: number | null }) {
  const color = scoreColor(score);
  return (
    <View style={row.container}>
      <Text style={row.label}>{label}</Text>
      <View style={row.barWrap}>
        <MetricBar score={score} />
      </View>
      <Text style={[row.score, { color }]}>
        {score !== null ? Math.round(score) : '—'}
      </Text>
    </View>
  );
}

function TripCard({ trip }: { trip: TripRecord }) {
  const color = scoreColor(trip.score?.composite ?? null);
  const scoreNum = trip.score !== null ? Math.round(trip.score.composite) : null;
  return (
    <View style={card.container}>
      <View style={card.left}>
        <Text style={card.date}>{formatDate(trip.startedAt)}</Text>
        <Text style={card.meta}>
          {formatDistance(trip.distanceM)}
          {'  ·  '}
          {formatDuration(trip.activeDurationMs)}
          {'  ·  '}
          {trip.events.length} event{trip.events.length !== 1 ? 's' : ''}
        </Text>
      </View>
      <View style={[card.badge, { borderColor: color }]}>
        <Text style={[card.badgeText, { color }]}>
          {scoreNum !== null ? scoreNum : '—'}
        </Text>
      </View>
    </View>
  );
}

function EmptyTripsPlaceholder() {
  return (
    <View style={empty.box}>
      <Text style={empty.icon}>🛣</Text>
      <Text style={empty.title}>No trips yet</Text>
      <Text style={empty.body}>
        Complete a trip to see your safety analytics here.
      </Text>
    </View>
  );
}

// ---------- main screen ----------

export function SafetyDashboard() {
  const [family, setFamily] = useState<VehicleFamily>('4w');
  const [period, setPeriod] = useState<Period>('week');

  const { liveScore, recentTrips, status } = useSafetyStore();

  const periodTrips = useMemo(() => filterTrips(recentTrips, period), [recentTrips, period]);

  const displayScore = useMemo(() => {
    if (status === 'active' && liveScore) return liveScore.composite;
    return averageComposite(periodTrips);
  }, [status, liveScore, periodTrips]);

  const metrics = useMemo(() => metricsForFamily(family), [family]);

  const isLive = status === 'active' && liveScore !== null;

  return (
    <View style={s.root}>
      <ScrollView
        contentContainerStyle={s.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Page title */}
        <Text style={s.pageTitle}>Safety Analytics</Text>

        {/* Toggles */}
        <VehicleClassToggle family={family} onChange={setFamily} />
        <PeriodToggle period={period} onChange={setPeriod} />

        {/* Score hero */}
        <ScoreHero
          score={displayScore}
          isLive={isLive}
          tripCount={periodTrips.filter(t => t.score !== null).length}
        />

        {/* Metric breakdown */}
        <View style={s.metricsCard}>
          <Text style={s.sectionTitle}>Breakdown</Text>
          {metrics.map(m => (
            <MetricRow
              key={m.key}
              label={m.label}
              score={getMetricScore(periodTrips, m.key)}
            />
          ))}
        </View>

        {/* Recent trips */}
        <Text style={s.sectionTitle}>Recent Trips</Text>
        {periodTrips.length === 0 ? (
          <EmptyTripsPlaceholder />
        ) : (
          periodTrips.slice(0, 15).map(t => <TripCard key={t.id} trip={t} />)
        )}

        <View style={s.bottomPad} />
      </ScrollView>
    </View>
  );
}

// ---------- styles ----------

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0D0D0D',
  },
  scroll: {
    paddingHorizontal: PAD,
    paddingTop: 56,
  },
  pageTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#FFFFFF',
    marginBottom: 18,
  },
  metricsCard: {
    backgroundColor: '#111',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#888',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 12,
    marginTop: 4,
  },
  bottomPad: {
    height: 24,
  },
});

const toggle = StyleSheet.create({
  row: {
    flexDirection: 'row',
    backgroundColor: '#1A1A1A',
    borderRadius: 10,
    padding: 3,
    marginBottom: 12,
    alignSelf: 'stretch',
  },
  pill: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
  },
  pillActive: {
    backgroundColor: '#2A2A2A',
  },
  label: {
    fontSize: 13,
    fontWeight: '500',
    color: '#666',
  },
  labelActive: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
});

const hero = StyleSheet.create({
  card: {
    backgroundColor: '#111',
    borderRadius: 20,
    alignItems: 'center',
    paddingVertical: 32,
    marginBottom: 20,
  },
  liveBadge: {
    backgroundColor: '#22C55E22',
    borderColor: '#22C55E',
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 3,
    marginBottom: 20,
  },
  liveText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#22C55E',
    letterSpacing: 1.2,
  },
  ring: {
    width: RING_SIZE,
    height: RING_SIZE,
    borderRadius: RING_SIZE / 2,
    borderWidth: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scoreNum: {
    fontSize: 52,
    fontWeight: '700',
    lineHeight: 56,
  },
  scoreUnit: {
    fontSize: 13,
    color: '#555',
    marginTop: 2,
  },
  label: {
    fontSize: 17,
    fontWeight: '600',
    marginTop: 16,
  },
  sub: {
    fontSize: 13,
    color: '#555',
    marginTop: 4,
  },
});

const bar = StyleSheet.create({
  track: {
    flex: 1,
    height: 6,
    backgroundColor: '#2A2A2A',
    borderRadius: 3,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 3,
  },
});

const row = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
    borderTopWidth: 1,
    borderTopColor: '#1E1E1E',
  },
  label: {
    width: 110,
    fontSize: 13,
    color: '#CCC',
  },
  barWrap: {
    flex: 1,
    marginHorizontal: 10,
  },
  score: {
    width: 30,
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'right',
  },
});

const card = StyleSheet.create({
  container: {
    backgroundColor: '#111',
    borderRadius: 14,
    padding: 16,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  left: {
    flex: 1,
  },
  date: {
    fontSize: 13,
    color: '#CCC',
    fontWeight: '500',
    marginBottom: 4,
  },
  meta: {
    fontSize: 12,
    color: '#666',
  },
  badge: {
    width: 46,
    height: 46,
    borderRadius: 23,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 12,
  },
  badgeText: {
    fontSize: 16,
    fontWeight: '700',
  },
});

const empty = StyleSheet.create({
  box: {
    backgroundColor: '#111',
    borderRadius: 16,
    alignItems: 'center',
    paddingVertical: 40,
    paddingHorizontal: 24,
    marginBottom: 24,
  },
  icon: {
    fontSize: 40,
    marginBottom: 12,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    color: '#CCC',
    marginBottom: 6,
  },
  body: {
    fontSize: 13,
    color: '#666',
    textAlign: 'center',
    lineHeight: 20,
  },
});
