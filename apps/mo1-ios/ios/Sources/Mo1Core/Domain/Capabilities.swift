// Capabilities — UI show/hide from the server-returned capabilities array
// (design §1, §6: "UI は capabilities に従い出し分けのみ"), mirrors
// capabilities.ts. The client NEVER decides authorization; it only mirrors what
// the BFF grants (default deny).
import Foundation

/// Does the resource's capability set include `key`? (default deny.)
public func can(_ capabilities: [PermissionKey], _ key: PermissionKey) -> Bool {
    capabilities.contains(key)
}

/// S4 action editing / S3 event editing gate.
public func canEditEvent(_ capabilities: [PermissionKey]) -> Bool {
    can(capabilities, .eventWrite)
}

/// S5 task status change gate.
public func canWriteTask(_ capabilities: [PermissionKey]) -> Bool {
    can(capabilities, .taskWrite)
}
