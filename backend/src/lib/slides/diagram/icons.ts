/**
 * Concept icons drawn with SVG primitives in a `size`-px square (top-left at x, y): line icons in the node's ink
 * colour with a soft accent fill, in the spirit of figures in speech / ML papers.
 */
import type { IconName } from "./spec.js";
import { r } from "./fonts.js";

export function icon(name: IconName, x: number, y: number, size: number, ink: string, accent: string): string {
  const k = size / 40;
  const T = (inner: string, sw = 2.2) => `<g transform="translate(${r(x)} ${r(y)}) scale(${+k.toFixed(4)})" fill="none" stroke="${ink}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${inner}</g>`;
  switch (name) {
    case "waveform": {
      const hs = [6, 14, 22, 30, 18, 26, 12, 20, 8, 16, 6];
      return T(hs.map((h, i) => `<line x1="${2 + i * 3.6}" y1="${20 - h / 2}" x2="${2 + i * 3.6}" y2="${20 + h / 2}"/>`).join(""), 2.4);
    }
    case "spectrogram": {
      const cells: string[] = [];
      const v = [[0.2, 0.5, 0.9, 0.6, 0.3, 0.2], [0.4, 0.8, 0.6, 0.9, 0.5, 0.3], [0.7, 0.5, 0.3, 0.6, 0.9, 0.6], [0.9, 0.3, 0.2, 0.4, 0.7, 0.9]];
      v.forEach((row, i) => row.forEach((o, j) => cells.push(`<rect x="${2 + j * 6.2}" y="${5 + i * 7.6}" width="5.6" height="7" rx="1" fill="${accent}" fill-opacity="${o}" stroke="none"/>`)));
      return T(`${cells.join("")}<rect x="1" y="4" width="38" height="32" rx="3" stroke-width="1.6"/>`);
    }
    case "transformer":
      return T(`<rect x="6" y="3" width="28" height="34" rx="5" fill="${accent}" fill-opacity="0.25"/><rect x="11" y="9" width="18" height="7" rx="2" fill="#fff"/><rect x="11" y="24" width="18" height="7" rx="2" fill="#fff"/><line x1="20" y1="16" x2="20" y2="24"/>`);
    case "attention": {
      const cells: string[] = [];
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) cells.push(`<rect x="${4 + j * 8.2}" y="${4 + i * 8.2}" width="7.2" height="7.2" rx="1.4" fill="${accent}" fill-opacity="${i === j ? 0.95 : Math.abs(i - j) === 1 ? 0.45 : 0.12}" stroke="none"/>`);
      return T(cells.join(""));
    }
    case "embedding":
      return T([0.9, 0.35, 0.7, 0.2, 0.55].map((o, i) => `<rect x="13" y="${2 + i * 7.3}" width="14" height="6.6" rx="1.5" fill="${accent}" fill-opacity="${o}"/>`).join(""), 1.6);
    case "tokens":
      return T(`<rect x="1" y="13" width="11" height="14" rx="3" fill="${accent}" fill-opacity="0.3"/><rect x="14.5" y="13" width="11" height="14" rx="3" fill="${accent}" fill-opacity="0.6"/><rect x="28" y="13" width="11" height="14" rx="3" fill="${accent}" fill-opacity="0.3"/>`, 1.8);
    case "text":
      return T(`<path d="M9 3h16l7 7v27H9z" fill="${accent}" fill-opacity="0.15"/><path d="M25 3v7h7"/><line x1="14" y1="18" x2="27" y2="18"/><line x1="14" y1="24" x2="27" y2="24"/><line x1="14" y1="30" x2="22" y2="30"/>`, 2);
    case "database":
      return T(`<ellipse cx="20" cy="9" rx="13" ry="5" fill="${accent}" fill-opacity="0.3"/><path d="M7 9v22c0 2.8 5.8 5 13 5s13-2.2 13-5V9"/><path d="M7 20c0 2.8 5.8 5 13 5s13-2.2 13-5"/>`);
    case "probe":
      return T(`<circle cx="17" cy="17" r="10" fill="${accent}" fill-opacity="0.22"/><line x1="24.5" y1="24.5" x2="35" y2="35" stroke-width="3.2"/>`, 2.4);
    case "chart":
      return T(`<line x1="4" y1="36" x2="37" y2="36"/><rect x="8" y="20" width="6" height="16" fill="${accent}" fill-opacity="0.45"/><rect x="17" y="10" width="6" height="26" fill="${accent}" fill-opacity="0.9"/><rect x="26" y="16" width="6" height="20" fill="${accent}" fill-opacity="0.6"/>`, 1.8);
    case "layers":
      return T(`<path d="M20 4 37 12 20 20 3 12z" fill="${accent}" fill-opacity="0.45"/><path d="M3 19.5 20 27.5 37 19.5"/><path d="M3 27 20 35 37 27"/>`);
    case "mic":
      return T(`<rect x="14" y="3" width="12" height="21" rx="6" fill="${accent}" fill-opacity="0.3"/><path d="M8 18a12 12 0 0 0 24 0"/><line x1="20" y1="30" x2="20" y2="37"/><line x1="13" y1="37" x2="27" y2="37"/>`);
    case "loss":
      return T(`<circle cx="20" cy="20" r="16"/><circle cx="20" cy="20" r="10" fill="${accent}" fill-opacity="0.25"/><circle cx="20" cy="20" r="3.5" fill="${ink}"/>`);
    case "align":
      return T(`${[4, 14, 24, 32].map((x0) => `<rect x="${x0}" y="3" width="6" height="8" rx="1.5" fill="${accent}" fill-opacity="0.5"/>`).join("")}${[2, 10, 18, 26, 34].map((x0) => `<rect x="${x0}" y="29" width="5" height="8" rx="1.5"/>`).join("")}<path d="M7 11 4.5 29M17 11l-4.5 18M27 11l-6.5 18M35 11l-6.5 18M35 11l1.5 18" stroke-width="1.5"/>`, 1.8);
    case "cluster": {
      const groups: Array<[number, number, string, number]> = [[11, 12, accent, 1], [29, 12, ink, 0.55], [20, 29, accent, 0.5]];
      return T(groups.map(([gx, gy, c, o]) => `<circle cx="${gx}" cy="${gy}" r="8" stroke-dasharray="2.2 2.4" stroke-width="1.3"/>${[[-3, -2], [3, -1.5], [0, 3]].map(([dx, dy]) => `<circle cx="${gx + dx!}" cy="${gy + dy!}" r="2.3" fill="${c}" fill-opacity="${o}" stroke="none"/>`).join("")}`).join(""));
    }
    case "subspace":
      return T(`<path d="M6 34 34 34" /><path d="M6 34 6 6"/><path d="M6 34 26 14" stroke="${accent}" stroke-width="2.6"/><path d="M29 31l5 3-5 3M3 11l3-5 3 5M20 13.5l6.5.5-.5 6.5" /><rect x="6" y="28" width="6" height="6" stroke-width="1.4"/>`);
    case "speaker":
      return T(`<circle cx="20" cy="13" r="7.5" fill="${accent}" fill-opacity="0.3"/><path d="M6 37c1.5-8 7-12 14-12s12.5 4 14 12"/>`);
    case "gear":
      return T(`<circle cx="20" cy="20" r="6" fill="${accent}" fill-opacity="0.35"/><path d="M20 3v6M20 31v6M3 20h6M31 20h6M8 8l4.2 4.2M27.8 27.8 32 32M8 32l4.2-4.2M27.8 12.2 32 8"/><circle cx="20" cy="20" r="12"/>`);
    case "image":
      return T(`<rect x="3" y="6" width="34" height="28" rx="3"/><circle cx="13" cy="15" r="3.5" fill="${accent}" fill-opacity="0.5"/><path d="M5 31l10-10 7 7 5-5 9 9" fill="${accent}" fill-opacity="0.25"/>`);
    case "check":
      return T(`<circle cx="20" cy="20" r="16" fill="${accent}" fill-opacity="0.2"/><path d="M12 20.5l5.5 5.5L29 14" stroke-width="3"/>`);
  }
}

