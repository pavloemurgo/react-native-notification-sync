import { NitroModules } from 'react-native-nitro-modules'
import type { NotificationSync as NotificationSyncSpec } from './specs/notification-sync.nitro'

export const NotificationSync =
  NitroModules.createHybridObject<NotificationSyncSpec>('NotificationSync')