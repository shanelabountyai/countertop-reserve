import Link from 'next/link';

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-5 bg-surface p-10 text-lg text-stone-900">
      <p className="text-xs font-bold tracking-[0.18em] text-stone-600 uppercase">Firebird · Reserve</p>
      <h1 className="font-display text-5xl leading-tight font-bold">Firebird Kitchen</h1>
      <p className="text-stone-600">Table reservations, confirmed and changed by text.</p>
      <p className="flex flex-wrap gap-3">
        <Link href="/book" className="inline-flex min-h-14 items-center bg-red-700 px-7 font-extrabold text-white">
          Book a table
        </Link>
        <Link href="/host" className="inline-flex min-h-14 items-center border-2 border-stone-900 bg-white px-7 font-bold">
          Host floor view
        </Link>
      </p>
    </main>
  );
}
