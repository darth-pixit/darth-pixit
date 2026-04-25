import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { FirebaseAuthTypes } from '@react-native-firebase/auth';
import { useAuth } from '../auth/AuthContext';
import { PhoneScreen } from '../screens/PhoneScreen';
import { OTPScreen } from '../screens/OTPScreen';
import { ThrottleView } from '../screens/ThrottleView';
import { SafetyDashboard } from '../screens/SafetyDashboard';

type AuthStep =
  | { step: 'phone' }
  | { step: 'otp'; confirmation: FirebaseAuthTypes.ConfirmationResult; phone: string };

type Tab = 'mileage' | 'safety';

function BottomTabBar({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  return (
    <View style={tabBar.container}>
      <TouchableOpacity
        style={tabBar.tab}
        onPress={() => onChange('mileage')}
        activeOpacity={0.7}
      >
        <Text style={[tabBar.icon, active === 'mileage' && tabBar.iconActive]}>⛽</Text>
        <Text style={[tabBar.label, active === 'mileage' && tabBar.labelActive]}>Mileage</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={tabBar.tab}
        onPress={() => onChange('safety')}
        activeOpacity={0.7}
      >
        <Text style={[tabBar.icon, active === 'safety' && tabBar.iconActive]}>🛡</Text>
        <Text style={[tabBar.label, active === 'safety' && tabBar.labelActive]}>Safety</Text>
      </TouchableOpacity>
    </View>
  );
}

export function RootNavigator() {
  const { user, initializing } = useAuth();
  const [authStep, setAuthStep] = useState<AuthStep>({ step: 'phone' });
  const [activeTab, setActiveTab] = useState<Tab>('mileage');

  // After sign-out, user becomes null but authStep may still be 'otp' with an
  // expired confirmation. Reset to phone so the user starts fresh.
  useEffect(() => {
    if (!user) setAuthStep({ step: 'phone' });
  }, [user]);

  // Render auth screens immediately when there's no confirmed user — no reason
  // to block behind a Firebase spinner for a user who needs to log in anyway.
  if (!user) {
    if (authStep.step === 'otp') {
      return (
        <OTPScreen
          confirmation={authStep.confirmation}
          phone={authStep.phone}
          onBack={() => setAuthStep({ step: 'phone' })}
        />
      );
    }
    return (
      <PhoneScreen
        onConfirmation={(confirmation, phone) =>
          setAuthStep({ step: 'otp', confirmation, phone })
        }
      />
    );
  }

  // User exists but Firebase hasn't finished initialising — hold here to avoid
  // rendering ThrottleView against a partially-resolved session.
  if (initializing) {
    return (
      <View style={styles.splash}>
        <ActivityIndicator size="large" color="#22C55E" />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {/*
       * Both screens are always mounted. display:'none' hides the inactive tab
       * without unmounting it — this keeps ThrottleView's BLE connections and
       * trip accumulation refs alive while the user browses Safety.
       */}
      <View style={[styles.screen, activeTab !== 'mileage' && styles.hidden]}>
        <ThrottleView />
      </View>
      <View style={[styles.screen, activeTab !== 'safety' && styles.hidden]}>
        <SafetyDashboard />
      </View>

      <BottomTabBar active={activeTab} onChange={setActiveTab} />
    </View>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    backgroundColor: '#0D0D0D',
    justifyContent: 'center',
    alignItems: 'center',
  },
  root: {
    flex: 1,
    backgroundColor: '#0D0D0D',
  },
  screen: {
    flex: 1,
  },
  hidden: {
    display: 'none',
  },
});

const tabBar = StyleSheet.create({
  container: {
    flexDirection: 'row',
    backgroundColor: '#111',
    borderTopWidth: 1,
    borderTopColor: '#1E1E1E',
    paddingBottom: 20,
    paddingTop: 10,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    gap: 3,
  },
  icon: {
    fontSize: 22,
    opacity: 0.4,
  },
  iconActive: {
    opacity: 1,
  },
  label: {
    fontSize: 11,
    color: '#555',
    fontWeight: '500',
  },
  labelActive: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
});
