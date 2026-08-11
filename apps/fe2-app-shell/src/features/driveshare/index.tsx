// DriveShare feature — public surface for the shell composition (featureModules.tsx).
export {
  createDriveShareApi,
  isValidEmail,
  roleLabel,
} from "./driveShareApi.tsx";
export type {
  DriveShareApi,
  DriveFile,
  SharePermission,
  ShareRole,
  AssignableRole,
  GranteeType,
  ListFilesResult,
  ListPermissionsResult,
  ListFilesQuery,
} from "./driveShareApi.tsx";
export { DriveShareProvider, DriveShareApiProvider, useDriveShareApi } from "./DriveShareProvider.tsx";
export { DriveShareScreen } from "./DriveShareScreen.tsx";
export { driveShareRoutes, driveShareNav } from "./module.tsx";
export type { DriveShareSourceRoute, DriveShareNavEntry } from "./module.tsx";
