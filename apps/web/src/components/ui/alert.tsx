import type { HTMLAttributes } from "react";

import { cx } from "./cx.mjs";

export type AlertTone = "info" | "success" | "warning" | "danger";

export interface AlertProps extends HTMLAttributes<HTMLDivElement> {
  tone?: AlertTone;
  title?: string;
}

const tones: Record<AlertTone, string> = {
  info: "border-blue-200 bg-blue-50 text-blue-950",
  success: "border-emerald-200 bg-emerald-50 text-emerald-950",
  warning: "border-amber-200 bg-amber-50 text-amber-950",
  danger: "border-rose-200 bg-rose-50 text-rose-950",
};

export function Alert({
  tone = "info",
  title,
  className,
  children,
  ...props
}: AlertProps) {
  return (
    <div
      {...props}
      role={tone === "danger" ? "alert" : "status"}
      className={cx("rounded-xl border px-4 py-3 text-sm leading-6", tones[tone], className)}
    >
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={title ? "mt-1" : undefined}>{children}</div> : null}
    </div>
  );
}
