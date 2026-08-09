// Identity — the RBAC permission-key surface consumed for capability gating.
// Mirrors packages/types/src/identity.ts PermissionKey. Modelled as a
// string-backed value type so callers keep the `"event:write"` literal
// ergonomics of the TS union while staying Codable as a plain JSON string.
import Foundation

public struct PermissionKey: RawRepresentable, Codable, Hashable, ExpressibleByStringLiteral, CustomStringConvertible, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(stringLiteral value: String) { self.rawValue = value }
    public var description: String { rawValue }

    public init(from decoder: Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }

    // Frozen P0 catalog keys used by the mobile app (subset of the 23-key catalog).
    public static let identityRead: PermissionKey = "identity:read"
    public static let eventRead: PermissionKey = "event:read"
    public static let eventWrite: PermissionKey = "event:write"
    public static let eventAdmin: PermissionKey = "event:admin"
    public static let taskRead: PermissionKey = "task:read"
    public static let taskWrite: PermissionKey = "task:write"
}
