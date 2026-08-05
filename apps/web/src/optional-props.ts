// This workspace compiles with exactOptionalPropertyTypes, and the component
// library's optional props are declared without `| undefined` — so a prop
// that may be absent has to be omitted, not passed as undefined. These
// helpers build the omitting form once instead of forking every JSX call
// site into two branches.

export function countProp(count: number | undefined): { count?: number } {
  return count === undefined ? {} : { count };
}

export function subtitleProp(subtitle: string | undefined): {
  subtitle?: string;
} {
  return subtitle === undefined ? {} : { subtitle };
}
