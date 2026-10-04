// Career directions the user can choose (flexible career search). Each
// category is a plain-language label plus the job-site search terms it stands
// for, so people never need to know the search terms themselves. Framework
// free: used by the server (search plan, validation) and the browser (UI).
//
// The software categories reproduce the previous fixed search exactly:
// Software Engineering + Android + Java + Frontend + Full Stack = the six
// DEFAULT_SEARCH_TERMS.

export type RoleCategory = {
  id: string;
  label: string;
  group: string;
  /** What is sent to the job sites. */
  terms: string[];
};

export const ROLE_CATEGORIES: readonly RoleCategory[] = [
  { id: "software_engineering", label: "Software Engineering", group: "Technology", terms: ["junior software engineer", "graduate software developer"] },
  { id: "graduate_software", label: "Graduate Software Engineering", group: "Technology", terms: ["graduate software engineer"] },
  { id: "android", label: "Android Development", group: "Technology", terms: ["android developer"] },
  { id: "java", label: "Java Development", group: "Technology", terms: ["java developer"] },
  { id: "frontend", label: "Frontend Development", group: "Technology", terms: ["frontend developer"] },
  { id: "backend", label: "Backend Development", group: "Technology", terms: ["backend developer"] },
  { id: "full_stack", label: "Full Stack Development", group: "Technology", terms: ["full stack developer"] },
  { id: "driving", label: "Driving", group: "Driving & delivery", terms: ["driver"] },
  { id: "delivery_driving", label: "Delivery Driving", group: "Driving & delivery", terms: ["delivery driver"] },
  { id: "territory_management", label: "Territory Management", group: "Sales & field roles", terms: ["territory manager"] },
  { id: "area_management", label: "Area Management", group: "Sales & field roles", terms: ["area manager"] },
  { id: "field_sales", label: "Field Sales", group: "Sales & field roles", terms: ["field sales"] },
  { id: "sales", label: "Sales", group: "Sales & field roles", terms: ["sales executive"] },
  { id: "account_management", label: "Account Management", group: "Sales & field roles", terms: ["account manager"] },
  { id: "field_service", label: "Field Service", group: "Technical & operations", terms: ["field service engineer"] },
  { id: "technical_operations", label: "Technical Operations", group: "Technical & operations", terms: ["technical operator"] },
  { id: "construction_technical", label: "Construction / Technical", group: "Technical & operations", terms: ["construction technician"] },
  { id: "customer_facing", label: "Customer-facing roles", group: "Customer service", terms: ["customer service advisor"] },
];

const BY_ID = new Map(ROLE_CATEGORIES.map((c) => [c.id, c]));

export function roleCategory(id: string): RoleCategory | null {
  return BY_ID.get(id) ?? null;
}

/** The categories in display order, grouped. */
export function roleGroups(): { group: string; categories: RoleCategory[] }[] {
  const groups: { group: string; categories: RoleCategory[] }[] = [];
  for (const category of ROLE_CATEGORIES) {
    const existing = groups.find((g) => g.group === category.group);
    if (existing) existing.categories.push(category);
    else groups.push({ group: category.group, categories: [category] });
  }
  return groups;
}

/** The search terms for chosen categories, in order, without duplicates (ignoring case). */
export function termsForRoles(ids: string[]): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const id of ids) {
    for (const term of roleCategory(id)?.terms ?? []) {
      if (seen.has(term.toLowerCase())) continue;
      seen.add(term.toLowerCase());
      terms.push(term);
    }
  }
  return terms;
}

export function labelsForRoles(ids: string[]): string[] {
  return ids.map((id) => roleCategory(id)?.label).filter((label): label is string => Boolean(label));
}
