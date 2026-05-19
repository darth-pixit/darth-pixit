import React, { useState, useRef, useEffect } from 'react';
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
  NativeSyntheticEvent,
  TextInputKeyPressEventData,
} from 'react-native';
import { FirebaseAuthTypes } from '@react-native-firebase/auth';
import { useAuth } from '../auth/AuthContext';
import { authErrorToMessage } from '../auth/errors';

const CODE_LENGTH = 6;

interface Props {
  confirmation: FirebaseAuthTypes.ConfirmationResult;
  phone: string;
  onBack: () => void;
}

export function OTPScreen({ confirmation, phone, onBack }: Props) {
  const { confirmOTP, sendOTP } = useAuth();
  // Keep a mutable reference to the active confirmation so resend can replace it
  // without the component re-rendering mid-verification.
  const activeConfirmation = useRef(confirmation);
  const [digits, setDigits] = useState<string[]>(Array(CODE_LENGTH).fill(''));
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const inputRefs = useRef<Array<TextInput | null>>(Array(CODE_LENGTH).fill(null));
  // Ref guard prevents double-submission when SMS autofill populates the last
  // two boxes in the same render cycle (both see loading=false via stale state).
  const verifyInFlightRef = useRef(false);

  useEffect(() => {
    // Auto-focus first box on mount
    setTimeout(() => inputRefs.current[0]?.focus(), 100);
  }, []);

  const handleChange = (text: string, index: number) => {
    // Allow only a single digit
    const digit = text.replace(/[^0-9]/g, '').slice(-1);
    const next = [...digits];
    next[index] = digit;
    setDigits(next);

    if (digit && index < CODE_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }

    // Auto-submit when all filled
    const code = next.join('');
    if (code.length === CODE_LENGTH && next.every(Boolean)) {
      handleVerify(code);
    }
  };

  const handleKeyPress = (
    { nativeEvent: { key } }: NativeSyntheticEvent<TextInputKeyPressEventData>,
    index: number,
  ) => {
    if (key === 'Backspace') {
      if (digits[index]) {
        const next = [...digits];
        next[index] = '';
        setDigits(next);
      } else if (index > 0) {
        inputRefs.current[index - 1]?.focus();
        const next = [...digits];
        next[index - 1] = '';
        setDigits(next);
      }
    }
  };

  const handleVerify = async (code: string) => {
    if (verifyInFlightRef.current) return;
    verifyInFlightRef.current = true;
    setLoading(true);
    try {
      await confirmOTP(activeConfirmation.current, code);
      // onAuthStateChanged in AuthContext will update user → RootNavigator switches screens
    } catch (e: any) {
      Alert.alert('Invalid code', e?.message ?? 'The code you entered is incorrect. Please try again.');
      setDigits(Array(CODE_LENGTH).fill(''));
      setTimeout(() => inputRefs.current[0]?.focus(), 50);
    } finally {
      setLoading(false);
      verifyInFlightRef.current = false;
    }
  };

  const handleResend = async () => {
    setResending(true);
    try {
      const newConfirmation = await sendOTP(phone);
      activeConfirmation.current = newConfirmation;
      Alert.alert('Sent', 'A new OTP has been sent to your phone.');
      setDigits(Array(CODE_LENGTH).fill(''));
      setTimeout(() => inputRefs.current[0]?.focus(), 50);
    } catch (e: any) {
      Alert.alert('Error', authErrorToMessage(e, 'Failed to resend OTP.'));
    } finally {
      setResending(false);
    }
  };

  const filledCount = digits.filter(Boolean).length;

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
            <Text style={styles.cardTitle}>Enter code</Text>
            <Text style={styles.cardSub}>
              We sent a 6-digit code to{'\n'}
              <Text style={styles.phoneHighlight}>{phone}</Text>
            </Text>

            {/* Digit boxes */}
            <View style={styles.digitRow}>
              {digits.map((digit, i) => (
                <TextInput
                  key={i}
                  ref={(r) => { inputRefs.current[i] = r; }}
                  style={[
                    styles.digitBox,
                    digit ? styles.digitBoxFilled : null,
                    i === filledCount && !loading ? styles.digitBoxActive : null,
                  ]}
                  value={digit}
                  onChangeText={(t) => handleChange(t, i)}
                  onKeyPress={(e) => handleKeyPress(e, i)}
                  keyboardType="number-pad"
                  maxLength={1}
                  editable={!loading}
                  caretHidden
                  selectTextOnFocus
                />
              ))}
            </View>

            {loading && (
              <View style={styles.verifyingRow}>
                <ActivityIndicator color="#22C55E" size="small" />
                <Text style={styles.verifyingText}>Verifying…</Text>
              </View>
            )}

            <TouchableOpacity
              style={styles.resendBtn}
              onPress={handleResend}
              disabled={resending || loading}
            >
              <Text style={[styles.resendText, (resending || loading) && styles.resendDisabled]}>
                {resending ? 'Sending…' : 'Resend OTP'}
              </Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity style={styles.backBtn} onPress={onBack} disabled={loading}>
            <Text style={styles.backText}>← Change number</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const BOX_SIZE = 46;

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
    gap: 32,
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
    gap: 20,
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
  phoneHighlight: {
    color: '#22C55E',
    fontWeight: '600',
  },
  digitRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
  },
  digitBox: {
    flex: 1,
    height: BOX_SIZE,
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#2a2a2a',
    borderRadius: 10,
    textAlign: 'center',
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '700',
  },
  digitBoxFilled: {
    borderColor: '#22C55E',
    backgroundColor: '#0d1f15',
  },
  digitBoxActive: {
    borderColor: '#3a3a3a',
  },
  verifyingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  verifyingText: {
    color: '#555',
    fontSize: 14,
  },
  resendBtn: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  resendText: {
    color: '#22C55E',
    fontSize: 14,
    fontWeight: '600',
  },
  resendDisabled: {
    color: '#2a2a2a',
  },
  backBtn: {
    alignItems: 'center',
  },
  backText: {
    color: '#444',
    fontSize: 14,
  },
});
