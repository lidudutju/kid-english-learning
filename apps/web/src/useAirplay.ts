import { useEffect, useState } from "react";

/** Safari's AirPlay surface on a media element; none of it is in lib.dom. */
interface WirelessVideo extends HTMLVideoElement {
  webkitCurrentPlaybackTargetIsWireless?: boolean;
}

const CHANGED = "webkitcurrentplaybacktargetiswirelesschanged";

/**
 * True while this element is playing to an AirPlay target instead of the screen in front of you.
 *
 * The player uses it to turn looping on: on the TV the phone is out of reach — usually face down
 * on a shelf — so "it stopped" means someone has to go find it, and the one thing a toddler
 * reliably wants after a song is the same song. Locally the phone is in a hand and the tap is
 * free, so playback still stops at the end there.
 *
 * There is no standard for this. `remotePlayback` would be the portable answer, but Safari on iOS
 * only tells the truth through the webkit property, and Safari is the only browser that reaches
 * an Apple TV — so anywhere else this stays false and nothing changes.
 */
export function useAirplay(player: HTMLVideoElement | null): boolean {
  const [wireless, setWireless] = useState(false);

  useEffect(() => {
    if (!player) {
      setWireless(false);
      return;
    }
    const el = player as WirelessVideo;

    // Read once as well as subscribe: picking a target in the previous Video's controls and then
    // opening this one means the change already happened before this element existed.
    const sync = () => setWireless(el.webkitCurrentPlaybackTargetIsWireless === true);
    sync();

    el.addEventListener(CHANGED, sync);
    return () => el.removeEventListener(CHANGED, sync);
  }, [player]);

  return wireless;
}
