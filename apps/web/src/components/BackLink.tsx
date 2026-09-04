import { Link } from "react-router-dom";

/**
 * The back chevron in a page header.
 *
 * An SVG rather than the `‹` character it replaces. That glyph's ink sits in the top half of its
 * line box, so `items-center` on the header centres the box and leaves the arrow riding above the
 * title next to it — there is no font-agnostic way to nudge it back. A path drawn centred in its
 * own viewBox lines up wherever it is dropped, and gets a full 44px tap target for free.
 */
export function BackLink({ to, label = "返回" }: { to: string; label?: string }) {
  return (
    <Link
      to={to}
      aria-label={label}
      // -ml-2.5 pulls the box's padding back out so the arrow itself starts at the page margin,
      // in line with the text below it, rather than 10px inside it.
      className="min-h-tap -ml-2.5 flex w-11 shrink-0 items-center justify-center text-faint"
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="h-6 w-6"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M14.5 5.5 8 12l6.5 6.5" />
      </svg>
    </Link>
  );
}
