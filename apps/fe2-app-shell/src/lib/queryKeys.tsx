// queryKey convention (design 2-3). Every FE3-FE7 key MUST start with its
// FeatureModule id via feature(); shell keys are reserved here.
export const queryKeys = {
  me: ["me"] as const,
  bffHome: ["bff", "home"] as const,
  feature: (featureId: string, ...parts: readonly unknown[]) => [featureId, ...parts] as const,
};
