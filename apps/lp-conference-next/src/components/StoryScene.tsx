"use client";

import { Handshake } from "@/components/Handshake";
import { useScrollScene } from "@/lib/useScrollScene";
import type { StoryScene as SceneData } from "@/config/types";

// StoryScene — 作る / 守る / 導く の1幕。左右交互レイアウトで“物語が流れる”リズムを作る。
// スクロールで --p(0→1) が進み、握手モチーフの装飾（光条・受け継ぎ・ネットワーク）と
// テキストのせり上がりが連動する。transform/opacity のみ（GPU）。
export function StoryScene({
  scene,
  index,
}: {
  scene: SceneData;
  index: number;
}) {
  const { ref, entered } = useScrollScene<HTMLElement>({ rest: 1 });
  const flip = index % 2 === 1; // 偶数=映像左 / 奇数=映像右

  return (
    <section
      id={scene.id}
      ref={ref}
      className={[
        "scene",
        `scene--${scene.variant}`,
        flip ? "scene--flip" : "",
        entered ? "is-in" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={scene.kicker}
    >
      <div className="scene-inner container">
        <div className="scene-visual" aria-hidden="true">
          <div className="scene-visual-inner">
            <Handshake variant={scene.variant} />
          </div>
        </div>

        <div className="scene-copy">
          <p className="scene-kicker">{scene.kicker}</p>
          <h2 className="scene-title">{scene.title}</h2>
          <p className="scene-lead">{scene.lead}</p>
          <ul className="scene-points">
            {scene.points.map((p, i) => (
              <li key={i} className="scene-point" style={{ ["--i" as string]: i }}>
                <span className="scene-point-dot" aria-hidden="true" />
                {p}
              </li>
            ))}
          </ul>
          {scene.local && <p className="scene-local">{scene.local}</p>}
        </div>
      </div>
    </section>
  );
}
