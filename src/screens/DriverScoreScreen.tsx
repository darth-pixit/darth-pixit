import React, { useMemo } from 'react';
import {
  View,
  Text,
  Modal,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  SafeAreaView,
} from 'react-native';
import { useSafetyStore } from '../safety/SafetyStore';
import { Alert, ALERT_COLORS, alertFromEvent, alertFromWear, worstLevel } from '../safety/alerts';
import { selfDemoDriver } from '../safety/demoFixture';
import { SafetyScore, TripRecord } from '../safety/types';

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function DriverScoreScreen({ visible, onClose }: Props) {
  const live = useSafetyStore();
  const view = useMemo(() => buildView(live), [
    live.liveScore,
    live.lifetimeScore,
    live.events,
    live.recentTrips,
    live.wearSignals,
    live.status,
  ]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="fullScreen">
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="light-content" backgroundColor="#0D0D0D" />
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.title}>My Driving</Text>
            <Text style={styles.subtitle}>
              {view.isLive ? 'Live trip — updating in real time' : view.isDemoFallback
                ? 'No trip data yet — showing sample driver to demo the view'
                : 'Most recent trip + lifetime score'}
            </Text>
          </View>
          <TouchableOpacity onPress={onClose} hitSlop={10} style={styles.closeBtn}>
            <Text style={styles.closeText}>Close</Text>
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          <ScoreCard composite={view.composite} lifetime={view.lifetime} />

          <Section title="Live alerts" subtitle={`Worst right now: ${view.worst.toUpperCase()}`}>
            {view.alerts.length === 0 ? (
              <Text style={styles.emptyText}>No alerts. Drive on.</Text>
            ) : (
              view.alerts.slice(0, 8).map((a) => <AlertRow key={a.id} alert={a} />)
            )}
          </Section>

          <Section title="Driving categories" subtitle="0–100 per category, last trip">
            {view.categories.map((c) => (
              <CategoryBar key={c.label} label={c.label} value={c.score} />
            ))}
          </Section>

          <Section title="Recent trips" subtitle="Newest first">
            {view.trips.length === 0 ? (
              <Text style={styles.emptyText}>No trips logged yet.</Text>
            ) : (
              view.trips.slice(0, 5).map((t) => <TripRow key={t.id} trip={t} />)
            )}
          </Section>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

interface ScreenView {
  isLive: boolean;
  isDemoFallback: boolean;
  composite: number;
  lifetime: number | null;
  alerts: Alert[];
  worst: 'green' | 'yellow' | 'red';
  categories: Array<{ label: string; score: number }>;
  trips: TripRecord[];
}

function buildView(live: ReturnType<typeof useSafetyStore.getState>): ScreenView {
  const hasReal =
    live.liveScore != null ||
    live.events.length > 0 ||
    live.recentTrips.length > 0 ||
    live.wearSignals.length > 0;

  if (hasReal) {
    const eventAlerts = live.events.map(alertFromEvent);
    const wearAlerts = live.wearSignals.map(alertFromWear);
    const alerts = [...eventAlerts, ...wearAlerts].sort((a, b) => b.at - a.at);
    const score = live.liveScore ?? live.recentTrips[0]?.score;
    return {
      isLive: live.status === 'active',
      isDemoFallback: false,
      composite: score?.composite ?? 0,
      lifetime: live.lifetimeScore,
      alerts,
      worst: worstLevel(alerts),
      categories: scoreToCategories(score),
      trips: live.recentTrips,
    };
  }

  // Demo fallback — gives the screen something to show before any real trip.
  const demo = selfDemoDriver();
  const trip = demo.trips[0];
  const alerts = [
    ...trip.events.map(alertFromEvent),
    ...demo.wearSignals.map(alertFromWear),
  ].sort((a, b) => b.at - a.at);
  return {
    isLive: false,
    isDemoFallback: true,
    composite: trip.score?.composite ?? demo.lifetimeScore,
    lifetime: demo.lifetimeScore,
    alerts,
    worst: worstLevel(alerts),
    categories: scoreToCategories(trip.score),
    trips: demo.trips,
  };
}

function scoreToCategories(s: SafetyScore | null | undefined): Array<{ label: string; score: number }> {
  if (!s) {
    return [
      { label: 'Acceleration', score: 0 },
      { label: 'Braking', score: 0 },
      { label: 'Cornering', score: 0 },
      { label: 'Speeding', score: 0 },
      { label: 'Focus', score: 0 },
    ];
  }
  return [
    { label: 'Acceleration', score: s.acceleration.score },
    { label: 'Braking', score: s.braking.score },
    { label: 'Cornering', score: s.cornering.score },
    { label: 'Speeding', score: s.speeding.score },
    { label: 'Focus', score: s.distracted.score },
  ];
}

function ScoreCard({ composite, lifetime }: { composite: number; lifetime: number | null }) {
  const color = scoreColor(composite);
  return (
    <View style={[styles.scoreCard, { borderColor: color }]}>
      <Text style={styles.scoreLabel}>CURRENT TRIP</Text>
      <Text style={[styles.scoreValue, { color }]}>{Math.round(composite)}</Text>
      <Text style={styles.scoreSub}>
        Lifetime score: {lifetime == null ? '—' : Math.round(lifetime)}
      </Text>
    </View>
  );
}

function AlertRow({ alert }: { alert: Alert }) {
  return (
    <View style={styles.alertRow}>
      <View style={[styles.alertDot, { backgroundColor: ALERT_COLORS[alert.level] }]} />
      <View style={styles.alertText}>
        <Text style={styles.alertTitle}>{alert.title}</Text>
        <Text style={styles.alertDetail}>{alert.detail}</Text>
      </View>
      <Text style={[styles.alertLevel, { color: ALERT_COLORS[alert.level] }]}>
        {alert.level.toUpperCase()}
      </Text>
    </View>
  );
}

function CategoryBar({ label, value }: { label: string; value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  const color = scoreColor(pct);
  return (
    <View style={styles.catRow}>
      <Text style={styles.catLabel}>{label}</Text>
      <View style={styles.catTrack}>
        <View style={[styles.catFill, { width: `${pct}%`, backgroundColor: color }]} />
      </View>
      <Text style={[styles.catValue, { color }]}>{Math.round(pct)}</Text>
    </View>
  );
}

function TripRow({ trip }: { trip: TripRecord }) {
  const km = (trip.distanceM / 1000).toFixed(1);
  const min = Math.round(trip.activeDurationMs / 60_000);
  const composite = trip.score?.composite ?? 0;
  const color = scoreColor(composite);
  const eventCount = trip.events.length;
  return (
    <View style={styles.tripRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.tripWhen}>{new Date(trip.startedAt).toLocaleString()}</Text>
        <Text style={styles.tripStats}>
          {km} km · {min} min · {eventCount} event{eventCount === 1 ? '' : 's'}
        </Text>
      </View>
      <Text style={[styles.tripScore, { color }]}>{Math.round(composite)}</Text>
    </View>
  );
}

function scoreColor(s: number): string {
  if (s >= 80) return '#22C55E';
  if (s >= 60) return '#F59E0B';
  return '#EF4444';
}

function Section({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <Text style={styles.sectionSubtitle}>{subtitle}</Text>
      </View>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0D0D0D' },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
  },
  headerLeft: { flex: 1, paddingRight: 12 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700' },
  subtitle: { color: '#777', fontSize: 12, marginTop: 4 },
  closeBtn: { paddingVertical: 6, paddingHorizontal: 12 },
  closeText: { color: '#3B82F6', fontSize: 15, fontWeight: '600' },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 20, paddingVertical: 18, paddingBottom: 60 },

  scoreCard: {
    backgroundColor: '#111',
    borderRadius: 16,
    borderWidth: 2,
    paddingVertical: 22,
    paddingHorizontal: 20,
    alignItems: 'center',
    marginBottom: 24,
  },
  scoreLabel: { color: '#777', fontSize: 11, fontWeight: '600', letterSpacing: 1.2 },
  scoreValue: { fontSize: 64, fontWeight: '800', marginTop: 6, marginBottom: 4 },
  scoreSub: { color: '#999', fontSize: 13 },

  section: { marginBottom: 22 },
  sectionHeader: { marginBottom: 10 },
  sectionTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  sectionSubtitle: { color: '#666', fontSize: 12, marginTop: 2 },
  card: { backgroundColor: '#111', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 6 },
  emptyText: { color: '#666', fontSize: 13, paddingVertical: 14, textAlign: 'center' },

  alertRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
  },
  alertDot: { width: 10, height: 10, borderRadius: 5, marginRight: 12 },
  alertText: { flex: 1 },
  alertTitle: { color: '#fff', fontSize: 14, fontWeight: '600' },
  alertDetail: { color: '#888', fontSize: 12, marginTop: 2 },
  alertLevel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6, marginLeft: 8 },

  catRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  catLabel: { color: '#bbb', fontSize: 13, width: 102 },
  catTrack: { flex: 1, height: 8, backgroundColor: '#222', borderRadius: 4, overflow: 'hidden' },
  catFill: { height: 8, borderRadius: 4 },
  catValue: { fontSize: 13, fontWeight: '600', width: 34, textAlign: 'right', marginLeft: 10 },

  tripRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
  },
  tripWhen: { color: '#fff', fontSize: 13, fontWeight: '600' },
  tripStats: { color: '#888', fontSize: 12, marginTop: 2 },
  tripScore: { fontSize: 22, fontWeight: '700', marginLeft: 12 },
});
