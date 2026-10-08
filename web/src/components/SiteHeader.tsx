import { cookies } from "next/headers";
import Link from "next/link";
import { Logo } from "@/components/Logo";
import { isKnownVisitor } from "@/lib/guest";

/** The header of the public pages: the home page and pricing. Someone signed
 *  in, or who has carried on as a guest, gets "Open chat" in place of
 *  "Sign in". */
export async function SiteHeader() {
  const known = isKnownVisitor((await cookies()).getAll().map((c) => c.name));
  return (
    <header className="mx-auto flex max-w-[1180px] items-center justify-between px-5 py-5 sm:px-8">
      <Link href="/" aria-label="Citetax home">
        <Logo height={36} priority />
      </Link>
      <nav className="flex items-center gap-1 text-[14px] sm:gap-2">
        <Link href="/pricing" className="rounded-md px-3 py-2 text-ink-500 hover:text-ink-900">
          Pricing
        </Link>
        <Link href="/deadlines" className="hidden rounded-md px-3 py-2 text-ink-500 hover:text-ink-900 sm:block">
          Deadlines
        </Link>
        <Link href="/compare" className="hidden rounded-md px-3 py-2 text-ink-500 hover:text-ink-900 sm:block">
          What changed
        </Link>
        {known ? (
          <Link
            href="/chat"
            className="ml-1 inline-flex h-9 items-center rounded-lg bg-primary px-4 font-medium text-primary-foreground transition-colors hover:bg-primary/80"
          >
            Open chat
          </Link>
        ) : (
          <Link href="/signin" className="rounded-md px-3 py-2 font-medium text-ink-900 hover:bg-muted">
            Sign in
          </Link>
        )}
      </nav>
    </header>
  );
}
