import type { HybridObject } from 'react-native-nitro-modules'

export interface NotificationSync extends HybridObject<{ ios: 'swift', android: 'kotlin' }> {
  /**
   * Returns pending notifications stored by the iOS Notification Service Extension
   * as a JSON string (array of PushEvent objects). On Android returns "[]".
   */
  getPendingNotifications(): string

  /**
   * Clears the pending notifications from shared App Group storage.
   * No-op on Android.
   */
  clearPendingNotifications(): void
}
