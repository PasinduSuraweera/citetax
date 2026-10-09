"use client";

/**
 * Loads the 3D mark in the browser only (three.js has no server render) and
 * shows the flat mark until it is ready, so the hero never sits empty.
 */

import dynamic from "next/dynamic";
import Image from "next/image";

function Flat() {
  return (
    <div className="flex aspect-square w-full items-center justify-center">
      <Image src="/brand/logo-mark.png" alt="" width={360} height={360} priority className="w-[62%] select-none" />
    </div>
  );
}

const HeroLogo3D = dynamic(() => import("./HeroLogo3D"), { ssr: false, loading: Flat });

export function HeroLogo() {
  return <HeroLogo3D />;
}
