import Link from "next/link";

export default function InvoiceNotFound() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-16 text-center">
      <h1 className="text-xl font-semibold text-gray-900">Invoice not found</h1>
      <p className="mt-2 text-sm text-gray-500">
        It may have been removed, or the link is stale.
      </p>
      <Link href="/" className="mt-4 inline-block text-sm text-sky-700 hover:underline">
        ← Back to the queue
      </Link>
    </main>
  );
}
