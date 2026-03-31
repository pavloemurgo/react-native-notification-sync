// @ts-check
const path = require('path')
const fs = require('fs')

/**
 * Lazily resolves @expo/config-plugins from the consuming Expo project,
 * since this package lives outside the monorepo and doesn't bundle it.
 * @returns {typeof import('@expo/config-plugins')}
 */
function getConfigPlugins() {
  try {
    return require('@expo/config-plugins')
  } catch {
    // Fall back to resolving from process.cwd() — the Expo project root
    const resolved = require.resolve('@expo/config-plugins', { paths: [process.cwd()] })
    return require(resolved)
  }
}

const EXT_NAME = 'NotificationServiceExtension'
const EXT_ENTITLEMENTS = `${EXT_NAME}/${EXT_NAME}.entitlements`
const EXT_INFOPLIST  = `${EXT_NAME}/Info.plist`

/**
 * Inlined so the plugin is self-contained regardless of how bun caches the package.
 * Must stay in sync with ios/NotificationServiceExtension/NotificationService.swift.
 */
const NOTIFICATION_SERVICE_SWIFT = `import UserNotifications

class NotificationService: UNNotificationServiceExtension {
  private let appGroup: String
  private let storageKey = "pending_push_notifications"

  override init() {
    // Derived at runtime from the main bundle's App Group entitlement so the same
    // Swift source works for any bundle ID configured by the Expo config plugin.
    let mainBundleId = Bundle.main.bundleIdentifier ?? ""
    // Bundle ID of the extension is "<mainBundleId>.NotificationServiceExtension",
    // so we strip the suffix to get the host app's bundle ID.
    let hostBundleId = mainBundleId
      .replacingOccurrences(of: ".NotificationServiceExtension", with: "")
    appGroup = "group.\\(hostBundleId)"
    super.init()
  }

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    let content = request.content.mutableCopy() as! UNMutableNotificationContent
    let userInfo = request.content.userInfo
    let messageId = userInfo["gcm.message_id"] as? String ?? UUID().uuidString
    let from = userInfo["from"] as? String ?? ""

    var eventData: [String: Any] = [:]
    for (k, v) in userInfo {
      if let key = k as? String { eventData[key] = v }
    }

    let trigger = from.contains("campaigns") ? "campaigns" : "push"
    let id = hashMessageId(messageId)

    let event: [String: Any] = [
      "id": id,
      "date": ISO8601DateFormatter().string(from: Date()),
      "isRead": false,
      "title": content.title,
      "body": content.body,
      "data": eventData,
      "trigger": trigger,
    ]

    if let defaults = UserDefaults(suiteName: appGroup) {
      var pending = defaults.array(forKey: storageKey) as? [[String: Any]] ?? []
      if !pending.contains(where: { ($0["id"] as? Int) == id }) {
        pending.append(event)
        defaults.set(pending, forKey: storageKey)
        defaults.synchronize()
      }
    }

    contentHandler(content)
  }

  override func serviceExtensionTimeWillExpire() {}

  /// Matches the JS djb2-style hash in firebase.ts: hash = (31 * hash + charCode) | 0, then abs()
  private func hashMessageId(_ messageId: String) -> Int {
    var hash: Int32 = 0
    for unit in messageId.utf16 {
      hash = 31 &* hash &+ Int32(unit)
    }
    return Int(abs(hash))
  }
}
`

/** @param {string} version @param {string} buildNumber */
function makeInfoPlist(version, buildNumber) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>$(PRODUCT_NAME)</string>
  <key>CFBundleExecutable</key>
  <string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key>
  <string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$(PRODUCT_NAME)</string>
  <key>CFBundlePackageType</key>
  <string>XPC!</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${buildNumber}</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.usernotifications.service</string>
    <key>NSExtensionPrincipalClass</key>
    <string>$(PRODUCT_MODULE_NAME).NotificationService</string>
  </dict>
</dict>
</plist>`
}

/** @param {string} appGroup */
function makeEntitlements(appGroup) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.application-groups</key>
  <array>
    <string>${appGroup}</string>
  </array>
</dict>
</plist>`
}

/**
 * Expo Config Plugin for react-native-notification-sync.
 *
 * Adds a Notification Service Extension that intercepts incoming FCM notifications
 * and stores them in shared App Group storage (UserDefaults) so they appear in the
 * app's inbox even if the user never tapped the notification banner.
 *
 * @param {import('@expo/config-plugins').ExpoConfig} config
 * @param {{ appGroup?: string }} options
 */
