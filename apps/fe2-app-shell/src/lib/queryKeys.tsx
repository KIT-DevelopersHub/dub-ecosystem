// queryKey convention (design 2-3). Every FE3-FE7 key MUST start with its
// FeatureModule id via feature(); shell keys are reserved here.
export const queryKeys = {
  me: ["me"] as const,
  bffHome: ["bff", "home"] as const,
  conferenceEvents: ["shell", "conference-events"] as const,
  /** Every event the viewer can read (名前の表示・「どのイベントに入れるか」の選択肢)。 */
  eventCatalog: ["shell", "event-catalog"] as const,
  feature: (featureId: string, ...parts: readonly unknown[]) => [featureId, ...parts] as const,
};
