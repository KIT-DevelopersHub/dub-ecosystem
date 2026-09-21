export type HandshakeVariant =
  | "opening"
  | "create"
  | "protect"
  | "lead"
  | "national";

// Handshake — LP v3 の中核モチーフ。
//
// 「二つの手が絡み、ハート型になる握手」をロゴと呼応する抽象 SVG で表現する。
// 具体的な指や写真は描かず、左右2本のリボン（＝二人の手／腕）が下端の“クラスプ”で
// 組み合い、上へ広がってハートを象る。左は青・右はティールで“二人”を示す。
//
// アニメーションは JS を持たず、祖先セクションに書き込まれる CSS 変数 `--p`(0→1)を
// CSS 側の transform/opacity(GPU 合成)で読むだけ（useScrollScene 参照）。variant ごとに
// 周囲へ装飾を足す:
//   create   … クラスプから金色の光条＋粒子が立ち上がる（生まれる）
//   protect  … 受け継ぎのトークンが手から手へ渡り、保護の弧が重なる（受け継ぐ）
//   lead     … 複数のノードが中心のクラスプへ線で結ばれる（導く／組織）
//   national … 波紋が北陸から全国へ広がる（波及・Closing 用）
//
// grad の id は variant ごとに一意化（同一ページで複数描画するため衝突回避）。

export function Handshake({
  variant,
  className,
}: {
  variant: HandshakeVariant;
  className?: string;
}) {
  const uid = variant;
  return (
    <svg
      className={["hs", `hs--${variant}`, className].filter(Boolean).join(" ")}
      viewBox="0 0 400 380"
      role="img"
      aria-label="握手がハートを象るモチーフ"
      focusable="false"
    >
      <defs>
        <linearGradient id={`hsL-${uid}`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#2f61d6" />
          <stop offset="1" stopColor="#4aa3e0" />
        </linearGradient>
        <linearGradient id={`hsR-${uid}`} x1="1" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#0e8a68" />
          <stop offset="1" stopColor="#17b892" />
        </linearGradient>
        <radialGradient id={`hsCore-${uid}`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#fff" stopOpacity="0.95" />
          <stop offset="0.45" stopColor="#ffd98a" stopOpacity="0.9" />
          <stop offset="1" stopColor="#f0a63c" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`hsGold-${uid}`} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#f0a63c" stopOpacity="0" />
          <stop offset="0.5" stopColor="#ffcf6e" />
          <stop offset="1" stopColor="#fff2cf" stopOpacity="0.2" />
        </linearGradient>
      </defs>

      {/* variant 装飾（背面） */}
      {variant === "national" && (
        <g className="hs-ripples" aria-hidden="true">
          <circle className="hs-ripple hs-ripple--1" cx="200" cy="250" r="70" />
          <circle className="hs-ripple hs-ripple--2" cx="200" cy="250" r="70" />
          <circle className="hs-ripple hs-ripple--3" cx="200" cy="250" r="70" />
        </g>
      )}

      {variant === "lead" && (
        <g className="hs-network" aria-hidden="true">
          {LEAD_NODES.map((n, i) => (
            <g key={i} className="hs-net-node" style={{ ["--i" as string]: i }}>
              <line x1="200" y1="250" x2={n.x} y2={n.y} />
              <circle cx={n.x} cy={n.y} r={n.r} />
            </g>
          ))}
        </g>
      )}

      {variant === "protect" && (
        <g className="hs-guard" aria-hidden="true">
          <path
            className="hs-guard-arc"
            d="M92 250 A120 120 0 0 1 308 250"
            fill="none"
          />
          {/* 受け継がれるトークン（手から手へ）— 静的配置 g の中で CSS が横移動させる */}
          <g transform="translate(200 250)">
            <g className="hs-token">
              <rect x="-9" y="-9" width="18" height="18" rx="4" transform="rotate(45)" />
            </g>
          </g>
        </g>
      )}

      {variant === "create" && (
        <g className="hs-rays" transform="translate(200 250)" aria-hidden="true">
          {CREATE_RAYS.map((a, i) => (
            <rect
              key={i}
              className="hs-ray"
              x="-3"
              y="-150"
              width="6"
              height="150"
              rx="3"
              fill={`url(#hsGold-${uid})`}
              style={{ ["--a" as string]: `${a}deg`, ["--i" as string]: i }}
            />
          ))}
          {CREATE_PARTICLES.map((p, i) => (
            <circle
              key={i}
              className="hs-particle"
              cx="0"
              cy="0"
              r={p.r}
              style={{ ["--i" as string]: i, ["--dx" as string]: `${p.dx}px` }}
            />
          ))}
        </g>
      )}

      {/* 二つの手＝ハートを象る左右リボン（常時） */}
      <g className="hs-heart">
        <path
          className="hs-hand hs-hand--l"
          d={LEFT_HAND}
          fill="none"
          stroke={`url(#hsL-${uid})`}
          strokeWidth="20"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          className="hs-hand hs-hand--r"
          d={RIGHT_HAND}
          fill="none"
          stroke={`url(#hsR-${uid})`}
          strokeWidth="20"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* クラスプ（組み合う指）— 二本の短いストロークが交差 */}
        <g className="hs-clasp">
          <path
            d="M182 236 C193 244 207 256 218 264"
            stroke="#fff"
            strokeOpacity="0.85"
            strokeWidth="7"
            strokeLinecap="round"
            fill="none"
          />
          <path
            d="M218 236 C207 244 193 256 182 264"
            stroke="#fff"
            strokeOpacity="0.6"
            strokeWidth="7"
            strokeLinecap="round"
            fill="none"
          />
        </g>
        {/* クラスプの発光コア */}
        <circle className="hs-core-glow" cx="200" cy="250" r="66" fill={`url(#hsCore-${uid})`} />
        <circle className="hs-core" cx="200" cy="250" r="9" fill="#fff" />
      </g>
    </svg>
  );
}

// 左手リボン: 下端クラスプ(200,258) → 左側面を上り → 左のふくらみ → 上部の谷(196,120)
const LEFT_HAND =
  "M200 258 C150 236 78 206 74 140 C71 92 122 70 152 96 C170 111 190 116 196 128";
// 右手リボン: 左の鏡像（x=200 対称）
const RIGHT_HAND =
  "M200 258 C250 236 322 206 326 140 C329 92 278 70 248 96 C230 111 210 116 204 128";

const CREATE_RAYS = [-34, -20, -8, 8, 20, 34];
const CREATE_PARTICLES = [
  { x: 168, r: 4, dx: -22 },
  { x: 200, r: 5, dx: 6 },
  { x: 232, r: 4, dx: 20 },
  { x: 150, r: 3, dx: -34 },
  { x: 250, r: 3, dx: 34 },
];

const LEAD_NODES = [
  { x: 70, y: 120, r: 12 },
  { x: 330, y: 120, r: 12 },
  { x: 60, y: 300, r: 9 },
  { x: 340, y: 300, r: 9 },
  { x: 200, y: 66, r: 14 },
];
