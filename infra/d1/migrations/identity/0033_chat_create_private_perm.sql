-- namespace: identity | owner: identity-roster (#3)
-- チャット の「作成できるチャンネル」(作成できない / パブリックのみ / パブリックとプライベート) の
-- カタログキーを 1 本足す:
--   chat:create_private  (POST /chat/channels で visibility=private の非 DM を作る)
-- chat:create を持つロールは今プライベートチャンネルも作れるので、そのまま作れるように付与する。
-- ここで権限を狭めず、絞るかどうかは ロール管理 で選ぶ。
-- 自動適用されない (deploy.yml の migration は no-op)。デプロイ前に手で当てること。未適用だと admin を
-- 含む全ロールがプライベートチャンネルを作れなくなる。
-- Forward-only + idempotent (INSERT OR IGNORE)。

INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key)
  SELECT role_id, 'chat:create_private' FROM identity_role_permissions WHERE permission_key = 'chat:create';
