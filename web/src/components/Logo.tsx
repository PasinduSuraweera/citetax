/**
 * The Citetax logo, from the brand artwork in public/brand/.
 *
 *   Logo      the ribbon C and the wordmark
 *   LogoMark  the ribbon C alone; also the favicon (app/icon.png)
 *
 * Cut from public/brand/source-lockup.png and source-mark.png. The "dark"
 * lockup is for the navy sidebar and panels: the navy "Cite" turned white,
 * the ribbon and the cyan "tax" unchanged. source-mono.png is the one colour
 * version, kept for print.
 */

import Image from "next/image";

const LOCKUP_RATIO = 1519 / 427;

type Tone = "light" | "dark";

export function Logo({
  height = 30, tone = "light", className = "", priority = false,
}: { height?: number; tone?: Tone; className?: string; priority?: boolean }) {
  return (
    <Image
      src={tone === "dark" ? "/brand/logo-lockup-dark.png" : "/brand/logo-lockup.png"}
      alt="Citetax"
      width={Math.round(height * LOCKUP_RATIO)}
      height={height}
      priority={priority}
      className={`h-auto select-none ${className}`}
    />
  );
}

export function LogoMark({ size = 32, className = "" }: { size?: number; className?: string }) {
  return (
    <Image
      src="/brand/logo-mark.png"
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className={`flex-none select-none ${className}`}
    />
  );
}
