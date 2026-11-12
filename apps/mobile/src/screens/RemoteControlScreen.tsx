// Main screen after pairing: screen preview, chat, quick actions

import React from 'react';
import {
  View,
  Text,
  ScrollView,
  StatusBar,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';
import { FontSize, Spacing, Radius } from '../theme/styles';
import { ConnectionStatus } from '../components/ConnectionStatus';
import { socketService } from '../services/socketService';
import type { RemoteControlScreenProps } from '../navigation/types';
import { useTranslation } from '../i18n/context';

import { ScreenPreviewPanel, RemoteChatPanel, RemoteActionBar, useRemoteControl } from './remote';

export function RemoteControlScreen({
  route,
  navigation,
}: RemoteControlScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = React.useMemo(() => createStyles(colors), [colors]);
  const { t } = useTranslation();
  const { deviceName } = route.params;

  const {
    connectionState,
    isConnected,
    screenshotBase64,
    screenshotLoading,
    chatMessages,
    activeApproval,
    costTelemetry,
    showSkills,
    setShowSkills,
    skillsList,
    skillsLoading,
    skillRunning,
    handleQuickAction,
    handleChatSend,
    handleScreenTouch,
    handleDisconnect,
    handleApproveCommand,
    handleRejectCommand,
    runSkill,
  } = useRemoteControl(route, navigation);

  return (
    <SafeAreaView style={styles.container}>
      {/* RN 0.87: StatusBar.backgroundColor đã bị bỏ khỏi types — màu nền
          nằm ở SafeAreaView (styles.container) nên visual giữ nguyên. */}
      <StatusBar barStyle="light-content" />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.deviceIcon}>🖥️</Text>
            <View>
              <Text style={styles.deviceName}>{deviceName}</Text>
              <View style={styles.connectionRow}>
                <ConnectionStatus state={connectionState} compact />
                {connectionState === 'connected' && (
                  <Text style={styles.connectionTypeText}>
                    {socketService.connectionType === 'local'
                      ? t('status.lanConnection')
                      : t('status.cloudConnection')}
                  </Text>
                )}
              </View>
            </View>
          </View>
          <View style={styles.headerRight}>
            <TouchableOpacity
              onPress={() => navigation.navigate('Dashboard')}
              style={styles.btnTouchable}
              accessibilityLabel="Dashboard"
              accessibilityRole="button"
            >
              <Text style={styles.btnText}>📊</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => navigation.navigate('Settings')}
              style={styles.btnTouchable}
              accessibilityLabel="Settings"
              accessibilityRole="button"
            >
              <Text style={styles.btnText}>&#9881;</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleDisconnect}
              style={styles.disconnectTouchable}
              accessibilityLabel="Disconnect"
              accessibilityRole="button"
            >
              <Text style={styles.disconnectText}>&#10005;</Text>
            </TouchableOpacity>
          </View>
        </View>

        <ScrollView
          style={styles.content}
          contentContainerStyle={styles.contentInner}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <ScreenPreviewPanel
            screenshotBase64={screenshotBase64}
            screenshotLoading={screenshotLoading}
            isConnected={isConnected}
            onScreenTouch={handleScreenTouch}
            costTelemetry={costTelemetry}
          />

          <RemoteChatPanel
            messages={chatMessages}
            isConnected={isConnected}
            onSend={handleChatSend}
          />

          <RemoteActionBar
            isConnected={isConnected}
            activeApproval={activeApproval}
            onQuickAction={handleQuickAction}
            onApprove={handleApproveCommand}
            onReject={handleRejectCommand}
            showSkills={showSkills}
            setShowSkills={setShowSkills}
            skillsList={skillsList}
            skillsLoading={skillsLoading}
            skillRunning={skillRunning}
            onRunSkill={runSkill}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: Spacing.xl,
      paddingVertical: Spacing.lg,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    headerLeft: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
    deviceIcon: { fontSize: 28 },
    deviceName: { color: colors.primaryLight, fontSize: FontSize.lg, fontWeight: '700' },
    headerRight: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
    btnTouchable: {
      minWidth: 44,
      minHeight: 44,
      justifyContent: 'center',
      alignItems: 'center',
      borderRadius: Radius.md,
    },
    btnText: { color: colors.textSecondary, fontSize: FontSize.xxl },
    disconnectTouchable: {
      minWidth: 44,
      minHeight: 44,
      justifyContent: 'center',
      alignItems: 'center',
      borderRadius: Radius.md,
    },
    disconnectText: { color: colors.textDark, fontSize: FontSize.xxl },
    connectionRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    connectionTypeText: { fontSize: 10, color: colors.textMuted },
    content: { flex: 1 },
    contentInner: { padding: Spacing.xl, gap: Spacing.lg, paddingBottom: Spacing.huge },
  });