/** Small snowflake (frozen) / flame (trainable) marks for a node corner (`size` px square). */
export function snowflake(x: number, y: number, size: number, color: string): string {
  const k = size / 20;
  return `<g transform="translate(${r(x)} ${r(y)}) scale(${+k.toFixed(4)})" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round"><path d="M10 1.5v17M2.6 5.75l14.8 8.5M2.6 14.25l14.8-8.5"/><path d="M7.6 2.8 10 5.2l2.4-2.4M7.6 17.2 10 14.8l2.4 2.4"/></g>`;
}
export function flame(x: number, y: number, size: number, color: string): string {
  const k = size / 20;
  return `<g transform="translate(${r(x)} ${r(y)}) scale(${+k.toFixed(4)})"><path d="M10 1.5c1 4 5.5 6.2 5.5 11a5.5 5.5 0 0 1-11 0c0-2.6 1.4-4.2 2.6-5.4.2 1.8 1 2.9 2.2 3.4C8.6 7.6 9 4.4 10 1.5z" fill="${color}"/><path d="M10 11.5c1.6 1.3 2.4 2.4 2.4 3.6a2.4 2.4 0 0 1-4.8 0c0-1.2.9-2.3 2.4-3.6z" fill="#fff" fill-opacity="0.85"/></g>`;
}
