let open = $state(false);
/** Global ⌘K palette visibility; any component can open it. */
export const searchPalette = {
  get open() {
    return open;
  },
  set open(v: boolean) {
    open = v;
  },
};
