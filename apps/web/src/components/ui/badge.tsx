import type { HTMLAttributes } from "react";

import { cx } from "./cx.mjs";

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger" | "outline";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

const tones: Record<BadgeTone, string> = {
  neutral: "border-slate-200 bg-slate-100 text-slate-700",
  info: "border-blue-200 bg-blue-50 text-blue-800",
  success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
  danger: "border-rose-200 bg-rose-50 text-rose-800",
  outline: "border-slate-300 bg-white text-slate-700",
};

export function Badge({ tone = "neutral", className, ...props }: BadgeProps) {
  return (
    <span
      {...props}
      className={cx(
        "inline-flex min-h-6 items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold leading-4",
        tones[tone],
        className,
      )}
    />
  );
}

const statusTones: Record<string, BadgeTone> = {
  ACTIVE: "success",
  ENABLED: "success",
  COMPLETED: "success",
  SUCCEEDED: "success",
  ACCEPTED: "success",
  APPROVED: "success",
  MATCHED: "success",
  PENDING: "warning",
  OPEN: "warning",
  PAUSED: "warning",
  RESTRICTED: "warning",
  BLOCKED: "warning",
  QUARANTINED: "warning",
  FAILED: "danger",
  REJECTED: "danger",
  CANCELLED: "danger",
  DAMAGED: "danger",
  INACTIVE: "neutral",
  DRAFT: "neutral",
  UNKNOWN: "neutral",
};

export function StatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const normalized = status.trim().toUpperCase();
  const tone = statusTones[normalized] ?? "neutral";

  return (
    <Badge tone={tone} className={className}>
      {normalized ? normalized.replaceAll("_", " ") : "UNKNOWN"}
    </Badge>
  );
}
