import Link from 'next/link';

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 p-8">
      <h1 className="text-3xl font-semibold">Firebird Kitchen</h1>
      <p className="text-neutral-700">Table reservations.</p>
      <p className="flex flex-wrap gap-3">
        <Link href="/book" className="inline-flex min-h-12 items-center rounded-lg bg-neutral-900 px-6 font-semibold text-white">
          Book a table
        </Link>
        <Link href="/host" className="inline-flex min-h-12 items-center rounded-lg border-2 border-neutral-800 px-6 font-semibold">
          Host floor view
        </Link>
      </p>
    </main>
  );
}
