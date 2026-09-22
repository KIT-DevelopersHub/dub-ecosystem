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
  const unit = (
    <span className="marquee-unit">
      <span className="marquee-word">{words}</span>
      <span className="marquee-star" aria-hidden="true">✦</span>
      <span className="marquee-word marquee-word--sub">{sub}</span>
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
