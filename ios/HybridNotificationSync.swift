//
//  HybridNotificationSync.swift
//  Pods
//
//  Created by Pavlo Emurgo on 3/30/2026.
//

import Foundation
import NitroModules

class HybridNotificationSync: HybridNotificationSyncSpec {
  /// Derived at runtime from the host app's bundle identifier so this module
  /// works with any app without hardcoding. The convention is `group.<bundleId>`,
  /// which must match the App Group configured in the entitlements by the
  /// Expo config plugin (app.plugin.js).
  private var appGroup: String {
    "group.\(Bundle.main.bundleIdentifier ?? "")"
  }
  private let storageKey = "pending_push_notifications"

  func getPendingNotifications() throws -> String {
    guard let defaults = UserDefaults(suiteName: appGroup) else {
      return "[]"
    }
    let pending = defaults.array(forKey: storageKey) as? [[String: Any]] ?? []
    guard
      let data = try? JSONSerialization.data(withJSONObject: pending),
      let json = String(data: data, encoding: .utf8)
    else {
      return "[]"
    }
    return json
  }

  func clearPendingNotifications() throws {
    UserDefaults(suiteName: appGroup)?.removeObject(forKey: storageKey)
  }
}
