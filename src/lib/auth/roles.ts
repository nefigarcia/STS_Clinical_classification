import type { Role } from "@prisma/client";

export const ROLE_RANK: Record<Role, number> = { READ_ONLY: 0, REVIEWER: 1, ADMIN: 2 };

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: "Administrator",
  REVIEWER: "Clinical Reviewer",
  READ_ONLY: "Read-Only User",
};

export function hasRole(actual: Role, required: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

/** Map Entra app-role claim values to the highest matching application role. */
export function mapEntraRoles(claims: unknown, mapJson: string | undefined): Role | null {
  if (!Array.isArray(claims) || claims.length === 0) return null;
  let map: Record<string, Role> = {
    "STS.Admin": "ADMIN",
    "STS.Reviewer": "REVIEWER",
    "STS.ReadOnly": "READ_ONLY",
  };
  if (mapJson) {
    try {
      map = JSON.parse(mapJson);
    } catch {
      /* fall back to defaults */
    }
  }
  let best: Role | null = null;
  for (const c of claims) {
    const r = map[String(c)];
    if (r && ROLE_RANK[r] !== undefined && (best === null || ROLE_RANK[r] > ROLE_RANK[best])) best = r;
  }
  return best;
}
