// Composition · public surface (W7a).
//
// Assembles FE3–FE7 into the shell FeatureModule array, each module's routes
// wrapped in its runtime Provider fed by the local ResourceClient
// (src/lib/api-client.tsx). Import point for main.tsx:
//
//   import { assembleFeatureModules } from "./composition";
//   const registry = registerFeatureModules(assembleFeatureModules(api));
//
// Nothing imports this yet — W7a is self-contained and independently mergeable.
export { assembleFeatureModules } from "./featureModules.tsx";
export {
  EventProviders,
  TaskProviders,
  NotificationProviders,
  ChatProviders,
  RosterProviders,
} from "./moduleProviders.tsx";
export {
  createEventApi,
  createNotificationClient,
  createRosterClient,
  createTaskApiClient,
  createChatApiClient,
  createGatewayResourceClient,
  createPrefixedHttpClient,
} from "./appClients.tsx";
