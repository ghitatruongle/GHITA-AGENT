import notifee, { AndroidImportance, EventType } from '@notifee/react-native';

class NotificationService {
  private channelId: string | null = null;

  async initialize() {
    // Request permissions (required for iOS)
    await notifee.requestPermission();

    // Create a channel (required for Android)
    this.channelId = await notifee.createChannel({
      id: 'ghita-agent-default',
      name: 'Ghita Agent Notifications',
      importance: AndroidImportance.HIGH,
    });

    // Handle background events
    notifee.onBackgroundEvent(async ({ type, detail }) => {
      const { notification } = detail;
      if (type === EventType.PRESS) {
        console.info('User pressed notification in background', notification);
      }
    });
  }

  async displayNotification(title: string, body: string) {
    if (!this.channelId) {
      await this.initialize();
    }

    const channelId = this.channelId;
    if (!channelId) {
      throw new Error('Notification channel not initialized');
    }

    await notifee.displayNotification({
      title,
      body,
      android: {
        channelId,
        smallIcon: 'ic_launcher', // Optional, defaults to 'ic_launcher'
        importance: AndroidImportance.HIGH,
        pressAction: {
          id: 'default',
        },
      },
    });
  }
}

export const notificationService = new NotificationService();
