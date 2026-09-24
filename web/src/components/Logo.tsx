/**
 * The Citetax logo, from the brand artwork in public/brand/.
 *
 *   Logo      mark and name, for the sidebar and page headers
 *   LogoFull  mark, name and "Sri Lanka personal income tax copilot"
 *   LogoMark  the mark alone; also the favicon (app/icon.png)
 *
 * Cut from public/brand/logo-source.png. The tagline is left off the small
 * lockup because it cannot be read at sidebar size.
 */

import Image from "next/image";

const LOCKUP_RATIO = 1356 / 441;
const FULL_RATIO = 1361 / 441;

/** "dark" is the version for navy backgrounds: white "Cite", brighter teal. */
type Tone = "light" | "dark";

export function Logo({
  height = 30, tone = "light", className = "", priority = false,
}: { height?: number; tone?: Tone; className?: string; priority?: boolean }) {
  return (
    <Image
      src={tone === "dark" ? "/brand/citetax-lockup-dark.png" : "/brand/citetax-lockup.png"}
      alt="Citetax"
      width={Math.round(height * LOCKUP_RATIO)}
      height={height}
      priority={priority}
      className={`h-auto select-none ${className}`}
    />
  );
}

export function LogoFull({
  height = 64, tone = "light", className = "", priority = false,
}: { height?: number; tone?: Tone; className?: string; priority?: boolean }) {
  return (
    <Image
      src={tone === "dark" ? "/brand/citetax-logo-dark.png" : "/brand/citetax-logo.png"}
      alt="Citetax, Sri Lanka personal income tax copilot"
      width={Math.round(height * FULL_RATIO)}
      height={height}
      priority={priority}
      className={`h-auto select-none ${className}`}
    />
  );
}

export function LogoMark({ size = 32, className = "" }: { size?: number; className?: string }) {
  return (
    <Image
      src="/brand/citetax-mark.png"
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className={`flex-none select-none ${className}`}
    />
  );
}
