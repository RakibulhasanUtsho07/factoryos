import type { HTMLAttributes } from "react";

import { cx } from "./cx.mjs";

export function Skeleton({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      aria-hidden="true"
      className={cx("animate-pulse rounded-lg bg-slate-200 motion-reduce:animate-none", className)}
    />
  );
}
