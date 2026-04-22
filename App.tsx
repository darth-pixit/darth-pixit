import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { AuthProvider } from './src/auth/AuthContext';
import { RootNavigator } from './src/navigation/RootNavigator';
import { alert } from './src/monitoring/AlertingService';
import { SCENARIO_APP_CRASH } from './src/monitoring/AlertSeverity';

interface State { error: Error | null }
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) {
    alert(SCENARIO_APP_CRASH, error, { message: error.message });
  }
  render() {
    if (this.state.error) {
      return (
        <View style={styles.err}>
          <Text style={styles.errText}>Startup error:{'\n'}{this.state.error.message}</Text>
        </View>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <RootNavigator />
      </AuthProvider>
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  err: { flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center', padding: 24 },
  errText: { color: '#f55', fontSize: 14, textAlign: 'center' },
});
