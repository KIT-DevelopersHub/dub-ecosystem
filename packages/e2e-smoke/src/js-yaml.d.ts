// js-yaml ships no types and @types/js-yaml is not in the workspace; only `load` is used.
declare module "js-yaml" {
  export function load(src: string): unknown;
}
