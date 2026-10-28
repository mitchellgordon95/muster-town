/** The collectives as the homepage embeds them (`<script type="application/json" id="collectives">`, server/src/home.ts). */
export interface HomeCollective {
  slug: string;
  name: string;
  /** shown under the name (a collective's goal is its tagline) */
  goal?: string;
  url?: string;
  placeholder?: boolean;
  /** this server's town snapshot (`/api/town`) for a live preview; absent for collectives served elsewhere */
  preview?: string;
}

export function readCollectives(): HomeCollective[] {
  try { return JSON.parse(document.getElementById("collectives")?.textContent ?? "[]") as HomeCollective[]; } catch { return []; }
}
