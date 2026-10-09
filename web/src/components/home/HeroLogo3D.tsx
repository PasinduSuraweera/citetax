"use client";

/**
 * The Citetax mark as a solid object for the home page hero.
 *
 * The outline is traced from the mark's own alpha channel (logo-outline.json,
 * in the image's 0..1 frame) and extruded with a bevel. The front face carries
 * the real artwork, fold shading and all, and the sides are a glossy blue. It
 * sways gently, leans toward the pointer and turns a little with the scroll.
 * Lighting is built in the scene, so nothing is fetched at runtime. With
 * reduced motion it is drawn once and held still.
 */

import { Canvas, useFrame } from "@react-three/fiber";
import { Environment, Float, Lightformer, useTexture } from "@react-three/drei";
import { Suspense, useMemo, useRef, useSyncExternalStore } from "react";
import * as THREE from "three";
import outline from "./logo-outline.json";

const QUERY = "(prefers-reduced-motion: reduce)";
function subscribe(cb: () => void) {
  const m = window.matchMedia(QUERY);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}
function useStill(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches, () => true);
}

function Mark({ still }: { still: boolean }) {
  const ref = useRef<THREE.Mesh>(null);
  // Set up where the texture is created, not after the hook returns it.
  const texture = useTexture("/brand/logo-mark-3d.png", (t) => {
    const tex = Array.isArray(t) ? t[0] : t;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
  });

  const geometry = useMemo(() => {
    const shape = new THREE.Shape(outline.points.map(([x, y]) => new THREE.Vector2(x, y)));
    const g = new THREE.ExtrudeGeometry(shape, {
      depth: 0.16,
      bevelEnabled: true,
      bevelThickness: 0.035,
      bevelSize: 0.012,
      bevelSegments: 8,
      curveSegments: 6,
    });
    // Centre the solid; the caps keep their UVs, which are the image frame.
    g.center();
    return g;
  }, []);

  const materials = useMemo(
    () => [
      new THREE.MeshPhysicalMaterial({
        map: texture,
        roughness: 0.28,
        metalness: 0.05,
        clearcoat: 1,
        clearcoatRoughness: 0.12,
      }),
      new THREE.MeshPhysicalMaterial({
        color: "#0766d6",
        roughness: 0.22,
        metalness: 0.35,
        clearcoat: 1,
        clearcoatRoughness: 0.1,
      }),
    ],
    [texture],
  );

  useFrame((state) => {
    const m = ref.current;
    if (!m || still) return;
    const t = state.clock.elapsedTime;
    const scroll = typeof window === "undefined" ? 0 : window.scrollY;
    const ty = Math.sin(t * 0.45) * 0.28 + state.pointer.x * 0.35 + scroll * 0.0012;
    const tx = Math.cos(t * 0.35) * 0.08 - state.pointer.y * 0.22;
    m.rotation.y += (ty - m.rotation.y) * 0.06;
    m.rotation.x += (tx - m.rotation.x) * 0.06;
  });

  return <mesh ref={ref} geometry={geometry} material={materials} rotation={[-0.08, -0.32, 0]} scale={1.9} />;
}

export default function HeroLogo3D() {
  const still = useStill();
  return (
    <div className="relative aspect-square w-full" aria-hidden>
      <Canvas
        dpr={[1, 2]}
        camera={{ position: [0, 0, 4.2], fov: 32 }}
        gl={{ antialias: true, alpha: true }}
        frameloop={still ? "demand" : "always"}
      >
        <ambientLight intensity={0.35} />
        <directionalLight position={[3, 4, 5]} intensity={1.6} />
        <Suspense fallback={null}>
          <Float speed={still ? 0 : 1.4} rotationIntensity={still ? 0 : 0.25} floatIntensity={still ? 0 : 0.6}>
            <Mark still={still} />
          </Float>
          {/* Studio lighting built in the scene: no environment map is fetched. */}
          <Environment resolution={256} frames={1}>
            <Lightformer form="rect" intensity={2.4} position={[0, 3, 2]} scale={[6, 1.2, 1]} color="#ffffff" />
            <Lightformer form="rect" intensity={1.6} position={[-4, 0, 2]} rotation={[0, Math.PI / 2, 0]} scale={[4, 3, 1]} color="#bfe9ff" />
            <Lightformer form="rect" intensity={1.2} position={[4, -1, 1]} rotation={[0, -Math.PI / 2, 0]} scale={[4, 3, 1]} color="#22d3e0" />
            <Lightformer form="circle" intensity={0.8} position={[0, -3, 3]} scale={3} color="#0766d6" />
          </Environment>
        </Suspense>
      </Canvas>
    </div>
  );
}
