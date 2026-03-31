package com.notificationsync

import com.margelo.nitro.notificationsync.HybridNotificationSyncSpec

class HybridNotificationSync: HybridNotificationSyncSpec() {
    override fun getPendingNotifications(): String = "[]"

    override fun clearPendingNotifications(): Unit = Unit
}
