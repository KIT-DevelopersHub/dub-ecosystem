// Unit tests for the roster feature: wire-contract parsing and the
// member<->role join view-model. Pure Dart, no HTTP.
import 'package:dub_desktop/features/roster/roster_models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('IdentityUser parses the identity-roster wire contract', () {
    final user = IdentityUser.fromJson({
      'id': 'usr_1',
      'orgId': 'org_devhub',
      'displayName': 'デモ 太郎',
      'email': 'demo@developershub.jp',
      'githubLogin': 'demo-taro',
      'avatarUrl': null,
      'status': 'active',
      'roleIds': ['role_admin', 'role_organizer'],
      'createdAt': '2026-08-01T00:00:00.000Z',
      'updatedAt': '2026-08-19T00:00:00.000Z',
    });
    expect(user.email, 'demo@developershub.jp');
    expect(user.status, UserStatus.active);
    expect(user.roleIds, ['role_admin', 'role_organizer']);
    expect(user.githubLogin, 'demo-taro');
  });

  test('UserStatus maps unknown wire values to a safe fallback', () {
    expect(UserStatus.fromWire('invited'), UserStatus.invited);
    expect(UserStatus.fromWire('weird'), UserStatus.unknown);
    expect(UserStatus.fromWire(null), UserStatus.unknown);
    expect(UserStatus.active.label, '有効');
  });

  test('PaginatedUsers parses items + nextCursor', () {
    final page = PaginatedUsers.fromJson({
      'items': [
        {
          'id': 'u1',
          'orgId': 'o',
          'displayName': 'A',
          'email': 'a@x.jp',
          'status': 'active',
          'roleIds': <String>[],
        }
      ],
      'nextCursor': null,
    });
    expect(page.items.length, 1);
    expect(page.nextCursor, isNull);
  });

  test('EmailRoutingAddress verified flag reflects the timestamp', () {
    final verified = EmailRoutingAddress.fromJson({
      'id': 'a1',
      'email': 'x@gmail.com',
      'verified': '2026-08-10T00:00:00.000Z',
    });
    final pending = EmailRoutingAddress.fromJson({
      'id': 'a2',
      'email': 'y@gmail.com',
      'verified': null,
    });
    expect(verified.isVerified, isTrue);
    expect(pending.isVerified, isFalse);
  });

  test('RosterMember.join resolves role ids to names, falling back to the id',
      () {
    final users = [
      IdentityUser.fromJson({
        'id': 'u1',
        'orgId': 'o',
        'displayName': 'A',
        'email': 'a@x.jp',
        'status': 'active',
        'roleIds': ['role_admin', 'role_ghost'],
      }),
    ];
    final members = RosterMember.join(users, {'role_admin': '管理者'});
    expect(members.single.roleNames, ['管理者', 'role_ghost']);
  });
}
