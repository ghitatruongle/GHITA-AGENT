// Wi-Fi & Bluetooth pairing with desktop via IP/Cloud Discovery

import React, { useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  StatusBar,
  Keyboard,
  TouchableWithoutFeedback,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';
import { FontSize, Spacing, Radius } from '../theme/styles';
import { ConnectionStatus } from '../components/ConnectionStatus';
import { socketService } from '../services/socketService';
import {
  CLOUD_DISCOVERY_API_KEY,
  CLOUD_DISCOVERY_API_URL,
  ENABLE_CLOUD_DISCOVERY,
} from '../config';
import { getDeviceId } from '../services/storageService';
import type { BluetoothDevice } from '../services/bluetoothService';
import { bluetoothService } from '../services/bluetoothService';
import type { PairingScreenProps } from '../navigation/types';
import { useTranslation } from '../i18n/context';

import {
  WifiPairingTab,
  BluetoothPairingTab,
  usePairingSocket,
} from './pairing';

export function PairingScreen({ navigation }: PairingScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = React.useMemo(() => createStyles(colors), [colors]);
  const { t } = useTranslation();

  const [activeTab, setActiveTab] = useState<'wifi' | 'bluetooth'>('wifi');
  const [pairingCode, setPairingCode] = useState('');

  const {
    connectionState,
    serverAddress,
    setServerAddress,
    errorMessage,
    isConnecting,
    handleWifiConnect,
    clearError,
    setConnectionError,
  } = usePairingSocket(navigation);

  // Bluetooth connection logic (shares socket service with Wi-Fi)
  const btCheckIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const btTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleConnectBtDevice = useCallback(
    async (device: BluetoothDevice) => {
      clearError();
      if (btCheckIntervalRef.current) clearInterval(btCheckIntervalRef.current);
      if (btTimeoutRef.current) clearTimeout(btTimeoutRef.current);

      try {
        let resolvedAddress: string | null = null;
        let remotePairingCode: string | null = null;

        // Try RFCOMM for real Bluetooth devices
        if (bluetoothService.isModuleAvailable && !device.address.startsWith('VIRTUAL-')) {
          resolvedAddress = await bluetoothService.connectToDevice(device);
        }

        // Resolve via Cloud Discovery
        if (!resolvedAddress) {
          if (!ENABLE_CLOUD_DISCOVERY) throw new Error(t('pairing.pairErrCloudDisabled'));
          const cleanName = device.name
            .replace(/\s*\(.*?\)/g, '')
            .trim()
            .toUpperCase()
            .replace(/[^A-Z0-9-]/g, '');
          if (!cleanName) throw new Error(t('pairing.pairErrInvalidName'));
          if (!CLOUD_DISCOVERY_API_KEY) throw new Error(t('pairing.pairErrApiKeyMissing'));

          const res = await fetch(`${CLOUD_DISCOVERY_API_URL}/${CLOUD_DISCOVERY_API_KEY}/${cleanName}`);
          const dataText = await res.text();
          const cleanedData = dataText.replace(/^"|"$/g, '').trim();
          if (!cleanedData) throw new Error(t('pairing.pairErrNoIpCloud', { name: cleanName }));

          const parts = cleanedData.split('_');
          if (parts.length < 2) throw new Error(t('pairing.pairErrCloudPcFail'));
          const port = parts[parts.length - 1] ?? '';
          const rawIps = parts.slice(0, parts.length - 1);
          const addressesToTry = rawIps
            .map((ip) => ip.replace(/-/g, '.'))
            .filter((ip) => ip !== '127.0.0.1' && ip !== 'localhost' && ip !== '::1')
            .map((ip) => `http://${ip}:${port}`);

          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 4000);
          const pingPromises = addressesToTry.map(async (url) => {
            try {
              const r = await fetch(`${url}/health`, { signal: controller.signal });
              if (r.status === 200) {
                const d = await r.json();
                if (d.status === 'ok') return { url, pairingCode: d.pairingCode };
              }
            } catch {
              // ignore
            }
            throw new Error('Failed');
          });

          const successObj = await new Promise<{ url: string; pairingCode: string }>(
            (resolve, reject) => {
              let rejected = 0;
              pingPromises.forEach((p) => {
                p.then(resolve).catch(() => {
                  rejected++;
                  if (rejected === pingPromises.length) reject(new Error('All pings failed'));
                });
              });
            },
          );
          clearTimeout(timeoutId);
          resolvedAddress = successObj.url;
          remotePairingCode = successObj.pairingCode;
        }

        if (!resolvedAddress) throw new Error(t('pairing.pairErrNoIp'));
        if (!remotePairingCode) {
          try {
            const r = await fetch(`${resolvedAddress}/health`);
            const d = await r.json();
            remotePairingCode = d.pairingCode;
          } catch {
            // ignore
          }
        }
        if (!remotePairingCode) throw new Error(t('pairing.noCodeFromServer'));

        const savedAddr = resolvedAddress.replace('http://', '');
        setServerAddress(savedAddr);
        socketService.connect(resolvedAddress);

        btCheckIntervalRef.current = setInterval(() => {
          if (socketService.isSocketConnected) {
            if (btCheckIntervalRef.current) clearInterval(btCheckIntervalRef.current);
            void getDeviceId().then((dId) => {
              const code = remotePairingCode;
              if (code) {
                socketService.sendPairingCode(code, dId || undefined);
              }
            });
          }
        }, 200);

        btTimeoutRef.current = setTimeout(() => {
          if (btCheckIntervalRef.current) clearInterval(btCheckIntervalRef.current);
          socketService.disconnect();
        }, 10000);
      } catch (err: unknown) {
        if (btCheckIntervalRef.current) clearInterval(btCheckIntervalRef.current);
        if (btTimeoutRef.current) clearTimeout(btTimeoutRef.current);
        setConnectionError(err instanceof Error ? err.message : t('pairing.pairErrBtFindFail'));
      }
    },
    [clearError, setServerAddress, setConnectionError, t],
  );

  return (
    <SafeAreaView style={styles.container}>
      {/* RN 0.87: StatusBar.backgroundColor đã bị bỏ khỏi types — màu nền
          nằm ở SafeAreaView (styles.container) nên visual giữ nguyên. */}
      <StatusBar barStyle="light-content" />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}
      >
        <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
          <View style={styles.content}>
            {/* Header */}
            <View style={styles.header}>
              <Text style={styles.logoText}>{t('pairing.title')}</Text>
              <Text style={styles.subtitle}>{t('pairing.subtitle')}</Text>
            </View>

            <ConnectionStatus state={connectionState} />

            {/* Tab Selector */}
            <View style={styles.tabsContainer}>
              <TouchableOpacity
                style={[styles.tabButton, activeTab === 'wifi' && styles.tabButtonActive]}
                onPress={() => setActiveTab('wifi')}
                accessibilityLabel={t('pairing.wifiTab')}
              >
                <Text
                  style={[styles.tabButtonText, activeTab === 'wifi' && styles.tabButtonTextActive]}
                >
                  {t('pairing.wifiTab')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.tabButton, activeTab === 'bluetooth' && styles.tabButtonActive]}
                onPress={() => setActiveTab('bluetooth')}
                accessibilityLabel={t('pairing.bluetoothTab')}
              >
                <Text
                  style={[
                    styles.tabButtonText,
                    activeTab === 'bluetooth' && styles.tabButtonTextActive,
                  ]}
                >
                  {t('pairing.bluetoothTab')}
                </Text>
              </TouchableOpacity>
            </View>

            <ScrollView style={styles.formContainer} keyboardShouldPersistTaps="handled">
              {activeTab === 'wifi' ? (
                <WifiPairingTab
                  serverAddress={serverAddress}
                  setServerAddress={setServerAddress}
                  pairingCode={pairingCode}
                  setPairingCode={setPairingCode}
                  onConnect={() => handleWifiConnect(pairingCode)}
                  isConnecting={isConnecting}
                  errorMessage={errorMessage}
                />
              ) : (
                <BluetoothPairingTab
                  isConnecting={isConnecting}
                  errorMessage={errorMessage}
                  onClearError={clearError}
                  onConnectDevice={handleConnectBtDevice}
                />
              )}
            </ScrollView>
          </View>
        </TouchableWithoutFeedback>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    content: { flex: 1, paddingHorizontal: Spacing.lg, paddingTop: Spacing.xl },
    header: { alignItems: 'center', marginBottom: Spacing.xl },
    logoText: {
      fontSize: FontSize.title,
      fontWeight: '800',
      color: colors.textPrimary,
      letterSpacing: 4,
    },
    subtitle: { fontSize: FontSize.md, color: colors.textMuted, marginTop: Spacing.sm },
    tabsContainer: {
      flexDirection: 'row',
      marginBottom: Spacing.lg,
      backgroundColor: colors.backgroundSecondary,
      borderRadius: Radius.md,
      padding: 4,
    },
    tabButton: {
      flex: 1,
      paddingVertical: 10,
      alignItems: 'center',
      borderRadius: Radius.sm,
    },
    tabButtonActive: {
      backgroundColor: colors.backgroundTertiary,
      borderWidth: 1,
      borderColor: colors.border,
    },
    tabButtonText: { fontSize: FontSize.sm, color: colors.textMuted, fontWeight: '600' },
    tabButtonTextActive: { color: colors.accent, fontWeight: '700' },
    formContainer: { flex: 1 },
  });
