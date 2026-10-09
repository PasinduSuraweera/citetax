import Link from "next/link";
import { Logo } from "@/components/Logo";

export function HomeFooter({ snapshotLabel, known }: { snapshotLabel?: string; known: boolean }) {
  const year = new Intl.DateTimeFormat("en", { year: "numeric", timeZone: "Asia/Colombo" }).format(new Date());

  return (
    <footer className="home-footer">
      <div className="home-shell">
        <div className="home-footer-main">
          <Link className="home-footer-brand" href="#home-top" aria-label="Citetax, back to top"><Logo height={68} /></Link>
          <nav className="home-footer-nav" aria-label="Footer">
            <ul>
              <li><Link href="/pricing">Pricing</Link></li>
              <li><Link href="/deadlines">Deadlines</Link></li>
              <li><Link href="/compare">What changed</Link></li>
              <li><Link href={known ? "/history" : "/signin"}>{known ? "Your conversations" : "Sign in"}</Link></li>
            </ul>
          </nav>
        </div>
        <div className="home-footer-details">
          <p>Personal income tax for 2025/2026 and 2026/2027.<br />
            {snapshotLabel ? `Rules as of ${snapshotLabel}. ` : ""}Not tax advice.
          </p>
          <a href="#home-top">Back to top</a>
        </div>
        <div className="home-footer-bottom">
          <p>© {year} Citetax</p>
        </div>
      </div>
    </footer>
  );
}
