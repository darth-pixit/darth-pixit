import React, { useState } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { FirebaseAuthTypes } from '@react-native-firebase/auth';
import { useAuth } from '../auth/AuthContext';
import { PhoneScreen } from '../screens/PhoneScreen';
import { OTPScreen } from '../screens/OTPScreen';
import { ThrottleView } from '../screens/ThrottleView';

type AuthStep =
  | { step: 'phone' }
  | { step: 'otp'; confirmation: FirebaseAuthTypes.ConfirmationResult; phone: string };

export function RootNavigator() {
  const { user, initializing } = useAuth();
  const [authStep, setAuthStep] = useState<AuthStep>({ step: 'phone' });

  if (initializing) {
    return (
      <View style={styles.splash}>
        <ActivityIndicator size="large" color="#22C55E" />
      </View>
    );
  }

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

  return <ThrottleView />;
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    backgroundColor: '#0D0D0D',
    justifyContent: 'center',
    alignItems: 'center',
  },
});
