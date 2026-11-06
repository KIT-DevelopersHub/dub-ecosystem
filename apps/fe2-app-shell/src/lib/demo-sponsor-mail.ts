// demo (VITE_DEMO=1) のスポンサーのメール連携。本番の member-service + mail-gateway の代わりに、
// メモリ上の「送受信の記録」と同じ決まり (@dub/types sponsor の buildLeadMatcher / applyMailContacts) で営業先を更新する。
// - メール画面から送る (POST /mail/outbox) → recordMail("sent") → 宛先の営業先が 初回連絡 + 日付。
// - 紐付け・履歴・既存メールからの一括補完の API。seed の「過去のメール」で一括補完の差分が出る。
// 企業・アドレスはすべて架空 (example.jp)。リロードで消える。
import { sponsor } from "@dub/types";

type Lead = sponsor.SponsorLead;

interface MailEvent {
  direction: sponsor.MailDirection;
  at: string;
  address: string;
  mailbox: string | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const err = (code: string, status: number) => json({ error: { code, message: code, retryable: false } }, status);

export function createSponsorMailDemo(leads: Lead[], me: () => { id: string; displayName: string }) {
  const links: sponsor.SponsorMailLink[] = [];
  const activity: sponsor.LeadActivity[] = [];
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  // Dub に残っている「過去のメール」(一括補完の材料)。
  const log: MailEvent[] = [
    { direction: "sent", at: daysAgo(21), address: "kato@nomi-robotics.example.jp", mailbox: "suzuki@developershub.jp" },
    { direction: "received", at: daysAgo(19), address: "kato@nomi-robotics.example.jp", mailbox: "suzuki@developershub.jp" },
    { direction: "sent", at: daysAgo(25), address: "sato@kaga-data.example.jp", mailbox: "mori@developershub.jp" },
    // demo の受信トレイにある ACME からのメール。メール画面で営業先に紐付けると、この送受信から日付が入る。
    { direction: "sent", at: daysAgo(5), address: "sponsor@acme.co.jp", mailbox: "demo@developershub.jp" },
    { direction: "received", at: daysAgo(3), address: "sponsor@acme.co.jp", mailbox: "demo@developershub.jp" },
  ];
  let seq = 0;
  // demo の削除は配列から抜くので、ここにある行が全部生きている。
  const alive = () => leads;
  const matcher = () => sponsor.buildLeadMatcher(alive(), links);

  /** 決まりを当てて (変化があれば) 保存し、履歴を 1 件残す。 */
  function apply(lead: Lead, events: readonly (MailEvent & { by: sponsor.MailMatchBy })[], source: sponsor.MailSyncSource, dryRun: boolean) {
    const { next, changes } = sponsor.applyMailContacts(lead, events.map((e) => ({ direction: e.direction, on: sponsor.jstDate(e.at) })));
    if (changes.length === 0 || dryRun) return changes;
    const now = new Date().toISOString();
    Object.assign(lead, next, { version: lead.version + 1, updatedAt: now });
    const first = changes.find((c) => c.field === "firstContactOn")?.to;
    const ev = (first && events.find((e) => e.direction === "sent" && sponsor.jstDate(e.at) === first)) || [...events].sort((a, b) => b.at.localeCompare(a.at))[0]!;
    activity.unshift({
      id: `lact_demo_${++seq}`, leadId: lead.id, source, direction: ev.direction, mailAt: ev.at, counterpart: ev.address,
      matchedBy: ev.by, mailbox: ev.mailbox, changes, createdAt: now,
    });
    return changes;
  }

  /** 営業先ごとの、照合できたメール (onlyLeads に入るものだけ)。 */
  function eventsByLead(events: readonly MailEvent[], onlyLeads?: ReadonlySet<string>) {
    const match = matcher();
    const out = new Map<string, (MailEvent & { by: sponsor.MailMatchBy })[]>();
    for (const e of events) {
      const m = match(e.address);
      if (!m || (onlyLeads && !onlyLeads.has(m.leadId))) continue;
      out.set(m.leadId, [...(out.get(m.leadId) ?? []), { ...e, by: m.by }]);
    }
    return out;
  }

  /** Dub のメールを送った / 受け取った (本番の mail-gateway → member-service 通知と同じ)。 */
  function recordMail(direction: sponsor.MailDirection, counterparts: readonly string[], at: string, mailbox: string | null): void {
    const events = counterparts
      .map((c) => sponsor.normalizeAddress(c))
      .filter((a): a is string => !!a && !sponsor.OWN_MAIL_DOMAINS.includes(sponsor.mailDomain(a)))
      .map((address) => ({ direction, at, address, mailbox }));
    log.push(...events);
    for (const [leadId, evs] of eventsByLead(events)) {
      const lead = leads.find((l) => l.id === leadId);
      if (lead) apply(lead, evs, "live", false);
    }
  }

  function handle(method: string, pathname: string, body: any): Response | null {
    const base = "/api/v1/members/sponsor";
    if (pathname === `${base}/mail-links` && method === "GET") return json({ links: links.map((l) => ({ ...l })) });
    const del = new RegExp(`^${base}/mail-links/([^/]+)$`).exec(pathname);
    if (del && method === "DELETE") {
      const i = links.findIndex((l) => l.id === decodeURIComponent(del[1]!));
      if (i < 0) return err("SPONSOR_MAIL_LINK_NOT_FOUND", 404);
      links.splice(i, 1);
      return json(null, 204);
    }
    if (pathname === `${base}/leads/mail-backfill` && method === "POST") {
      if (typeof body?.dryRun !== "boolean") return err("VALIDATION_FAILED", 400);
      const offset = body.offset ?? 0;
      const limit = body.limit ?? sponsor.MAIL_BACKFILL_DEFAULT_LIMIT;
      const ordered = [...alive()].sort((a, b) => a.id.localeCompare(b.id));
      const page = ordered.slice(offset, offset + limit);
      const proposals: sponsor.MailBackfillProposal[] = [];
      for (const [leadId, evs] of eventsByLead(log, new Set(page.map((l) => l.id)))) {
        const lead = leads.find((l) => l.id === leadId)!;
        const changes = apply(lead, evs, "backfill", body.dryRun);
        if (changes.length === 0) continue;
        const by = evs.some((e) => e.by === "link") ? "link" : evs.some((e) => e.by === "email") ? "email" : "domain";
        proposals.push({
          leadId, companyName: lead.companyName, matchedBy: by, changes,
          evidence: evs.map((e) => ({ direction: e.direction, at: e.at, counterpart: e.address })),
          ...(body.dryRun ? {} : { applied: true }),
        });
      }
      const res: sponsor.MailBackfillResponse = {
        dryRun: body.dryRun, offset, limit, total: ordered.length,
        nextOffset: offset + limit < ordered.length ? offset + limit : null,
        proposals: proposals.sort((a, b) => a.companyName.localeCompare(b.companyName, "ja")),
      };
      return json(res);
    }
    const sub = new RegExp(`^${base}/leads/([^/]+)/(mail-links|activity)$`).exec(pathname);
    if (!sub) return null;
    const lead = alive().find((l) => l.id === decodeURIComponent(sub[1]!));
    if (!lead) return err("SPONSOR_LEAD_NOT_FOUND", 404);
    if (sub[2] === "activity" && method === "GET") return json({ activity: activity.filter((a) => a.leadId === lead.id) });
    if (sub[2] === "mail-links" && method === "POST") {
      const address = sponsor.normalizeAddress(body?.address);
      if (!address || sponsor.OWN_MAIL_DOMAINS.includes(sponsor.mailDomain(address))) return err("VALIDATION_FAILED", 400);
      const u = me();
      const prev = links.findIndex((l) => l.address === address);
      const link: sponsor.SponsorMailLink = {
        id: prev >= 0 ? links[prev]!.id : `mlink_demo_${++seq}`, leadId: lead.id, address, threadId: body?.threadId ?? null,
        createdBy: u.id as sponsor.SponsorMailLink["createdBy"], createdByName: u.displayName, createdAt: new Date().toISOString(),
      };
      if (prev >= 0) links.splice(prev, 1);
      links.unshift(link);
      if (lead.contactEmail === null) Object.assign(lead, { contactEmail: address, version: lead.version + 1, updatedAt: link.createdAt });
      const evs = eventsByLead(log.filter((e) => e.address === address), new Set([lead.id])).get(lead.id) ?? [];
      if (evs.length > 0) apply(lead, evs, "link", false);
      return json({ link: { ...link }, lead: { ...lead } } satisfies sponsor.CreateMailLinkResponse, 201);
    }
    return null;
  }

  return { handle, recordMail };
}
