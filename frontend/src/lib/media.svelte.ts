/** Reactive breakpoint (matches Tailwind `lg`), for components whose markup differs by device. */
const query = typeof matchMedia === "function" ? matchMedia("(min-width: 1024px)") : null;
let desktop = $state(query?.matches ?? true);
query?.addEventListener("change", e => (desktop = e.matches));

export const viewport = {
  get desktop() {
    return desktop;
  },
};
