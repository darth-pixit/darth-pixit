import React, { createContext, useContext, useState, useEffect } from 'react';
import auth, { FirebaseAuthTypes } from '@react-native-firebase/auth';

// iOS debug builds have no push notification entitlements, so Firebase phone
// auth hangs waiting for APNs registration that never completes. Disable app
// verification at module load time — well before any signInWithPhoneNumber call.
if (__DEV__) {
  auth().settings.appVerificationDisabledForTesting = true;
}

interface AuthContextValue {
  user: FirebaseAuthTypes.User | null;
  initializing: boolean;
  sendOTP: (phone: string) => Promise<FirebaseAuthTypes.ConfirmationResult>;
  confirmOTP: (confirmation: FirebaseAuthTypes.ConfirmationResult, code: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<FirebaseAuthTypes.User | null>(null);
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    const unsubscribe = auth().onAuthStateChanged(
      (u) => {
        setUser(u);
        setInitializing(false);
      },
      () => {
        setInitializing(false);
      },
    );
    return unsubscribe;
  }, []);

  const sendOTP = (phone: string) => auth().signInWithPhoneNumber(phone);

  const confirmOTP = async (
    confirmation: FirebaseAuthTypes.ConfirmationResult,
    code: string,
  ) => {
    await confirmation.confirm(code);
  };

  const signOut = () => auth().signOut();

  return (
    <AuthContext.Provider value={{ user, initializing, sendOTP, confirmOTP, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
