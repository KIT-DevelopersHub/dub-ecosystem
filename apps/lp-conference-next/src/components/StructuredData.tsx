import snapshot from "@/config/snapshot.json";
import type { LpConfig } from "@/config/types";

// JSON-LD structured data (schema.org Event + Organization) so Google can
// surface a rich result (event card / knowledge panel) for "北陸ITカンファレンス".
// Derived entirely from the same read-only publish snapshot the page renders —
// static at build time, never calls internal services live. Kept conservative:
// no `offers` (registration is not open yet — see the disabled hero CTAs), and
// only well-known public facts (campus address, official social handles) are
// filled in alongside the snapshot fields.
const config = snapshot as LpConfig;
const { seo, hero, contact, footer } = config;

const OFFICIAL_SITE_URL =
  footer.links.find((l) => l.label === "公式サイト")?.href ?? "https://developershub.jp";
const INSTAGRAM_URL = "https://www.instagram.com/developershub.conference/";
const X_URL = "https://x.com/DevelopersHubPR";

// Event dates parsed from hero.dateLabel ("2027年9月13日(月)・14日(火)") are not
// machine-friendly, so the ISO dates are pinned here from the same source fact
// (2027-09-13 / 2027-09-14) rather than string-parsed.
const EVENT_START_DATE = "2027-09-13";
const EVENT_END_DATE = "2027-09-14";

// The Event's own name, kept clean (no SEO title-tag suffix like "｜...祭典") —
// Google's rich-result guidelines want the plain event name here.
const EVENT_NAME = `${hero.heading} 2027`;

export function StructuredData() {
  const siteUrl = seo.siteUrl.replace(/\/$/, "");
  const ogImage = seo.ogImage.startsWith("http") ? seo.ogImage : `${siteUrl}${seo.ogImage}`;

  const organization = {
    "@type": "Organization",
    "@id": `${OFFICIAL_SITE_URL}#organization`,
    name: "DevelopersHub",
    alternateName: "一般社団法人 Developers Hub",
    url: OFFICIAL_SITE_URL,
    email: contact.email,
    sameAs: [INSTAGRAM_URL, X_URL],
  };

  const event = {
    "@type": "Event",
    "@id": `${siteUrl}/#event`,
    name: EVENT_NAME,
    description: seo.description,
    startDate: EVENT_START_DATE,
    endDate: EVENT_END_DATE,
    eventStatus: "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    location: {
      "@type": "Place",
      name: hero.venueLabel,
      address: {
        "@type": "PostalAddress",
        streetAddress: "扇が丘7-1",
        addressLocality: "野々市市",
        addressRegion: "石川県",
        postalCode: "921-8501",
        addressCountry: "JP",
      },
    },
    image: [ogImage],
    url: siteUrl,
    organizer: organization,
  };

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [organization, event],
  };

  return (
    // eslint-disable-next-line react/no-danger -- static JSON, no user input.
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
  );
}
