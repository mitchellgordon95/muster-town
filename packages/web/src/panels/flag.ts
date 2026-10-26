/**
 * Plant a flag is a key binding (Mitchell's flag dc_7qng5lccew), not an in-tray control: F opens the box anywhere on the
 * map. Its building picker lists every lab I may assign work in, the one I'm standing in first (the default).
 */
export function flagTargets<B extends { id: string; kind: string }>(buildings: B[], canAssign: (id: string) => boolean, standingIn?: string | null): B[] {
  const ok = buildings.filter((b) => b.kind !== "town-hall" && canAssign(b.id));
  const here = ok.find((b) => b.id === standingIn);
  return here ? [here, ...ok.filter((b) => b !== here)] : ok;
}
