// Calendar feature — public surface for the shell composition (featureModules.tsx).
export { calendarRoutes, calendarNav } from "./module.tsx";
export type { CalendarSourceRoute, CalendarNavEntry } from "./module.tsx";
export { CalendarProvider, CalendarApiProvider, useCalendarApi } from "./CalendarProvider.tsx";
export { createCalendarApi } from "./calendarApi.tsx";
export type { CalendarApi, CalendarTaskQuery } from "./calendarApi.tsx";
export { CalendarScreen } from "./CalendarScreen.tsx";
export {
  buildMonthGrid,
  buildWeekGrid,
  groupTasksByDay,
  type DayCell,
  type DayTask,
  type CalendarViewMode,
} from "./calendar-grid";