function withNotificationSync(config, options = {}) {
  const { withEntitlementsPlist, withDangerousMod, withXcodeProject, IOSConfig } = getConfigPlugins()
  const bundleId = config.ios?.bundleIdentifier ?? 'com.app'
  const appGroup = options.appGroup ?? `group.${bundleId}`

  // 1. Add App Groups to main target entitlements
  config = withEntitlementsPlist(config, (cfg) => {
    const groups = cfg.modResults['com.apple.security.application-groups'] ?? []
    if (!groups.includes(appGroup)) {
      cfg.modResults['com.apple.security.application-groups'] = [...groups, appGroup]
    }
    return cfg
  })

  // 2. Write extension source files into ios/<EXT_NAME>/
  config = withDangerousMod(config, [
    'ios',
    (cfg) => {
      const iosDir = path.join(cfg.modRequest.projectRoot, 'ios')
      const extDir = path.join(iosDir, EXT_NAME)
      fs.mkdirSync(extDir, { recursive: true })

      // Write inlined NotificationService.swift (self-contained, no copyFileSync)
      fs.writeFileSync(path.join(extDir, 'NotificationService.swift'), NOTIFICATION_SERVICE_SWIFT)

      // Generate Info.plist and entitlements
      const version = cfg.version ?? '1.0.0'
      const buildNumber = cfg.ios?.buildNumber ?? '1'
      fs.writeFileSync(path.join(extDir, 'Info.plist'), makeInfoPlist(version, buildNumber))
      fs.writeFileSync(path.join(extDir, `${EXT_NAME}.entitlements`), makeEntitlements(appGroup))

      return cfg
    },
  ])

  // 3. Add extension target to Xcode project
  config = withXcodeProject(config, (cfg) => {
    const project = cfg.modResults
    const extBundleId = `${bundleId}.${EXT_NAME}`

    // Idempotency — skip if already added
    const targets = project.pbxNativeTargetSection()
    const alreadyAdded = Object.values(targets).some(
      (t) => t && typeof t === 'object' && (t.name === EXT_NAME || t.name === `"${EXT_NAME}"`)
    )
    if (alreadyAdded) return cfg

    // Add the notification service extension target.
    // addTarget('app_extension') only creates a PBXCopyFilesBuildPhase on the MAIN target
    // (to embed the .appex) — it does NOT create a PBXSourcesBuildPhase for the extension.
    // We must create it ourselves immediately after, before any other plugin gets the project.
    const extTarget = project.addTarget(EXT_NAME, 'app_extension', EXT_NAME, extBundleId)

    // Create the Sources build phase for the extension target
    project.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', extTarget.uuid)

    // All file/group/phase additions are done via direct pbxproj hash manipulation.
    // addSourceFile() with { target } internally calls addPluginFile() → correctForPath()
    // which crashes in xcode 3.x — so we avoid all high-level file APIs.
    const objects = project.hash.project.objects

    // Find the PBX group UUID that addTarget created for our extension
    let extGroupUuid = null
    for (const [uuid, group] of Object.entries(objects['PBXGroup'] ?? {})) {
      if (group && typeof group === 'object' && (group.name === EXT_NAME || group.name === `"${EXT_NAME}"`)) {
        extGroupUuid = uuid
        break
      }
    }

    // PBXFileReference for NotificationService.swift.
    // Path is relative to the project root (ios/ directory) with sourceTree "<group>".
    // addTarget() does not create a PBXGroup for app_extension targets, so we anchor
    // the path from the root group — matching how AppDelegate.swift is referenced
    // (e.g. path = SecondFiDev/AppDelegate.swift).
    const swiftRefUuid = project.generateUuid()
    objects['PBXFileReference'][swiftRefUuid] = {
      isa: 'PBXFileReference',
      lastKnownFileType: 'sourcecode.swift',
      path: `"${EXT_NAME}/NotificationService.swift"`,
      sourceTree: '"<group>"',
    }
    objects[`${swiftRefUuid}_comment`] = 'NotificationService.swift'

    // Add the file reference to the root PBXGroup so it appears in the Xcode navigator.
    // The root group (path = undefined, sourceTree = "<group>") resolves to the ios/ dir.
    const rootGroupUuid = project.hash.project.rootObject
      ? (() => {
          const proj = objects['PBXProject']?.[project.hash.project.rootObject]
          return proj?.mainGroup
        })()
      : null
    const groupToAddTo = rootGroupUuid ?? extGroupUuid
    if (groupToAddTo && objects['PBXGroup']?.[groupToAddTo]) {
      objects['PBXGroup'][groupToAddTo].children = objects['PBXGroup'][groupToAddTo].children ?? []
      objects['PBXGroup'][groupToAddTo].children.push({ value: swiftRefUuid, comment: 'NotificationService.swift' })
    }

    // PBXBuildFile so the file is compiled
    const swiftBuildFileUuid = project.generateUuid()
    objects['PBXBuildFile'][swiftBuildFileUuid] = {
      isa: 'PBXBuildFile',
      fileRef: swiftRefUuid,
    }
    objects[`${swiftBuildFileUuid}_comment`] = 'NotificationService.swift in Sources'

    // Find the Sources build phase belonging to the extension target and add the file.
    // Search PBXNativeTarget by name to get the live target, then find its Sources phase.
    const sourcesBuildPhases = objects['PBXSourcesBuildPhase'] ?? {}
    const nativeTargets = objects['PBXNativeTarget'] ?? {}
    let extSourcesPhaseUuid = null
    for (const [targetUuid, target] of Object.entries(nativeTargets)) {
      if (targetUuid.endsWith('_comment') || !target || typeof target !== 'object') continue
      const name = typeof target.name === 'string' ? target.name.replace(/^"|"$/g, '') : ''
      if (name !== EXT_NAME) continue
      for (const phaseRef of (target.buildPhases ?? [])) {
        const phaseUuid = typeof phaseRef === 'object' ? phaseRef.value : phaseRef
        if (phaseUuid && sourcesBuildPhases[phaseUuid]) {
          extSourcesPhaseUuid = phaseUuid
          break
        }
      }
      break
    }
    if (extSourcesPhaseUuid) {
      sourcesBuildPhases[extSourcesPhaseUuid].files = sourcesBuildPhases[extSourcesPhaseUuid].files ?? []
      sourcesBuildPhases[extSourcesPhaseUuid].files.push({
        value: swiftBuildFileUuid,
        comment: 'NotificationService.swift in Sources',
      })
    }

    // Configure build settings for all configurations of this target
    const configurations = project.pbxXCBuildConfigurationSection()
    for (const buildConfig of Object.values(configurations)) {
      if (
        buildConfig &&
        typeof buildConfig === 'object' &&
        buildConfig.buildSettings?.PRODUCT_NAME &&
        (buildConfig.buildSettings.PRODUCT_NAME === EXT_NAME ||
          buildConfig.buildSettings.PRODUCT_NAME === `"${EXT_NAME}"`)
      ) {
        Object.assign(buildConfig.buildSettings, {
          SWIFT_VERSION: '5.0',
          INFOPLIST_FILE: `"${EXT_INFOPLIST}"`,
          CODE_SIGN_ENTITLEMENTS: `"${EXT_ENTITLEMENTS}"`,
          TARGETED_DEVICE_FAMILY: '"1,2"',
          IPHONEOS_DEPLOYMENT_TARGET: '15.1',
          SKIP_INSTALL: 'YES',
          CODE_SIGN_STYLE: 'Automatic',
        })
      }
    }

    // addTarget() with 'app_extension' already creates a "Copy Files" PBXCopyFilesBuildPhase
    // in the main app target that embeds the .appex. We must NOT add another one (causes
    // "Unexpected duplicate tasks"). Instead, find the auto-created phase and:
    //   1. Add CodeSignOnCopy to the build file entry
    //   2. Rename the phase to "Embed App Extensions" (cosmetic, matches Xcode convention)
    //
    // Also add a PBXTargetDependency so Xcode builds the extension before the main app.
    const appexProductRef = extTarget.pbxNativeTarget.productReference
    const copyFilePhases = objects['PBXCopyFilesBuildPhase'] ?? {}

    for (const [phaseUuid, phase] of Object.entries(copyFilePhases)) {
      if (
        phase &&
        typeof phase === 'object' &&
        phase.dstSubfolderSpec === 13
      ) {
        // Rename to match Xcode convention
        phase.name = '"Embed App Extensions"'

        // Find and update the build file for our .appex to add CodeSignOnCopy
        const buildFiles = objects['PBXBuildFile'] ?? {}
        for (const fileEntry of (phase.files ?? [])) {
          const bf = buildFiles[fileEntry.value]
          if (bf && bf.fileRef === appexProductRef) {
            bf.settings = { ATTRIBUTES: ['CodeSignOnCopy', 'RemoveHeadersOnCopy'] }
            break
          }
        }

        // Add the phase to the main app target's buildPhases if not already there
        const [mainTargetUuid, mainTargetObj] = IOSConfig.Target.findFirstNativeTarget(project)
        if (mainTargetUuid && mainTargetObj) {
          const alreadyInTarget = (mainTargetObj.buildPhases ?? []).some((p) => p.value === phaseUuid)
          if (!alreadyInTarget) {
            mainTargetObj.buildPhases = mainTargetObj.buildPhases ?? []
            mainTargetObj.buildPhases.push({ value: phaseUuid, comment: 'Embed App Extensions' })
          }

          // PBXContainerItemProxy + PBXTargetDependency so Xcode builds extension first
          const proxyUuid = project.generateUuid()
          objects['PBXContainerItemProxy'] = objects['PBXContainerItemProxy'] ?? {}
          objects['PBXContainerItemProxy'][proxyUuid] = {
            isa: 'PBXContainerItemProxy',
            containerPortal: project.hash.project.rootObject,
            proxyType: 1,
            remoteGlobalIDString: extTarget.uuid,
            remoteInfo: `"${EXT_NAME}"`,
          }

          const depUuid = project.generateUuid()
          objects['PBXTargetDependency'] = objects['PBXTargetDependency'] ?? {}
          objects['PBXTargetDependency'][depUuid] = {
            isa: 'PBXTargetDependency',
            target: extTarget.uuid,
            targetProxy: proxyUuid,
          }
          objects[`${depUuid}_comment`] = EXT_NAME

          mainTargetObj.dependencies = mainTargetObj.dependencies ?? []
          mainTargetObj.dependencies.push({ value: depUuid, comment: EXT_NAME })
        }
        break
      }
    }

    return cfg
  })

  return config
}

module.exports = withNotificationSync
