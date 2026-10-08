// Module state: resets on every full page load, survives in-app navigation.
let played = false;

/**
 * The logo intro plays each time the app is opened (a full page load),
 * but not when the user comes back to sign-in inside the app, e.g. after
 * signing out. Never with reduced motion.
 */
export function introOwed() {
  if (played) return false;
  try {
    return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return true;
  }
}

export function markIntroSeen() {
  played = true;
}
