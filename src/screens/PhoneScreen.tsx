import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  StatusBar,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { FirebaseAuthTypes } from '@react-native-firebase/auth';
import { useAuth } from '../auth/AuthContext';
import { authErrorToMessage } from '../auth/errors';

interface Props {
  onConfirmation: (c: FirebaseAuthTypes.ConfirmationResult, phone: string) => void;
}

export function PhoneScreen({ onConfirmation }: Props) {
  const { sendOTP } = useAuth();
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSend = async () => {
    const trimmed = phone.trim();
    const formatted = trimmed.startsWith('+') ? trimmed : `+${trimmed}`;
    if (formatted.length < 8) {
      Alert.alert('Invalid number', 'Please enter a valid phone number with country code (e.g. +91 9876543210).');
      return;
    }
    setLoading(true);
    try {
      const confirmation = await sendOTP(formatted);
      onConfirmation(confirmation, formatted);
    } catch (e: any) {
      Alert.alert('Error', authErrorToMessage(e, 'Failed to send OTP. Check the number and try again.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor="#0D0D0D" />
      <KeyboardAvoidingView
        style={styles.kav}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.body}>
          <View style={styles.header}>
            <Text style={styles.appName}>DarthPixit</Text>
            <Text style={styles.tagline}>OBD · Fuel · Performance</Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Sign in</Text>
            <Text style={styles.cardSub}>
              Enter your phone number.{'\n'}We'll send a one-time code via SMS.
            </Text>

            <TextInput
              style={styles.input}
              value={phone}
              onChangeText={setPhone}
              placeholder="+91 98765 43210"
              placeholderTextColor="#3a3a3a"
              keyboardType="phone-pad"
              autoFocus
              returnKeyType="done"
              onSubmitEditing={handleSend}
              editable={!loading}
            />
            <Text style={styles.hint}>Include country code · e.g. +1 for US, +91 for India</Text>

            <TouchableOpacity
              style={[styles.btn, loading && styles.btnDisabled]}
              onPress={handleSend}
              disabled={loading}
              activeOpacity={0.8}
            >
              {loading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.btnText}>Send OTP</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#0D0D0D',
  },
  kav: {
    flex: 1,
  },
  body: {
    flex: 1,
    paddingHorizontal: 24,
    justifyContent: 'center',
    gap: 40,
  },
  header: {
    alignItems: 'center',
  },
  appName: {
    color: '#FFFFFF',
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: -1,
  },
  tagline: {
    color: '#444',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 2,
    marginTop: 4,
  },
  card: {
    backgroundColor: '#111',
    borderRadius: 20,
    padding: 24,
    borderWidth: 1,
    borderColor: '#1e1e1e',
    gap: 16,
  },
  cardTitle: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '700',
  },
  cardSub: {
    color: '#555',
    fontSize: 14,
    lineHeight: 22,
  },
  input: {
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#2a2a2a',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    color: '#FFFFFF',
    fontSize: 18,
    letterSpacing: 0.5,
  },
  hint: {
    color: '#333',
    fontSize: 11,
    marginTop: -8,
  },
  btn: {
    backgroundColor: '#22C55E',
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: 4,
  },
  btnDisabled: {
    opacity: 0.5,
  },
  btnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
});
