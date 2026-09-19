import Link from 'next/link';

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 p-8">
      <h1 className="text-3xl font-semibold">Countertop Reserve</h1>
      <p className="text-neutral-700">Table reservations for Firebird Kitchen. The guest booking flow lands in V-012.</p>
      <p>
        <Link href="/host" className="inline-flex min-h-12 items-center rounded-lg bg-neutral-900 px-6 font-semibold text-white">
          Host floor view
        </Link>
      </p>
    </main>
  );
}
