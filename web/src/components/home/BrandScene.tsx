"use client";

import Image from "next/image";
import { motion, useScroll, useSpring, useTransform } from "motion/react";
import { useId, useRef, type PointerEvent } from "react";
import { useHomeMotion } from "./HomeMotion";

/** Curved, tapered edges echo the logo without distorting the badge contents. */
function BadgeSurface() {
  const gradientId = useId();
  const outline = "M28 9C87 22 152 0 208 6C230 8 240 24 232 44L221 66C216 77 205 80 193 78C132 65 87 88 27 76C8 72 0 56 8 39L16 21C19 13 22 8 28 9Z";

  return (
    <svg className="brand-badge-surface" viewBox="0 0 240 86" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2=".35" y2="1">
          <stop stopColor="var(--badge-light, #fff)" />
          <stop offset="1" stopColor="var(--badge-shade, #eaf2fa)" />
        </linearGradient>
      </defs>
      <path d={outline} transform="translate(0 3)" fill="#c4d7e9" />
      <path d={outline} fill={`url(#${gradientId})`} stroke="#fff" strokeWidth="1.2" />
    </svg>
  );
}

/** The original ribbon artwork, given depth with layered planes and perspective. */
export function BrandScene() {
  const ref = useRef<HTMLDivElement>(null);
  const still = useHomeMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end start"] });
  const lift = useTransform(scrollYProgress, [0, 1], [0, -85]);
  const turn = useTransform(scrollYProgress, [0, 1], [-12, 12]);
  const rotateX = useSpring(0, { stiffness: 100, damping: 25 });
  const rotateY = useSpring(0, { stiffness: 100, damping: 25 });

  function tilt(event: PointerEvent<HTMLDivElement>) {
    if (still || event.pointerType !== "mouse") return;
    const bounds = event.currentTarget.getBoundingClientRect();
    rotateX.set((0.5 - (event.clientY - bounds.top) / bounds.height) * 14);
    rotateY.set(((event.clientX - bounds.left) / bounds.width - 0.5) * 20);
  }

  return (
    <div ref={ref} className="brand-scene" onPointerMove={tilt} onPointerLeave={() => { rotateX.set(0); rotateY.set(0); }} aria-hidden="true">
      <div className="brand-badges">
        <div className="brand-badge brand-badge-income">
          <BadgeSurface />
          <Image className="brand-badge-icon" src="/brand/badges/income.png" alt="" width={42} height={42} draggable={false} />
          <span>Income &amp; reliefs</span>
        </div>
        <div className="brand-badge brand-badge-source">
          <BadgeSurface />
          <Image className="brand-badge-icon" src="/brand/badges/source.png" alt="" width={42} height={42} draggable={false} />
          <span>Sources cited</span>
        </div>
        <div className="brand-badge brand-badge-tax">
          <BadgeSurface />
          <Image className="brand-badge-icon" src="/brand/badges/calculator.png" alt="" width={42} height={42} draggable={false} />
          <span>Tax calculated</span>
        </div>
      </div>
      <motion.div aria-hidden="true" className="brand-assembly" style={{ y: still ? 0 : lift, rotateX: still ? 0 : rotateX, rotateY: still ? 0 : rotateY }}>
        <motion.div className="brand-ribbon" style={{ rotateZ: still ? -12 : turn }}>
          {[0, 1, 2, 3, 4].map((layer) => (
            <div key={layer} className={`brand-ribbon-layer ${layer === 4 ? "brand-ribbon-front" : ""}`} style={{ transform: `translateZ(${layer * 5}px)` }}>
              <Image src="/brand/logo-mark.png" alt="" width={430} height={430} priority={layer === 4} draggable={false} />
            </div>
          ))}
        </motion.div>
      </motion.div>
      <div className="brand-floor-shadow" aria-hidden="true" />
    </div>
  );
}
