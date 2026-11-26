// The #899 filter panel under the mail search box: read state, direction, star, attachment,
// sender / recipient / receiving address (picked from known addresses) and a date range.
// Built from the @dub/ui filter primitives (FilterBar / FilterChips / FilterChip) plus
// SearchableSelect and DatePicker; data comes in through props.
import { DatePicker, FilterBar, FilterChip, FilterChips, SearchableSelect, type SearchableSelectOption } from "@dub/ui";
import { activeFilterCount, NO_FILTERS, withoutFilter, type DirectionFilter, type KnownAddress, type MailFilters, type ReadFilter } from "./mailFilters.ts";
import styles from "./MailFilterBar.module.css";

type Choice<V extends string> = V | "all";

const READ_OPTIONS = [
  { value: "all", label: "すべて", testId: "fe2-mail-filter-read-all" },
  { value: "unread", label: "未読", testId: "fe2-mail-filter-read-unread" },
  { value: "read", label: "既読", testId: "fe2-mail-filter-read-read" },
] as const;
const DIRECTION_OPTIONS = [
  { value: "all", label: "送受信", testId: "fe2-mail-filter-dir-all" },
  { value: "received", label: "受信", testId: "fe2-mail-filter-dir-received" },
  { value: "sent", label: "送信", testId: "fe2-mail-filter-dir-sent" },
] as const;

export interface MailFilterBarProps {
  value: MailFilters;
  onChange: (next: MailFilters) => void;
  /** Senders / recipients to pick from (loaded mail + the viewer). */
  addresses: readonly KnownAddress[];
  /** Addresses the viewer receives at. The picker shows only when there are several. */
  mailboxes: readonly string[];
  /** The list is still loading: the address menus show a skeleton. */
  loading?: boolean;
}

/** Options for an address picker: 指定なし first, the current value kept even if not loaded. */
function addressOptions(addresses: readonly KnownAddress[], current: string | undefined): SearchableSelectOption[] {
  const list = current && !addresses.some((a) => a.email === current) ? [...addresses, { email: current }] : addresses;
  return [
    { value: "", label: "指定なし" },
    ...list.map((a) => ({ value: a.email, label: a.name ?? a.email, ...(a.name ? { description: a.email } : {}) })),
  ];
}

export function MailFilterBar({ value, onChange, addresses, mailboxes, loading = false }: MailFilterBarProps): JSX.Element {
  const set = <K extends keyof MailFilters>(key: K, v: MailFilters[K] | undefined): void =>
    onChange(v === undefined || v === "" ? withoutFilter(value, key) : { ...value, [key]: v });
  const field = (key: "from" | "to" | "mailbox", label: string, options: SearchableSelectOption[]) => (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={`fe2-mail-filter-${key}-input`}>
        {label}
      </label>
      <div className={styles.picker}>
        <SearchableSelect
          id={`fe2-mail-filter-${key}-input`}
          testId={`fe2-mail-filter-${key}`}
          value={value[key] ?? ""}
          onChange={(v) => set(key, v)}
          options={options}
          placeholder="指定なし"
          searchPlaceholder="名前・アドレスで検索"
          emptyText="該当するアドレスがありません"
          loading={loading && options.length <= 1}
          aria-label={`${label}で絞り込む`}
        />
      </div>
    </div>
  );

  return (
    <FilterBar
      testId="fe2-mail-filter-bar"
      aria-label="メールの絞り込み"
      activeCount={activeFilterCount(value)}
      activeCountTestId="fe2-mail-filter-count"
      onClear={() => onChange(NO_FILTERS)}
      clearTestId="fe2-mail-filter-clear"
      className={styles.bar}
    >
      <FilterChips<Choice<ReadFilter>>
        aria-label="既読・未読で絞り込む"
        value={value.read ?? "all"}
        onChange={(v) => set("read", v === "all" ? undefined : v)}
        options={READ_OPTIONS}
      />
      <FilterChips<Choice<DirectionFilter>>
        aria-label="受信・送信で絞り込む"
        value={value.direction ?? "all"}
        onChange={(v) => set("direction", v === "all" ? undefined : v)}
        options={DIRECTION_OPTIONS}
      />
      <FilterChip selected={value.starred === true} onToggle={() => set("starred", value.starred ? undefined : true)} testId="fe2-mail-filter-starred">
        スター付き
      </FilterChip>
      <FilterChip selected={value.attachment === true} onToggle={() => set("attachment", value.attachment ? undefined : true)} testId="fe2-mail-filter-attachment">
        添付あり
      </FilterChip>
      <div className={styles.fields}>
        {field("from", "差出人", addressOptions(addresses, value.from))}
        {field("to", "宛先", addressOptions(addresses, value.to))}
        {mailboxes.length > 1
          ? field(
              "mailbox",
              "受信アドレス",
              addressOptions(
                mailboxes.map((email) => ({ email })),
                value.mailbox,
              ),
            )
          : null}
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="fe2-mail-filter-after-input">
            期間
          </label>
          <div className={styles.range}>
            <DatePicker id="fe2-mail-filter-after-input" testId="fe2-mail-filter-after" value={value.after ?? null} max={value.before} onChange={(v) => set("after", v ?? undefined)} />
            <span className={styles.rangeSep} aria-hidden>
              〜
            </span>
            <DatePicker id="fe2-mail-filter-before-input" testId="fe2-mail-filter-before" value={value.before ?? null} min={value.after} onChange={(v) => set("before", v ?? undefined)} />
          </div>
        </div>
      </div>
    </FilterBar>
  );
}
