import { Platform } from 'react-native';
import {
  CarPlay,
  InformationTemplate,
  InformationItem,
  ListTemplate,
  ListSection,
} from '@g4rb4g3/react-native-carplay';
import { useOBDStore } from '../obd/OBDStore';

const ECO_LIMIT = 0.40;
const MOD_LIMIT = 0.70;
const UPDATE_INTERVAL_MS = 1000;

function throttleFraction(engineLoadPct: number | null, rpm: number | null): number {
  if (engineLoadPct != null) return Math.max(0, Math.min(1, engineLoadPct / 100));
  if (rpm != null) return Math.max(0, Math.min(1, rpm / 6000));
  return 0;
}

function zoneLabel(t: number): string {
  if (t <= ECO_LIMIT) return 'ECO';
  if (t <= MOD_LIMIT) return 'MODERATE';
  return 'PUSH';
}

function coachingLine(t: number): string {
  if (t <= ECO_LIMIT) return 'Perfect — keep this pace.';
  if (t <= MOD_LIMIT) return 'Ease off a little to save fuel.';
  return "Back off — you're burning extra fuel.";
}

function fmtNum(n: number | null, decimals: number, unit: string): string {
  return n != null ? `${n.toFixed(decimals)} ${unit}` : '—';
}

function adapterLine(state: string, method: string): string {
  switch (state) {
    case 'ready':        return `Connected (${method})`;
    case 'scanning':     return 'Scanning…';
    case 'connecting':   return 'Connecting…';
    case 'reconnecting': return 'Reconnecting…';
    case 'error':        return 'Error';
    default:             return 'Demo / Idle';
  }
}

function buildInfoItems(): InformationItem[] {
  const s = useOBDStore.getState();
  const t = throttleFraction(s.engineLoadPct, s.rpm);
  return [
    { title: 'Zone',      detail: zoneLabel(t) },
    { title: 'Coaching',  detail: coachingLine(t) },
    { title: 'Fuel Rate', detail: fmtNum(s.fuelRateLPerH, 1, 'L/h') },
    { title: 'Speed',     detail: fmtNum(s.speedKmH, 0, 'km/h') },
    { title: 'RPM',       detail: s.rpm != null ? Math.round(s.rpm).toLocaleString() : '—' },
    { title: 'Adapter',   detail: adapterLine(s.state, s.fuelCalcMethod) },
  ];
}

// Android Auto uses a single section without a header so the Car App Library
// renders it as a flat list — mirrors the iOS InformationTemplate layout.
function buildListSections(): ListSection[] {
  const s = useOBDStore.getState();
  const t = throttleFraction(s.engineLoadPct, s.rpm);
  return [{
    items: [
      { id: 'zone',    text: 'Zone',      detailText: zoneLabel(t) },
      { id: 'coach',   text: 'Coaching',  detailText: coachingLine(t) },
      { id: 'fuel',    text: 'Fuel Rate', detailText: fmtNum(s.fuelRateLPerH, 1, 'L/h') },
      { id: 'speed',   text: 'Speed',     detailText: fmtNum(s.speedKmH, 0, 'km/h') },
      { id: 'rpm',     text: 'RPM',       detailText: s.rpm != null ? Math.round(s.rpm).toLocaleString() : '—' },
      { id: 'adapter', text: 'Adapter',   detailText: adapterLine(s.state, s.fuelCalcMethod) },
    ],
  }];
}

let iosTemplate: InformationTemplate | null = null;
let androidTemplate: ListTemplate | null = null;
let intervalId: ReturnType<typeof setInterval> | null = null;

function createAndShowTemplate(): void {
  if (Platform.OS === 'ios') {
    iosTemplate = new InformationTemplate({
      title: 'DarthPixit',
      leading: true,
      items: buildInfoItems(),
      actions: [],
      onActionButtonPressed: () => {},
    });
    CarPlay.setRootTemplate(iosTemplate, false);
  } else {
    androidTemplate = new ListTemplate({
      title: 'DarthPixit — Mileage',
      sections: buildListSections(),
    });
    CarPlay.setRootTemplate(androidTemplate, false);
  }
}

function pushUpdate(): void {
  if (Platform.OS === 'ios' && iosTemplate) {
    iosTemplate.updateInformationTemplateItems(buildInfoItems());
  } else if (Platform.OS === 'android' && androidTemplate) {
    androidTemplate.updateSections(buildListSections());
  }
}

function startUpdating(): void {
  if (intervalId != null) return;
  createAndShowTemplate();
  intervalId = setInterval(pushUpdate, UPDATE_INTERVAL_MS);
}

function stopUpdating(): void {
  if (intervalId != null) {
    clearInterval(intervalId);
    intervalId = null;
  }
  iosTemplate = null;
  androidTemplate = null;
}

// Stable callback references so unregister can remove the same function identity.
const onConnect = () => startUpdating();
const onDisconnect = () => stopUpdating();

export function initCarPlay(): void {
  CarPlay.registerOnConnect(onConnect);
  CarPlay.registerOnDisconnect(onDisconnect);
  // Fire immediately if already connected (e.g. after a JS hot reload)
  if (CarPlay.connected) startUpdating();
}

export function shutdownCarPlay(): void {
  CarPlay.unregisterOnConnect(onConnect);
  CarPlay.unregisterOnDisconnect(onDisconnect);
  stopUpdating();
}
