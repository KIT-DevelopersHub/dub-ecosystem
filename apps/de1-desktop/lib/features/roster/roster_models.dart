/// Dart mirrors of the roster wire contract, hand-written for this feature
/// against the shared specs:
///   - `docs/openapi/identity-roster.yaml` (IdentityUser, Role, PaginatedUsers,
///     PaginatedRoles) — reached through the gateway at `/api/v1/identity/*`.
///   - `docs/openapi/mail-gateway.yaml` (EmailRoutingAddress) — reached at
///     `/api/v1/mail/admin/email-routing/addresses`.
///
/// These stay confined to the roster feature so the shared `api/` layer keeps
/// only the vertical-slice types until OpenAPI->Dart codegen lands (see
/// ARCHITECTURE.md "Contract reuse").
library;

/// identity-roster `UserStatus`.
enum UserStatus {
  active,
  invited,
  disabled,
  rejected,
  unknown;

  static UserStatus fromWire(String? raw) {
    switch (raw) {
      case 'active':
        return UserStatus.active;
      case 'invited':
        return UserStatus.invited;
      case 'disabled':
        return UserStatus.disabled;
      case 'rejected':
        return UserStatus.rejected;
      default:
        return UserStatus.unknown;
    }
  }

  /// Japanese label for display.
  String get label {
    switch (this) {
      case UserStatus.active:
        return '有効';
      case UserStatus.invited:
        return '招待済み';
      case UserStatus.disabled:
        return '無効';
      case UserStatus.rejected:
        return '却下';
      case UserStatus.unknown:
        return '不明';
    }
  }
}

/// identity-roster `IdentityUser` — a roster member.
class IdentityUser {
  const IdentityUser({
    required this.id,
    required this.orgId,
    required this.displayName,
    required this.email,
    required this.status,
    required this.roleIds,
    this.githubLogin,
    this.avatarUrl,
  });

  final String id;
  final String orgId;
  final String displayName;
  final String email;
  final UserStatus status;
  final List<String> roleIds;
  final String? githubLogin;
  final String? avatarUrl;

  factory IdentityUser.fromJson(Map<String, dynamic> json) => IdentityUser(
        id: json['id'] as String,
        orgId: json['orgId'] as String? ?? '',
        displayName: json['displayName'] as String? ?? '',
        email: json['email'] as String? ?? '',
        status: UserStatus.fromWire(json['status'] as String?),
        roleIds: (json['roleIds'] as List<dynamic>? ?? const [])
            .map((e) => e as String)
            .toList(),
        githubLogin: json['githubLogin'] as String?,
        avatarUrl: json['avatarUrl'] as String?,
      );
}

/// identity-roster `Role`.
class Role {
  const Role({
    required this.id,
    required this.name,
    required this.isSystem,
    this.memberCount,
  });

  final String id;
  final String name;
  final bool isSystem;

  /// Distinct users holding this role (present on list responses).
  final int? memberCount;

  factory Role.fromJson(Map<String, dynamic> json) => Role(
        id: json['id'] as String,
        name: json['name'] as String? ?? json['id'] as String,
        isSystem: json['isSystem'] as bool? ?? false,
        memberCount: json['memberCount'] as int?,
      );
}

/// identity-roster `PaginatedUsers`.
class PaginatedUsers {
  const PaginatedUsers({required this.items, required this.nextCursor});

  final List<IdentityUser> items;
  final String? nextCursor;

  factory PaginatedUsers.fromJson(Map<String, dynamic> json) => PaginatedUsers(
        items: (json['items'] as List<dynamic>? ?? const [])
            .map((e) => IdentityUser.fromJson(e as Map<String, dynamic>))
            .toList(),
        nextCursor: json['nextCursor'] as String?,
      );
}

/// identity-roster `PaginatedRoles`.
class PaginatedRoles {
  const PaginatedRoles({required this.items, required this.nextCursor});

  final List<Role> items;
  final String? nextCursor;

  factory PaginatedRoles.fromJson(Map<String, dynamic> json) => PaginatedRoles(
        items: (json['items'] as List<dynamic>? ?? const [])
            .map((e) => Role.fromJson(e as Map<String, dynamic>))
            .toList(),
        nextCursor: json['nextCursor'] as String?,
      );
}

/// mail-gateway `EmailRoutingAddress` — a Cloudflare Email Routing destination
/// (forward-target) address. This is the "メール名簿" source.
class EmailRoutingAddress {
  const EmailRoutingAddress({
    required this.id,
    required this.email,
    this.verified,
    this.created,
    this.modified,
  });

  final String id;
  final String email;

  /// ISO timestamp when verified; null while pending.
  final String? verified;
  final String? created;
  final String? modified;

  bool get isVerified => verified != null && verified!.isNotEmpty;

  factory EmailRoutingAddress.fromJson(Map<String, dynamic> json) =>
      EmailRoutingAddress(
        id: json['id'] as String,
        email: json['email'] as String? ?? '',
        verified: json['verified'] as String?,
        created: json['created'] as String?,
        modified: json['modified'] as String?,
      );
}

/// mail-gateway `EmailRoutingAddressList`.
class EmailRoutingAddressList {
  const EmailRoutingAddressList({required this.items});

  final List<EmailRoutingAddress> items;

  factory EmailRoutingAddressList.fromJson(Map<String, dynamic> json) =>
      EmailRoutingAddressList(
        items: (json['items'] as List<dynamic>? ?? const [])
            .map((e) => EmailRoutingAddress.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
}

/// View-model: a roster member joined with the human-readable names of the
/// roles they hold. The join (roleId -> Role.name) is done in the provider so
/// the wire models above stay faithful mirrors of the contract.
class RosterMember {
  const RosterMember({required this.user, required this.roleNames});

  final IdentityUser user;
  final List<String> roleNames;

  /// Joins a page of users with a roleId->name lookup built from the roles list.
  /// Unknown role ids fall back to the raw id so nothing silently disappears.
  static List<RosterMember> join(
    List<IdentityUser> users,
    Map<String, String> roleNamesById,
  ) {
    return users
        .map((u) => RosterMember(
              user: u,
              roleNames: u.roleIds
                  .map((id) => roleNamesById[id] ?? id)
                  .toList(),
            ))
        .toList();
  }
}
