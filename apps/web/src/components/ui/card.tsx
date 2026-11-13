import type { HTMLAttributes } from "react";

import { cx } from "./cx";

type SurfaceProps = HTMLAttributes<HTMLDivElement>;

export function Card({ className, ...props }: SurfaceProps) {
  return (
    <section
      {...props}
      className={cx("rounded-2xl border border-border bg-white shadow-sm", className)}
    />
  );
}

export function CardHeader({ className, ...props }: SurfaceProps) {
  return (
    <div
      {...props}
      className={cx("flex flex-col gap-1.5 border-b border-border px-5 py-4 sm:px-6", className)}
    />
  );
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      {...props}
      className={cx("text-base font-semibold tracking-tight text-slate-950", className)}
    />
  );
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      {...props}
      className={cx("text-sm leading-6 text-slate-600", className)}
    />
  );
}

export function CardContent({ className, ...props }: SurfaceProps) {
  return <div {...props} className={cx("px-5 py-5 sm:px-6", className)} />;
}

export function CardFooter({ className, ...props }: SurfaceProps) {
  return (
    <div
      {...props}
      className={cx("flex flex-wrap items-center gap-3 border-t border-border px-5 py-4 sm:px-6", className)}
    />
  );
}
