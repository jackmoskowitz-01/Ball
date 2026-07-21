import './globals.css';
import Link from 'next/link';

export const metadata = { title: 'AUTOCODE Label Studio' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="topnav">
          <Link href="/" className="brand">AUTOCODE · Label Studio</Link>
          <Link href="/">Videos</Link>
          <Link href="/queue">Queue</Link>
          <a href="http://localhost:3002/live" target="_blank">Live ↗</a>
        </nav>
        {children}
      </body>
    </html>
  );
}
