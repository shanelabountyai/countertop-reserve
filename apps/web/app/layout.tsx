import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Countertop Reserve',
  description: 'Table reservations for Firebird Kitchen.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
