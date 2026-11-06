#!/usr/bin/env bash
#
# dub-core の lp_ticket_* を dub-tickets へコピーして件数を照合する。手順全体は
# docs/runbooks/09-lp-tickets-cutover.md。購入者の個人情報を扱うので、書き出したファイルは
# 権限 700 の一時ディレクトリに置き、終了時に消す。リポジトリや作業ディレクトリには残さない。
#
#   bash services/lp-tickets/scripts/copy-from-dub-core.sh --verify-only
#   bash services/lp-tickets/scripts/copy-from-dub-core.sh --i-have-stopped-sales
#
# --verify-only          読むだけ。両 DB の件数と注文の status 別件数を比べる。
# --i-have-stopped-sales 書き込みを許す確認フラグ。次のどれかに当たれば何も書かずに止まる:
#                        販売中 / pending の注文あり / コピー先が空でない / 列の並びが違う。
#
# env: CLOUDFLARE_API_TOKEN (必須), WRANGLER_BIN, SRC_DB (dub-core), DST_DB (dub-tickets)
set -euo pipefail

WRANGLER="${WRANGLER_BIN:-pnpm dlx wrangler@4.35.0}"
SRC_DB="${SRC_DB:-dub-core}"
DST_DB="${DST_DB:-dub-tickets}"
TABLES=(lp_ticket_settings lp_ticket_types lp_ticket_coupons lp_ticket_orders lp_ticket_order_items)

usage() {
  sed -n '3,14p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

MODE=""
case "${1:-}" in
  --verify-only) MODE=verify ;;
  --i-have-stopped-sales) MODE=copy ;;
  *) usage ;;
esac
[ "$#" -eq 1 ] || usage

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "error: CLOUDFLARE_API_TOKEN is not set." >&2
  exit 1
fi

# SELECT / PRAGMA を 1 文流し、結果行を 1 行 1 JSON で返す。
query() {
  local db="$1" sql="$2"
  $WRANGLER d1 execute "$db" --remote --json --command "$sql" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const out = JSON.parse(s.slice(s.indexOf("[")));
      for (const row of out[0].results) console.log(JSON.stringify(row));
    });'
}

scalar() {  # scalar DB SQL — the single value of `SELECT ... AS v`
  query "$1" "$2" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => console.log(JSON.parse(s.trim()).v));'
}

columns() {  # columns DB TABLE — name:type in physical order
  query "$1" "SELECT name || ':' || type AS v FROM pragma_table_info('$2') ORDER BY cid" \
    | node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        console.log(s.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).v).join(","));
      });'
}

compare() {
  local failed=0 t a b
  for t in "${TABLES[@]}"; do
    a="$(scalar "$SRC_DB" "SELECT COUNT(*) AS v FROM $t")"
    b="$(scalar "$DST_DB" "SELECT COUNT(*) AS v FROM $t")"
    if [ "$a" = "$b" ]; then echo "  ok   $t: $a"; else echo "  DIFF $t: $SRC_DB=$a $DST_DB=$b"; failed=1; fi
  done
  local status_sql="SELECT status || '=' || COUNT(*) || '/' || COALESCE(MAX(paid_at), '') || '/' || COALESCE(MAX(refunded_at), '') AS k FROM lp_ticket_orders GROUP BY status ORDER BY status"
  a="$(query "$SRC_DB" "$status_sql")"
  b="$(query "$DST_DB" "$status_sql")"
  if [ "$a" = "$b" ]; then
    echo "  ok   status breakdown"
  else
    echo "  DIFF status breakdown"
    echo "    $SRC_DB: $a"
    echo "    $DST_DB: $b"
    failed=1
  fi
  return "$failed"
}

if [ "$MODE" = verify ]; then
  echo "comparing $SRC_DB -> $DST_DB"
  compare
  echo "counts match."
  exit 0
fi

echo "== preflight (read-only) =="
for t in "${TABLES[@]}"; do
  a="$(columns "$SRC_DB" "$t")"
  b="$(columns "$DST_DB" "$t")"
  if [ -z "$a" ] || [ "$a" != "$b" ]; then
    echo "error: column order differs on $t (the export INSERTs would land in the wrong columns)." >&2
    echo "  $SRC_DB: $a" >&2
    echo "  $DST_DB: $b" >&2
    exit 1
  fi
  n="$(scalar "$DST_DB" "SELECT COUNT(*) AS v FROM $t")"
  if [ "$n" != "0" ]; then
    echo "error: $DST_DB.$t already has $n rows. Nothing was written." >&2
    exit 1
  fi
done
on_sale="$(scalar "$SRC_DB" "SELECT COUNT(*) AS v FROM lp_ticket_settings WHERE enabled = 1")"
if [ "$on_sale" != "0" ]; then
  echo "error: sales are still on in $SRC_DB. Turn them off in LP管理 first." >&2
  exit 1
fi
pending="$(scalar "$SRC_DB" "SELECT COUNT(*) AS v FROM lp_ticket_orders WHERE status = 'pending'")"
if [ "$pending" != "0" ]; then
  echo "error: $pending pending orders in $SRC_DB. Wait until the reconcile settles them." >&2
  exit 1
fi

WORK="$(mktemp -d)"
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT

echo "== export from $SRC_DB =="
for t in "${TABLES[@]}"; do
  $WRANGLER d1 export "$SRC_DB" --remote --no-schema --table "$t" --output "$WORK/$t.sql"
done

echo "== import into $DST_DB =="
for t in "${TABLES[@]}"; do
  if grep -q 'INSERT' "$WORK/$t.sql"; then
    $WRANGLER d1 execute "$DST_DB" --remote --yes --file "$WORK/$t.sql"
  else
    echo "  $t: no rows"
  fi
done

echo "== compare =="
compare
echo "copy complete."
