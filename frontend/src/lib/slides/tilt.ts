/**
 * Air-mouse laser for the phone remote: while 「轉動指向」 is held, the pointer starts at the slide's centre and follows
 * the phone's turning (gyroscope, `devicemotion.rotationRate`), like a TV remote pointer. Turning is measured, not the
 * absolute direction, so it needs no compass and no calibration; letting go and holding again re-centres it.
 *
 * Left / right is the rotation around the room's vertical (the gravity direction measured in the phone's frame), so it
 * works the same with the phone held flat, tilted or upright; up / down is the rotation around the screen's horizontal
 * axis. Chrome on Android gives the readings on HTTPS without asking; iOS Safari asks once (requestPermission, in a tap).
 */
export type Vec = { x: number; y: number; z: number };

/** Degrees of turning that cross the whole slide. */
export const SPAN = { x: 36, y: 22 };
/** Turning slower than this (deg/s) is hand tremor / sensor noise. */
const DEADZONE = 1.2;

const norm = (v: Vec) => Math.hypot(v.x, v.y, v.z);

/**
 * One reading → pointer movement in slide fractions. `rate` is the rotation rate in deg/s around the device axes
 * (x right, y up the screen, z out of the screen; rotationRate.beta / gamma / alpha), `gravity` the acceleration
 * including gravity (points up), `angle` the screen orientation angle (0 / 90 / 180 / 270), `dt` in seconds.
 */
export function tiltStep(rate: Vec, gravity: Vec | null, angle: number, dt: number): { dx: number; dy: number } {
  if (!(dt > 0) || dt > 0.25) return { dx: 0, dy: 0 };
  const g = gravity && norm(gravity) > 3 ? gravity : { x: 0, y: 0, z: 1 };
  const gn = norm(g);
  // Yaw: rotation about the room's up axis (counter-clockwise from above = positive = pointer to the left).
  const yaw = (rate.x * g.x + rate.y * g.y + rate.z * g.z) / gn;
  // Pitch: rotation about the screen's right axis (top edge up = positive = pointer up).
  const a = (((angle % 360) + 360) % 360) * (Math.PI / 180);
  const pitch = rate.x * Math.cos(a) + rate.y * Math.sin(a);
  const dead = (v: number) => (Math.abs(v) < DEADZONE ? 0 : v);
  // `|| 0`: no movement is +0, not -0.
  return { dx: (-dead(yaw) * dt) / SPAN.x || 0, dy: (-dead(pitch) * dt) / SPAN.y || 0 };
}

type MotionCtor = { requestPermission?: () => Promise<"granted" | "denied"> };
type Motion = {
  rotationRate: { alpha: number | null; beta: number | null; gamma: number | null } | null;
  accelerationIncludingGravity: { x: number | null; y: number | null; z: number | null } | null;
  interval: number;
  timeStamp: number;
};

export const tiltSupported = () => typeof window !== "undefined" && "DeviceMotionEvent" in window && (window.isSecureContext ?? true);

/** iOS: ask for motion access (must run inside a tap). Elsewhere: granted. */
export async function tiltPermission(): Promise<boolean> {
  const C = (window as unknown as { DeviceMotionEvent?: MotionCtor }).DeviceMotionEvent;
  if (!C?.requestPermission) return true;
  try {
    return (await C.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

/**
 * Follows the phone's turning from the centre until stopped; `onMove` gets slide fractions (0–1), smoothed.
 * `onSilent` fires when no reading arrived within a second (no gyroscope, or access refused).
 */
export function startTilt(onMove: (p: { x: number; y: number }) => void, onSilent: () => void): () => void {
  let x = 0.5;
  let y = 0.5;
  let sx = x;
  let sy = y;
  let last = 0;
  let got = false;
  const angle = () => (screen.orientation?.angle ?? (window as { orientation?: number }).orientation ?? 0) as number;
  onMove({ x, y });
  const handler = (e: Event) => {
    const m = e as unknown as Motion;
    const r = m.rotationRate;
    if (!r || (r.alpha == null && r.beta == null && r.gamma == null)) return;
    got = true;
    const t = m.timeStamp / 1000;
    const dt = last ? t - last : (m.interval > 1 ? m.interval / 1000 : m.interval) || 0.016;
    last = t;
    const gi = m.accelerationIncludingGravity;
    const g = gi && gi.x != null && gi.y != null && gi.z != null ? { x: gi.x, y: gi.y, z: gi.z } : null;
    const d = tiltStep({ x: r.beta ?? 0, y: r.gamma ?? 0, z: r.alpha ?? 0 }, g, angle(), dt);
    x = Math.min(1, Math.max(0, x + d.dx));
    y = Math.min(1, Math.max(0, y + d.dy));
    // Light smoothing against jitter; still follows quick turns.
    sx += (x - sx) * 0.5;
    sy += (y - sy) * 0.5;
    onMove({ x: sx, y: sy });
  };
  window.addEventListener("devicemotion", handler);
  const silent = setTimeout(() => !got && onSilent(), 1000);
  return () => {
    clearTimeout(silent);
    window.removeEventListener("devicemotion", handler);
  };
}
