// Dependency-injection contexts for the EventApi and the ActionTypeRegistry, so
// screens/hooks/tests stay agnostic to whether the API is the mock or the real
// gateway client, and the registry can be seeded per-test.
import * as React from "react";
import type { EventApi } from "../api/eventApi";
import type { ActionTypeRegistry } from "../registry/ActionTypeRegistry";

const EventApiContext = React.createContext<EventApi | null>(null);
const RegistryContext = React.createContext<ActionTypeRegistry | null>(null);

export function EventApiProvider({ api, children }: { api: EventApi; children: React.ReactNode }) {
  return <EventApiContext.Provider value={api}>{children}</EventApiContext.Provider>;
}

export function useEventApi(): EventApi {
  const ctx = React.useContext(EventApiContext);
  if (!ctx) throw new Error("useEventApi must be used within EventApiProvider");
  return ctx;
}

export function RegistryProvider({
  registry,
  children,
}: {
  registry: ActionTypeRegistry;
  children: React.ReactNode;
}) {
  return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>;
}

export function useActionRegistry(): ActionTypeRegistry {
  const ctx = React.useContext(RegistryContext);
  if (!ctx) throw new Error("useActionRegistry must be used within RegistryProvider");
  return ctx;
}
