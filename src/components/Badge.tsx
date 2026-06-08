/** A small pill badge. Server-component safe (no client hooks). */
import type { ReactNode } from "react";

export function Badge({
  className = "bg-gray-100 text-gray-700 ring-gray-300",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${className}`}
    >
      {children}
    </span>
  );
}
