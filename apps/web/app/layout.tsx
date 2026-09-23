import type { Metadata } from 'next';
import { Archivo, Zilla_Slab } from 'next/font/google';
import './globals.css';

// Archivo carries the UI, Zilla Slab the display line — the two faces the
// design canvas is drawn in, self-hosted by next/font so no stylesheet
// request stands between a host and the floor.
const archivo = Archivo({ subsets: ['latin'], variable: '--font-archivo', display: 'swap' });
const zilla = Zilla_Slab({ subsets: ['latin'], weight: ['500', '600', '700'], variable: '--font-zilla', display: 'swap' });

export const metadata: Metadata = {
  title: 'Countertop Reserve',
  description: 'Table reservations for Firebird Kitchen.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${zilla.variable}`}>
      <body className="bg-ground font-sans text-stone-900 antialiased">{children}</body>
    </html>
  );
}
