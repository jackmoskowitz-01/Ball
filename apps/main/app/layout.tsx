export const metadata = { title: 'AUTOCODE Live' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#0d1117', color: '#e6edf3', font: '13px -apple-system, sans-serif' }}>
        {children}
      </body>
    </html>
  );
}
