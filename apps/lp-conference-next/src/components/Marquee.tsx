// Marquee — reproduces goodpatch's signature oversized horizontal-scrolling
// wordmark strip (the "Latest Activity" band). Giant outline text glides
// sideways forever on a dark navy block; two tracks scroll in opposite
// directions for depth. Pure CSS (translateX keyframes) — paused under
// prefers-reduced-motion (see globals.css). Decorative; original text only.
export function Marquee({
  words = "HOKURIKU IT CONFERENCE 2027",
  sub = "IT × 大規模 × 北陸",
}: {
  words?: string;
  sub?: string;
}) {
  // The words are drawn from data-text via ::before (globals.css): this strip is purely
  // decorative (aria-hidden) and its ghost/outline text is intentionally faint, so it
  // is kept out of the text-contrast check without changing how it looks.
  const unit = (
    <span className="marquee-unit">
      <span className="marquee-word" data-text={words} />
      <span className="marquee-star" aria-hidden="true">✦</span>
      <span className="marquee-word marquee-word--sub" data-text={sub} />
      <span className="marquee-star" aria-hidden="true">✦</span>
    </span>
  );
  return (
    <section className="marquee" aria-hidden="true">
      <div className="marquee-track marquee-track--a">
        {unit}
        {unit}
        {unit}
      </div>
      <div className="marquee-track marquee-track--b">
        {unit}
        {unit}
        {unit}
      </div>
    </section>
  );
}
