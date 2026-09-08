// Single source of truth for membership categories.
// Mirrors the table: Adult Founding / Family Member 16-26 / Child 10-15.
// If rates or brackets change, update here.

export const CATEGORIES = {
  adult: {
    label: 'Adult Founding',
    minAge: 27,
    maxAge: 200,
    stripePriceEnv: 'STRIPE_PRICE_ADULT',
    signwellTemplateEnv: 'SIGNWELL_TEMPLATE_ADULT',
  },
  family: {
    label: 'Family Member 16–26',
    minAge: 16,
    maxAge: 26,
    stripePriceEnv: 'STRIPE_PRICE_FAMILY',
    signwellTemplateEnv: 'SIGNWELL_TEMPLATE_FAMILY',
  },
  child: {
    label: 'Child 10–15',
    minAge: 10,
    maxAge: 15,
    stripePriceEnv: 'STRIPE_PRICE_CHILD',
    signwellTemplateEnv: 'SIGNWELL_TEMPLATE_CHILD',
  },
};

export function ageFromDOB(dobStr) {
  const dob = new Date(dobStr);
  if (isNaN(dob.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
  return age;
}

export function categoryForAge(age) {
  if (age === null || Number.isNaN(age)) return null;
  const entry = Object.entries(CATEGORIES).find(
    ([, c]) => age >= c.minAge && age <= c.maxAge
  );
  return entry ? entry[0] : null;
}

// Re-validates each submitted member server-side. NEVER trust the
// category/price the browser sent — recompute from DOB every time.
export function validateAndPriceMembers(members) {
  if (!Array.isArray(members) || members.length === 0) {
    throw new Error('At least one household member is required.');
  }

  const primaryCount = members.filter((m) => m.isPrimary).length;
  if (primaryCount !== 1) {
    throw new Error('Exactly one primary adult is required.');
  }

  return members.map((m) => {
    if (!m.name || !m.dob) {
      throw new Error('Each member needs a name and date of birth.');
    }
    const age = ageFromDOB(m.dob);
    const categoryKey = categoryForAge(age);
    if (!categoryKey) {
      throw new Error(
        `"${m.name}" (age ${age ?? 'unknown'}) doesn't fall into a current membership bracket. Please contact the office.`
      );
    }
    if (m.isPrimary && categoryKey !== 'adult') {
      throw new Error('The primary applicant must qualify for the Adult Founding membership.');
    }
    if (!m.isPrimary && m.email === '' && categoryKey !== 'child') {
      throw new Error(`"${m.name}" needs an email address to receive their agreement.`);
    }
    return {
      ...m,
      age,
      category: categoryKey,
      categoryLabel: CATEGORIES[categoryKey].label,
    };
  });
}
