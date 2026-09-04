import { useCallback, useEffect, useState } from "react";

const KEY = "kel.preview";
const EVENT = "kel:preview";

/**
 * Preview mode: watching as the parent.
 *
 * Sticky rather than per-playback, because the case it exists for is checking a batch of new
 * uploads in one sitting — a toggle that reset itself would be tapped nineteen times and
 * forgotten once. That is also why the player shows a loud amber bar whenever it is on: left on
 * by accident, this silently throws away every Watch, which is the one failure mode that would
 * make the app quietly useless.
 */
export function usePreviewMode(): [boolean, (on: boolean) => void] {
  const [preview, setPreview] = useState(() => localStorage.getItem(KEY) === "1");

  useEffect(() => {
    // Two screens can show the toggle at once; a plain custom event keeps them in step without
    // dragging in a store for one boolean.
    const onChange = () => setPreview(localStorage.getItem(KEY) === "1");
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, []);

  const set = useCallback((on: boolean) => {
    localStorage.setItem(KEY, on ? "1" : "0");
    window.dispatchEvent(new Event(EVENT));
  }, []);

  return [preview, set];
}
